// Server-local recurrence adapter, matching the tool registry's implementation.
// Keep package ownership isolated; move this to a shared public dependency when
// the server dependency graph can be updated together with the lockfile.
import type { CalendarEvent, TimeRange } from "@passport/types";
import { ApiError } from "./errors.js";

const day = 86_400_000;
const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const overlaps = (a: TimeRange, b: TimeRange) =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);

function recurrenceClock(zone: string) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new ApiError(
      "UNSUPPORTED_RECURRENCE",
      "Unsupported recurrence time zone; connect live calendar availability.",
    );
  }
  const wall = (instant: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(instant).map((part) => [part.type, part.value]),
    );
    return Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
      instant % 1000,
    );
  };
  const instant = (target: number): number | null => {
    let result = target;
    for (let i = 0; i < 4; i++) {
      const difference = target - wall(result);
      if (!difference) return result;
      result += difference;
    }
    return null; // A nonexistent wall time during a DST jump is not an occurrence.
  };
  return { wall, instant };
}

/** RFC 5545 subset: DAILY/WEEKLY/MONTHLY, INTERVAL, BYDAY, COUNT, UNTIL in the event's zone. */
export function expandRecurringEvents(
  events: readonly CalendarEvent[],
  range: TimeRange,
): CalendarEvent[] {
  const result: CalendarEvent[] = [];
  const exceptions = new Map(
    events
      .filter((event) => event.recurringEventId && event.originalStart)
      .map((event) => [
        `${event.accountId}:${event.recurringEventId}:${Date.parse(event.originalStart!)}`,
        event,
      ]),
  );
  for (const event of events) {
    if (event.recurringEventId && event.originalStart) continue;
    if (event.status === "cancelled" || event.myStatus === "declined") continue;
    if (!event.recurrenceRule) {
      if (overlaps(event, range)) result.push(event);
      continue;
    }
    const parts: Record<string, string> = Object.fromEntries(
      event.recurrenceRule
        .replace(/^RRULE:/i, "")
        .trim()
        .toUpperCase()
        .split(";")
        .map((part) => part.split("=")),
    );
    if (
      !["DAILY", "WEEKLY", "MONTHLY"].includes(parts.FREQ ?? "") ||
      Object.keys(parts).some(
        (key) => !["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"].includes(key),
      )
    )
      throw new ApiError(
        "UNSUPPORTED_RECURRENCE",
        "Unsupported recurrence rule; connect live calendar availability for this series.",
      );
    const interval = Number(parts.INTERVAL ?? 1),
      count = Number(parts.COUNT ?? Infinity);
    if (
      !Number.isSafeInteger(interval) ||
      interval < 1 ||
      !(count === Infinity || (Number.isSafeInteger(count) && count > 0))
    )
      throw new ApiError("INVALID_RECURRENCE", "Invalid recurrence interval or count.");
    const untilText = parts.UNTIL;
    const until = untilText
      ? Date.parse(
          untilText.replace(
            /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/,
            (_all, y, m, d, h, min, sec) =>
              `${y}-${m}-${d}T${h ?? "23"}:${min ?? "59"}:${sec ?? "59"}.000Z`,
          ),
        )
      : Infinity;
    if (Number.isNaN(until))
      throw new ApiError("INVALID_RECURRENCE", "Invalid recurrence end date.");
    const byDay = parts.BYDAY?.split(",").map((value) => {
      const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(value);
      if (!match || (match[1] && parts.FREQ !== "MONTHLY"))
        throw new ApiError("UNSUPPORTED_RECURRENCE", "Unsupported BYDAY recurrence.");
      const ordinal = match[1] ? Number(match[1]) : 0;
      if (ordinal < -5 || ordinal > 5 || (match[1] && ordinal === 0))
        throw new ApiError("INVALID_RECURRENCE", "Invalid BYDAY ordinal.");
      return { weekday: weekdays.indexOf(match[2]!), ordinal };
    });
    const startInstant = Date.parse(event.start),
      duration = Date.parse(event.end) - startInstant;
    if (!Number.isFinite(startInstant) || duration <= 0)
      throw new ApiError("INVALID_RECURRENCE", "Invalid recurring event duration.");
    const clock = recurrenceClock(event.timeZone ?? "UTC"),
      first = clock.wall(startInstant);
    const firstDate = new Date(first),
      firstMidnight = Date.UTC(
        firstDate.getUTCFullYear(),
        firstDate.getUTCMonth(),
        firstDate.getUTCDate(),
      );
    const firstWeekday = firstDate.getUTCDay(),
      weekStart = weekdays.indexOf(parts.WKST ?? "MO");
    if (weekStart < 0) throw new ApiError("INVALID_RECURRENCE", "Invalid recurrence week start.");
    const weekAnchor = firstMidnight - ((firstWeekday - weekStart + 7) % 7) * day;
    const end = clock.wall(Math.min(Date.parse(range.end), until)) + day;
    // No COUNT means we can jump near the window while preserving the series phase.
    const offset =
      count === Infinity
        ? Math.max(
            0,
            Math.floor((clock.wall(Date.parse(range.start)) - duration - first) / day) - 1,
          )
        : 0;
    let emitted = 0;
    for (let date = first + offset * day; date <= end; date += day) {
      const current = new Date(date),
        weekday = current.getUTCDay();
      const daysSince = Math.round((date - first) / day);
      const monthSince =
        (current.getUTCFullYear() - firstDate.getUTCFullYear()) * 12 +
        current.getUTCMonth() -
        firstDate.getUTCMonth();
      const week = Math.floor((firstMidnight + daysSince * day - weekAnchor) / (7 * day));
      const monthDays = new Date(
        Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const matchingDay = byDay?.some(
        (value) =>
          value.weekday === weekday &&
          (!value.ordinal ||
            (value.ordinal > 0 && Math.ceil(current.getUTCDate() / 7) === value.ordinal) ||
            (value.ordinal < 0 &&
              -Math.ceil((monthDays - current.getUTCDate() + 1) / 7) === value.ordinal)),
      );
      const matches =
        parts.FREQ === "DAILY"
          ? daysSince % interval === 0 && (matchingDay ?? true)
          : parts.FREQ === "WEEKLY"
            ? week % interval === 0 && (matchingDay ?? weekday === firstWeekday)
            : monthSince % interval === 0 &&
              (matchingDay ?? current.getUTCDate() === firstDate.getUTCDate());
      if (!matches) continue;
      const occurrenceStart = clock.instant(date);
      if (occurrenceStart === null) continue;
      if (occurrenceStart > until || occurrenceStart >= Date.parse(range.end)) break;
      if (++emitted > count) break;
      const exception =
        exceptions.get(`${event.accountId}:${event.providerId}:${occurrenceStart}`) ??
        exceptions.get(`${event.accountId}:${event.id}:${occurrenceStart}`);
      const occurrenceEnd = event.allDay
        ? clock.instant(date + clock.wall(Date.parse(event.end)) - first)
        : occurrenceStart + duration;
      if (occurrenceEnd === null) continue;
      const occurrence = exception ?? {
        ...event,
        start: new Date(occurrenceStart).toISOString(),
        end: new Date(occurrenceEnd).toISOString(),
      };
      if (
        occurrence.status !== "cancelled" &&
        occurrence.myStatus !== "declined" &&
        overlaps(occurrence, range)
      )
        result.push(occurrence);
    }
  }
  // Moved overrides can overlap the window even when their original start does not.
  for (const exception of exceptions.values())
    if (
      exception.status !== "cancelled" &&
      exception.myStatus !== "declined" &&
      overlaps(exception, range) &&
      !result.some((item) => item.id === exception.id && item.start === exception.start)
    )
      result.push(exception);
  return result;
}
