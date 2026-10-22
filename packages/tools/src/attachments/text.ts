import { htmlToText, stripQuoteMarkers } from "../quoted.js";

/**
 * Text-like attachments: charset decoding and a minimal iCalendar VEVENT summary. Tools may only
 * depend on `@passport/types`, so the providers' ical and MIME parsers are not reused.
 */

/** Decodes bytes as text: BOM first, then strict UTF-8, then Windows-1252. */
export function decodeText(data: Uint8Array, charset?: string): string {
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(data.subarray(3));
  }
  if (data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(data.subarray(2));
  }
  if (data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(data.subarray(2));
  }
  if (charset) {
    try {
      return new TextDecoder(charset.trim().toLowerCase()).decode(data);
    } catch {
      // Unknown or unsupported label: fall through to detection.
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // Not UTF-8: legacy mail attachments are overwhelmingly Windows-1252 / Latin-1.
    return new TextDecoder("windows-1252").decode(data);
  }
}

/** Plain text of a text-like attachment; HTML (and HTML-looking `.htm`) becomes readable text. */
export function textOf(data: Uint8Array, name: string, type: string): string {
  const text = decodeText(data);
  if (type === "text/html" || /\.html?$/i.test(name)) {
    return stripQuoteMarkers(htmlToText(text));
  }
  return text;
}

export interface CalendarEventSummary {
  summary: string | null;
  start: string | null;
  end: string | null;
  location: string | null;
  organizer: string | null;
  attendees: Array<{ address: string; status: string | null }>;
  description: string | null;
  status: string | null;
  recurrence: string | null;
  uid: string | null;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

function property(line: string): Property | null {
  const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  if (colon <= 0) {
    return null;
  }
  const [name = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const [key, ...rest] = param.split("=");
    if (key) {
      params[key.toUpperCase()] = rest.join("=").replace(/^"|"$/g, "");
    }
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

const unescapeText = (value: string) =>
  value.replace(/\\([nN,;\\])/g, (_, char: string) => (char.toLowerCase() === "n" ? "\n" : char));
const address = (value: string) => value.replace(/^mailto:/i, "");

/** `20260120T140000Z` → `2026-01-20T14:00:00Z`; date-only and floating times keep their form. */
function icalDate({ value, params }: Property): string {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) {
    return value;
  }
  const [, y, mo, d, h, mi, s, z] = match;
  const date = `${y}-${mo}-${d}`;
  if (h === undefined) {
    return date;
  }
  const time = `${date}T${h}:${mi}:${s}${z ?? ""}`;
  return params.TZID && !z ? `${time} (${params.TZID})` : time;
}

/** Copies one VEVENT property into the summary. */
function assign(event: CalendarEventSummary, prop: Property): void {
  switch (prop.name) {
    case "SUMMARY":
      event.summary = unescapeText(prop.value);
      break;
    case "DTSTART":
      event.start = icalDate(prop);
      break;
    case "DTEND":
      event.end = icalDate(prop);
      break;
    case "LOCATION":
      event.location = unescapeText(prop.value);
      break;
    case "DESCRIPTION":
      event.description = unescapeText(prop.value).slice(0, 4000);
      break;
    case "ORGANIZER":
      event.organizer = prop.params.CN
        ? `${prop.params.CN} <${address(prop.value)}>`
        : address(prop.value);
      break;
    case "ATTENDEE":
      if (event.attendees.length < 100) {
        event.attendees.push({
          address: address(prop.value),
          status: prop.params.PARTSTAT ?? null,
        });
      }
      break;
    case "STATUS":
      event.status = prop.value;
      break;
    case "RRULE":
      event.recurrence = prop.value;
      break;
    case "UID":
      event.uid = prop.value;
      break;
  }
}

/** Events of an iCalendar file (VEVENTs only) and its METHOD. */
export function parseCalendar(text: string): {
  method: string | null;
  events: CalendarEventSummary[];
} {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const events: CalendarEventSummary[] = [];
  let method: string | null = null;
  let event: CalendarEventSummary | null = null;
  let depth = 0;
  for (const line of lines) {
    const prop = property(line);
    if (!prop) {
      continue;
    }
    if (prop.name === "BEGIN") {
      if (prop.value.toUpperCase() === "VEVENT" && !event) {
        event = {
          summary: null,
          start: null,
          end: null,
          location: null,
          organizer: null,
          attendees: [],
          description: null,
          status: null,
          recurrence: null,
          uid: null,
        };
        depth = 0;
      } else if (event) {
        depth++;
      }
      continue;
    }
    if (prop.name === "END") {
      if (event && depth === 0 && prop.value.toUpperCase() === "VEVENT") {
        events.push(event);
        event = null;
      } else if (event) {
        depth--;
      }
      continue;
    }
    if (!event) {
      method = prop.name === "METHOD" ? prop.value.trim() : method;
      continue;
    }
    if (depth > 0) {
      continue; // VALARM and other nested components.
    }
    assign(event, prop);
    if (events.length >= 200) {
      break;
    }
  }
  return { method, events };
}

/** Readable rendering of a parsed calendar for the `text` field. */
export function calendarText(calendar: ReturnType<typeof parseCalendar>): string {
  const blocks = calendar.events.map((event) =>
    [
      `Event: ${event.summary ?? "(no title)"}`,
      `When: ${event.start ?? "?"}${event.end ? ` – ${event.end}` : ""}`,
      ...(event.recurrence ? [`Repeats: ${event.recurrence}`] : []),
      ...(event.location ? [`Where: ${event.location}`] : []),
      ...(event.organizer ? [`Organizer: ${event.organizer}`] : []),
      ...(event.attendees.length
        ? [
            `Attendees: ${event.attendees
              .map((a) => (a.status ? `${a.address} (${a.status.toLowerCase()})` : a.address))
              .join(", ")}`,
          ]
        : []),
      ...(event.status ? [`Status: ${event.status}`] : []),
      ...(event.description ? ["", event.description] : []),
    ].join("\n"),
  );
  return [
    ...(calendar.method ? [`Method: ${calendar.method}`] : []),
    ...(blocks.length ? blocks : ["No events."]),
  ].join("\n\n");
}
