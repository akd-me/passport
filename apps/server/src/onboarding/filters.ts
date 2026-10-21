import type { ActionQuery, ActionRecord, Matter, MatterStatus } from "@passport/types";
import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError } from "../errors.js";
import { categories, integer, member, statuses } from "../validation.js";

/** Filter before paging; the frozen Store ActionQuery has no accountId field. */
export function registerAccountFilters(app: Hono, backend: Backend): void {
  for (const route of ["decisions", "actions"] as const) {
    app.get(`/api/${route}`, async (c, next) => {
      const accountId = c.req.query("accountId");
      if (!accountId) {
        return next();
      }
      const q = c.req.query();
      for (const key of ["after", "before"]) {
        if (q[key] && !Number.isFinite(Date.parse(q[key]!))) {
          throw new ApiError("INVALID_QUERY", "Expected an ISO timestamp");
        }
      }
      const query: ActionQuery = {
        status:
          route === "decisions"
            ? ["proposed", "held"]
            : q.status?.split(",").map((s) => member(s, statuses, "status")),
        category: q.category ? member(q.category, categories, "category") : undefined,
        actorKind: q.actorKind
          ? member(q.actorKind, ["human", "agent", "external-agent"], "actorKind")
          : undefined,
        runId: q.runId,
        matterId: q.matterId,
        after: q.after,
        before: q.before,
        limit: 500,
      };
      const items: ActionRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await backend.store.actions.query({ ...query, cursor });
        items.push(...page.items.filter((a) => a.request.accountId === accountId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const offset = q.cursor ? integer(Number(q.cursor), "cursor", 0, Number.MAX_SAFE_INTEGER) : 0;
      const limit = q.limit
        ? integer(Number(q.limit), "limit", 1, 500)
        : route === "decisions"
          ? 500
          : 50;
      return c.json({
        items: items.slice(offset, offset + limit),
        total: items.length,
        nextCursor: offset + limit < items.length ? String(offset + limit) : null,
      });
    });
  }
  app.get("/api/matters", async (c) => {
    const q = c.req.query();
    // Include participating account IDs for colour dots even in the global view.
    const list = await backend.store.matters.list({
      text: q.text,
      personId: q.personId,
      status: q.status
        ?.split(",")
        .map((s) => member(s, ["active", "waiting", "snoozed", "done"], "status")) as
        | MatterStatus[]
        | undefined,
      limit: q.accountId ? 500 : q.limit ? integer(Number(q.limit), "limit", 1, 500) : 500,
    });
    const decorated: Array<Matter & { accountIds: string[] }> = [];
    for (const matter of list) {
      const emails = await Promise.all(matter.emailIds.map((id) => backend.store.emails.get(id)));
      const events = await Promise.all(matter.eventIds.map((id) => backend.store.events.get(id)));
      const accountIds = [
        ...new Set([...emails, ...events].flatMap((item) => (item ? [item.accountId] : []))),
      ];
      if (!q.accountId || accountIds.includes(q.accountId)) {
        decorated.push({ ...matter, accountIds });
      }
    }
    return c.json(
      decorated.slice(0, q.limit ? integer(Number(q.limit), "limit", 1, 500) : undefined),
    );
  });
}
