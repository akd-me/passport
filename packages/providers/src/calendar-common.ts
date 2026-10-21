import type { CalendarEvent, ParticipationStatus, TimeRange } from "@passport/types";
import { ProviderError } from "./errors.js";
import { toIso } from "./normalize/index.js";

const windowsZones: Record<string, string> = {
  UTC: "UTC",
  "Etc/UTC": "UTC",
  "Pacific Standard Time": "America/Los_Angeles",
  "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago",
  "Eastern Standard Time": "America/New_York",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "India Standard Time": "Asia/Kolkata",
};

/** Convert a provider's floating wall time using its zone, rather than the machine's local zone. */
export function zonedToUtc(value: string, zone = "UTC"): string {
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(value)) {
    return toIso(value);
  }
  const full = value.length === 10 ? `${value}T00:00:00` : value;
  const target = Date.parse(`${full}Z`);
  if (!Number.isFinite(target)) {
    throw new ProviderError("INVALID_DATE", "Calendar timestamp is invalid");
  }
  let result = target;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: windowsZones[zone] ?? zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    for (let i = 0; i < 4; i++) {
      const p = Object.fromEntries(formatter.formatToParts(result).map((p) => [p.type, p.value]));
      const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`),
        diff = target - wall;
      if (!diff) {
        return toIso(result);
      }
      result += diff;
    }
  } catch {
    throw new ProviderError("UNSUPPORTED_TIMEZONE", "Calendar returned an unsupported timezone");
  }
  throw new ProviderError("INVALID_DATE", "Calendar wall time does not exist in its timezone");
}

export function localDate(value: string, zone = "UTC"): string {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: windowsZones[zone] ?? zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(new Date(value))
        .map((p) => [p.type, p.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    throw new ProviderError(
      "INVALID_DATE",
      "Cannot format calendar date in the requested timezone",
    );
  }
}

export function validateEvent(input: Partial<CalendarEvent>): void {
  if (input.start) {
    toIso(input.start);
  }
  if (input.end) {
    toIso(input.end);
  }
  if (input.start && input.end && Date.parse(input.end) <= Date.parse(input.start)) {
    throw new ProviderError("INVALID_EVENT", "Event end must be after start");
  }
}

export function validateRange(range: TimeRange): void {
  validateEvent(range);
}
export function graphStatus(value?: string): ParticipationStatus {
  return (
    (
      {
        accepted: "accepted",
        declined: "declined",
        tentativelyAccepted: "tentative",
        tentative: "tentative",
        organizer: "accepted",
      } as Record<string, ParticipationStatus>
    )[value ?? ""] ?? "needs-action"
  );
}
