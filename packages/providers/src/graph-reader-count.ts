import type { MailRow } from "@passport/types";
import { type GraphScope, needsHeaders, planUrl } from "./graph-reader-rows.js";
import {
  type GraphCall,
  type ReaderMessage,
  ROW_SELECT,
  SEARCH_CEILING,
} from "./graph-reader-support.js";
import type { GraphQueryPlan } from "./query-render.js";

/** Pages (250 rows each) a count may scan before it reports `capped` (R1-7). */
export const MAX_COUNT_PAGES = 8;

interface CountPage {
  value?: ReaderMessage[];
  "@odata.nextLink"?: string;
  "@odata.count"?: number;
}

/** `@odata.count` of a `$filter` plan in one folder (or all mail), or null when Graph omits it. */
async function countFilter(
  call: GraphCall,
  plan: GraphQueryPlan,
  folderId: string | null,
): Promise<number | null> {
  const scope: GraphScope = { folderId, hidden: new Set(), empty: false };
  const page = await call.get<CountPage>(planUrl(plan, scope, { top: 1, select: "id" }), {
    ConsistencyLevel: "eventual",
  });
  return typeof page["@odata.count"] === "number" ? page["@odata.count"] : null;
}

/**
 * Pages ids 250 at a time, counting rows `keep` accepts, up to `ceiling` matches or
 * `MAX_COUNT_PAGES` pages, whichever comes first.
 */
async function pageCount(
  call: GraphCall,
  plan: GraphQueryPlan,
  scope: GraphScope,
  ceiling: number,
  keep: (message: ReaderMessage) => Promise<MailRow | null>,
): Promise<{ count: number; capped: boolean; scanned: number }> {
  const select = plan.clientFilter.length
    ? `${ROW_SELECT}${needsHeaders(plan.clientFilter) ? ",internetMessageHeaders" : ""}`
    : "id,parentFolderId";
  let link: string | undefined = planUrl(plan, scope, { top: 250, select, count: false });
  let count = 0;
  let scanned = 0;
  for (let pages = 0; link; pages++) {
    if (pages >= MAX_COUNT_PAGES) {
      return { count, capped: true, scanned };
    }
    const page: CountPage = await call.get<CountPage>(link);
    for (const message of page.value ?? []) {
      if (!(await keep(message))) {
        continue;
      }
      if (count >= ceiling) {
        return { count, capped: true, scanned };
      }
      count++;
    }
    scanned += page.value?.length ?? 0;
    const next: string | undefined = page["@odata.nextLink"];
    link = next ? call.transport.safeLink(next) : undefined;
  }
  return { count, capped: false, scanned };
}

/**
 * `MailReader.countIds`. A pure `$filter` plan uses `$count=true` (minus the Spam/Trash folders
 * when they are hidden: one extra request each). Otherwise ids are paged 250 at a time up to
 * `cap` (and the 1,000-result `$search` ceiling), applying `keep` to each row, for at most
 * `MAX_COUNT_PAGES` pages; `scanned` reports the rows read.
 */
export async function readCount(
  call: GraphCall,
  plan: GraphQueryPlan,
  scope: GraphScope,
  cap: number,
  keep: (message: ReaderMessage) => Promise<MailRow | null>,
): Promise<{ count: number; capped: boolean; scanned?: number }> {
  if (scope.empty) {
    return { count: 0, capped: false };
  }
  if (plan.strategy === "filter" && plan.clientFilter.length === 0) {
    const total = await countFilter(call, plan, scope.folderId);
    if (total !== null) {
      let count = total;
      for (const hidden of scope.hidden) {
        count -= (await countFilter(call, plan, hidden)) ?? 0;
      }
      count = Math.max(0, count);
      return { count: Math.min(count, cap), capped: count > cap };
    }
  }
  const search = plan.strategy !== "filter";
  const result = await pageCount(
    call,
    plan,
    scope,
    search ? Math.min(cap, SEARCH_CEILING) : cap,
    keep,
  );
  return {
    count: result.count,
    capped: result.capped || (search && result.scanned >= SEARCH_CEILING),
    scanned: result.scanned,
  };
}
