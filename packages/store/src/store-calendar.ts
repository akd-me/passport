import type { SQLInputValue } from "node:sqlite";
import type { CalendarEvent, Store } from "@passport/types";
import type { StoreDatabase } from "./store-database.js";
import { limitOf, type Row, unique } from "./store-query.js";

export function createCalendarRepositories(db: StoreDatabase) {
  const calendars: Store["calendars"] = {
    list: async (accountId) =>
      db.rows("SELECT data FROM calendars WHERE account_id = ? ORDER BY id", [accountId]),
    upsertMany: async (calendars) =>
      db.transaction(() => {
        for (const calendar of calendars) {
          db.put("calendars", calendar.id, calendar, {
            account_id: calendar.accountId,
            provider_id: calendar.providerId,
          });
        }
      }),
  };
  function readEvent(row: Row): CalendarEvent {
    const event = db.parse<CalendarEvent>(row);
    if (row.matter_id !== null || event.matterId !== undefined) {
      event.matterId = row.matter_id as string | null;
    }
    return event;
  }
  const events: Store["events"] = {
    get: async (id) => {
      const row = db.one("SELECT data, matter_id FROM events WHERE id = ?", [id]);
      return row ? readEvent(row) : null;
    },
    query: async (q) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.accountId !== undefined) {
        where.push("account_id = ?");
        params.push(q.accountId);
      }
      if (q.matterId !== undefined) {
        where.push("matter_id = ?");
        params.push(q.matterId);
      }
      if (q.range) {
        where.push(
          q.includeRecurring
            ? "((start < ? AND end > ?) OR (start < ? AND json_extract(data, '$.recurrenceRule') IS NOT NULL) OR json_extract(data, '$.recurringEventId') IS NOT NULL)"
            : "start < ? AND end > ?",
        );
        params.push(q.range.end, q.range.start);
        if (q.includeRecurring) {
          params.push(q.range.end);
        }
      }
      return db
        .all(
          `SELECT data, matter_id FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY start, id LIMIT ?`,
          [...params, limitOf(q.limit)],
        )
        .map((row) => readEvent(row));
    },
    upsertMany: async (events) =>
      db.transaction(() => {
        for (const event of events) {
          const pending = db.one("SELECT matter_id FROM matter_events WHERE event_id = ?", [
            event.id,
          ]);
          const matterId =
            event.matterId === undefined
              ? ((pending?.matter_id as string | undefined) ?? null)
              : event.matterId;
          db.put("events", event.id, event, {
            account_id: event.accountId,
            provider_id: event.providerId,
            calendar_id: event.calendarId,
            matter_id: matterId,
            start: event.start,
            end: event.end,
          });
          db.setMatterLink("events", event.id, matterId);
        }
      }),
    deleteMany: async (ids) =>
      db.transaction(() => {
        for (const id of unique(ids)) {
          db.deleteEvent(id);
        }
      }),
  };
  return { calendars, events };
}
