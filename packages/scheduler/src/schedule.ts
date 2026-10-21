export type Schedule =
  | { type: "interval"; everyMs: number; jitterMs?: number }
  | { type: "daily"; at: string; timeZone?: string }
  | { type: "weekly"; days: number[]; at: string; timeZone?: string }
  | { type: "manual" };

export class SchedulerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const invalid = (message: string): never => {
  throw new SchedulerError("INVALID_SCHEDULE", message);
};
/** Validate untrusted schedules and return an independent, normalized copy. Sunday is 0. */
export function validateSchedule(value: unknown): Schedule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("Expected a schedule object");
  }
  const s = value as Record<string, unknown>;
  function allowedFields() {
    if (s.type === "interval") {
      return ["type", "everyMs", "jitterMs"];
    }
    if (s.type === "daily") {
      return ["type", "at", "timeZone"];
    }
    if (s.type === "weekly") {
      return ["type", "days", "at", "timeZone"];
    }
    return ["type"];
  }
  const allowed = allowedFields();
  if (Object.keys(s).some((k) => !allowed.includes(k))) {
    return invalid("Unknown schedule field");
  }
  if (s.type === "manual") {
    return { type: "manual" };
  }
  if (s.type === "interval") {
    if (typeof s.everyMs !== "number" || !Number.isSafeInteger(s.everyMs) || s.everyMs < 1) {
      return invalid("everyMs must be a positive integer");
    }
    if (
      s.jitterMs !== undefined &&
      (typeof s.jitterMs !== "number" ||
        !Number.isSafeInteger(s.jitterMs) ||
        s.jitterMs < 0 ||
        s.jitterMs > s.everyMs)
    ) {
      return invalid("jitterMs must be between 0 and everyMs");
    }
    return {
      type: "interval",
      everyMs: s.everyMs,
      ...(s.jitterMs === undefined ? {} : { jitterMs: s.jitterMs as number }),
    };
  }
  if (s.type !== "daily" && s.type !== "weekly") {
    return invalid("Unknown schedule type");
  }
  if (typeof s.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) {
    return invalid("at must be HH:MM");
  }
  const timeZone = s.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    if (typeof timeZone !== "string") {
      return invalid("Invalid time zone");
    }
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    return invalid("Invalid IANA time zone");
  }
  if (s.type === "daily") {
    return { type: "daily", at: s.at, timeZone: timeZone as string };
  }
  if (
    !Array.isArray(s.days) ||
    !s.days.length ||
    s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  ) {
    return invalid("days must contain weekdays 0–6");
  }
  return {
    type: "weekly",
    at: s.at,
    timeZone: timeZone as string,
    days: [...new Set(s.days as number[])].sort(),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(ms: number, zone: string) {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(zone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(ms).map((p) => [p.type, p.value]));
  return {
    year: +p.year!,
    month: +p.month!,
    day: +p.day!,
    hour: +p.hour!,
    minute: +p.minute!,
  };
}
function wallStamp(ms: number, zone: string) {
  const p = parts(ms, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}
/** First occurrence in a fold; first valid local minute after a spring gap. */
function localInstant(wall: number, zone: string): number | null {
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const probe = wall + h * 3600000;
    offsets.add(wallStamp(probe, zone) - probe);
  }
  for (let minute = 0; minute <= 180; minute++) {
    const target = wall + minute * 60000;
    const matches = [...offsets]
      .map((offset) => target - offset)
      .filter((ms) => wallStamp(ms, zone) === target);
    if (matches.length) {
      return Math.min(...matches);
    }
  }
  return null;
}
/** Return the next future occurrence, coalescing missed interval ticks. */
export function nextOccurrence(
  schedule: Schedule,
  after: number,
  previous?: number,
): number | null {
  if (schedule.type === "manual") {
    return null;
  }
  if (schedule.type === "interval") {
    const base = previous ?? after;
    const steps = Math.max(1, Math.floor((after - base) / schedule.everyMs) + 1);
    return (
      base + steps * schedule.everyMs + Math.floor(Math.random() * ((schedule.jitterMs ?? 0) + 1))
    );
  }
  const zone = schedule.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const p = parts(after, zone);
  const [hour, minute] = schedule.at.split(":").map(Number);
  for (let day = 0; day <= 8; day++) {
    const date = new Date(Date.UTC(p.year, p.month - 1, p.day + day));
    if (schedule.type === "weekly" && !schedule.days.includes(date.getUTCDay())) {
      continue;
    }
    const wall = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      hour,
      minute,
    );
    const instant = localInstant(wall, zone);
    if (instant !== null && instant > after) {
      return instant;
    }
  }
  throw new SchedulerError("INVALID_SCHEDULE", "No occurrence found in the next week");
}
