import type { EvictionResult } from "@passport/types";
import { mailHandle } from "@passport/types";
import type { StoreDatabase } from "./store-database.js";
import type { EmailRows } from "./store-email-rows.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const BODY_BYTES =
  "COALESCE(length(CAST(textBody AS BLOB)), 0) + COALESCE(length(CAST(html_body AS BLOB)), 0)";
const NOT_DRAFT =
  "NOT EXISTS (SELECT 1 FROM json_each(data, '$.keywords') k WHERE k.key = '$draft' AND k.type = 'true')";
/** Actions that may still read their emails: open ones, and executed ones that can be undone. */
const LIVE_ACTION = `a.status IN ('proposed', 'approved', 'held', 'executing')
  OR (a.status = 'executed' AND json_type(a.data, '$.inverse') = 'object'
    AND json_type(a.data, '$.undoneAt') IS NOT 'text')`;
/** Email ids such actions reference (request and inverse `emailIds`, draft ids). */
const ACTION_REFERENCES = ["$.request.params.emailIds", "$.inverse.params.emailIds"]
  .map(
    (path) =>
      `SELECT r.value AS id FROM actions a, json_each(a.data, '${path}') r WHERE ${LIVE_ACTION}`,
  )
  .concat(
    ["$.request.params.draftEmailId", "$.inverse.params.draftEmailId"].map(
      (path) => `SELECT json_extract(a.data, '${path}') AS id FROM actions a WHERE ${LIVE_ACTION}`,
    ),
  )
  .join(" UNION ");

const yieldWriter = () => new Promise<void>((resolve) => setImmediate(resolve));

export function createEviction(db: StoreDatabase, rows: EmailRows) {
  const dropBodies = (ids: string[]) => {
    for (const id of ids) {
      db.run(
        `UPDATE emails SET textBody = NULL, html_body = NULL, body_fetched_at = NULL,
        data = json_remove(data, '$.textBody', '$.htmlBody') WHERE id = ?`,
        [id],
      );
    }
  };
  const evictBodies = async ({
    olderThanMs = 7 * DAY_MS,
    maxBytes = 200 * 1024 * 1024,
  } = {}): Promise<EvictionResult> =>
    db.transaction(() => {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const expired = db
        .all(
          `SELECT id FROM emails WHERE body_fetched_at IS NOT NULL AND body_fetched_at < ? AND ${NOT_DRAFT}`,
          [cutoff],
        )
        .map((row) => row.id as string);
      dropBodies(expired);
      const cached = db.all(
        `SELECT id, ${BODY_BYTES} AS bytes FROM emails
        WHERE body_fetched_at IS NOT NULL AND ${NOT_DRAFT}
        ORDER BY touched_at ASC, id ASC`,
      );
      const drafts = Number(
        db.one(
          `SELECT COALESCE(SUM(${BODY_BYTES}), 0) AS bytes FROM emails
          WHERE body_fetched_at IS NOT NULL AND NOT (${NOT_DRAFT})`,
        )!.bytes,
      );
      let total = drafts + cached.reduce((sum, row) => sum + Number(row.bytes), 0);
      const overflow: string[] = [];
      for (const row of cached) {
        if (total <= maxBytes) {
          break;
        }
        overflow.push(row.id as string);
        total -= Number(row.bytes);
      }
      dropBodies(overflow);
      return { evicted: expired.length + overflow.length, remainingBytes: total };
    });
  const evictEnvelopes = async ({
    keep = 100_000,
    batchSize = 500,
  } = {}): Promise<EvictionResult> => {
    const referenced = new Set(
      db
        .all(ACTION_REFERENCES)
        .map((row) => row.id)
        .filter((id): id is string => typeof id === "string"),
    );
    const victims = db
      .all(
        `SELECT id, account_id, provider_id FROM (
          SELECT id, account_id, provider_id, matter_id, data FROM emails
          ORDER BY touched_at DESC, id DESC LIMIT -1 OFFSET ?
        ) e WHERE matter_id IS NULL AND ${NOT_DRAFT}
          AND NOT EXISTS (SELECT 1 FROM kv WHERE kv.key = 'arrival:' || e.id)`,
        [Math.max(0, keep)],
      )
      // Only rows read-through can refill: the id is still the handle of the current provider id.
      .filter(
        (row) =>
          row.id === mailHandle(row.account_id as string, "email", row.provider_id as string) &&
          !referenced.has(row.id as string),
      )
      .map((row) => row.id as string);
    const size = Math.max(1, Math.floor(batchSize));
    for (let i = 0; i < victims.length; i += size) {
      if (i > 0) {
        await yieldWriter();
      }
      db.transaction(() => {
        for (const id of victims.slice(i, i + size)) {
          rows.deleteEmail(id);
        }
      });
    }
    return { evicted: victims.length, remainingBytes: 0 };
  };
  return { evictBodies, evictEnvelopes };
}
