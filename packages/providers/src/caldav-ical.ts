import type { CalendarEvent, ParticipationStatus } from "@passport/types";
import ICAL from "ical.js";
import { localDate, validateEvent, zonedToUtc } from "./calendar-common.js";
import { encodeCursor, localId, ProviderError } from "./errors.js";
import { toIso } from "./normalize/index.js";

const participation: Record<string, ParticipationStatus> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  "NEEDS-ACTION": "needs-action",
};

export function parseCalendar(source: string): ICAL.Component {
  try {
    const component = new ICAL.Component(ICAL.parse(source));
    if (component.name !== "vcalendar") {
      throw new Error();
    }
    return component;
  } catch {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    throw new ProviderError("INVALID_ICALENDAR", "CalDAV returned invalid iCalendar data");
  }
}

export function components(root: ICAL.Component): ICAL.Component[] {
  return root.getAllSubcomponents("vevent");
}

export function key(component: ICAL.Component): [string, string] {
  return [
    String(component.getFirstPropertyValue("uid") ?? ""),
    String(component.getFirstPropertyValue("recurrence-id") ?? ""),
  ];
}

function providerId(href: string, component: ICAL.Component): string {
  return `caldav:${encodeCursor([href, ...key(component)])}`;
}

function calendarTimestamp(
  root: ICAL.Component,
  component: ICAL.Component,
  value: ICAL.Time,
  property: string,
  defaultZone: string,
): string {
  const zone = String(
    component.getFirstProperty(property)?.getParameter("tzid") ??
      (!component.hasProperty(property)
        ? component.getFirstProperty("dtstart")?.getParameter("tzid")
        : undefined) ??
      value.zone?.tzid ??
      defaultZone,
  );
  if (zone === "UTC" || zone === "Z") {
    return toIso(value.toJSDate());
  }
  if (zone === "floating" || zone === "local") {
    return zonedToUtc(value.toString(), defaultZone);
  }
  const embedded = root
    .getAllSubcomponents("vtimezone")
    .find((t) => String(t.getFirstPropertyValue("tzid")) === zone);
  if (embedded) {
    const time = value.clone();
    time.zone = new ICAL.Timezone({ component: embedded, tzid: zone });
    return toIso(time.toJSDate());
  }
  return zonedToUtc(value.toString(), zone);
}

/** Preserves masters and stored recurrence overrides; does not expand an infinite recurrence series. */
export function normalizeIcalendar(
  source: string,
  accountId: string,
  calendarId: string,
  href: string,
  owner: string,
  defaultZone = "UTC",
): CalendarEvent[] {
  const root = parseCalendar(source);
  return components(root).map((component) => {
    const event = new ICAL.Event(component),
      start = event.startDate,
      end = event.endDate;
    if (!start || !end) {
      throw new ProviderError("INVALID_ICALENDAR", "VEVENT has no usable DTSTART/DTEND");
    }

    const participants = component.getAllProperties("attendee").map((p) => ({
      email: String(p.getFirstValue())
        .replace(/^mailto:/i, "")
        .toLowerCase(),
      ...(p.getParameter("cn") ? { name: String(p.getParameter("cn")) } : {}),
      status:
        participation[String(p.getParameter("partstat") ?? "NEEDS-ACTION").toUpperCase()] ??
        "needs-action",
      role:
        String(p.getParameter("role") ?? "").toUpperCase() === "OPT-PARTICIPANT"
          ? ("optional" as const)
          : ("attendee" as const),
    }));
    const organizer = component.getFirstProperty("organizer"),
      id = providerId(href, component);
    const status = String(component.getFirstPropertyValue("status") ?? "CONFIRMED").toUpperCase();
    const updated =
      component.getFirstPropertyValue("last-modified") ??
      component.getFirstPropertyValue("dtstamp");
    return {
      id: localId(accountId, "event", id),
      accountId,
      calendarId: localId(accountId, "calendar", calendarId),
      providerId: id,
      title: event.summary ?? "",
      description: String(component.getFirstPropertyValue("description") ?? ""),
      location: String(component.getFirstPropertyValue("location") ?? ""),
      start: calendarTimestamp(root, component, start, "dtstart", defaultZone),
      end: calendarTimestamp(root, component, end, "dtend", defaultZone),
      allDay: start.isDate,
      timeZone: String(
        component.getFirstProperty("dtstart")?.getParameter("tzid") ??
          (start.zone?.tzid === "floating" ? defaultZone : start.zone?.tzid) ??
          defaultZone,
      ),
      status:
        status === "CANCELLED" ? "cancelled" : status === "TENTATIVE" ? "tentative" : "confirmed",
      organizer: organizer
        ? {
            email: String(organizer.getFirstValue())
              .replace(/^mailto:/i, "")
              .toLowerCase(),
            ...(organizer.getParameter("cn") ? { name: String(organizer.getParameter("cn")) } : {}),
          }
        : null,
      participants,
      myStatus: participants.find((p) => p.email === owner.toLowerCase())?.status ?? null,
      recurrenceRule: component.getFirstPropertyValue("rrule")?.toString() ?? null,
      updatedAt: updated instanceof ICAL.Time ? toIso(updated.toJSDate()) : toIso(0),
    };
  });
}

export function writeCalendar(
  component: ICAL.Component,
  patch: Partial<CalendarEvent>,
  now: () => Date,
): void {
  validateEvent(patch);
  for (const [from, to] of [
    ["title", "summary"],
    ["description", "description"],
    ["location", "location"],
  ] as const) {
    if (patch[from] !== undefined) {
      component.updatePropertyWithValue(to, patch[from] ?? "");
    }
  }
  for (const [from, to] of [
    ["start", "dtstart"],
    ["end", "dtend"],
  ] as const) {
    if (patch[from]) {
      const time = patch.allDay
        ? ICAL.Time.fromDateString(localDate(patch[from], patch.timeZone ?? "UTC"))
        : ICAL.Time.fromJSDate(new Date(patch[from]), true);
      component.removeAllProperties(to);
      component.addPropertyWithValue(to, time);
    }
  }
  if (patch.status) {
    component.updatePropertyWithValue("status", patch.status.toUpperCase());
  }
  if (patch.organizer !== undefined) {
    component.removeAllProperties("organizer");
    if (patch.organizer) {
      component.addPropertyWithValue("organizer", `mailto:${patch.organizer.email}`);
    }
  }
  if (patch.participants) {
    component.removeAllProperties("attendee");
    for (const p of patch.participants) {
      const property = new ICAL.Property("attendee");
      property.setValue(`mailto:${p.email}`);
      property.setParameter("partstat", p.status.toUpperCase());
      if (p.name) {
        property.setParameter("cn", p.name);
      }
      property.setParameter("role", p.role === "optional" ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT");
      component.addProperty(property);
    }
  }
  if (patch.recurrenceRule !== undefined) {
    component.removeAllProperties("rrule");
    if (patch.recurrenceRule) {
      try {
        component.addPropertyWithValue(
          "rrule",
          ICAL.Recur.fromString(patch.recurrenceRule.replace(/^RRULE:/, "")),
        );
      } catch {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        throw new ProviderError("INVALID_RRULE", "Invalid recurrence rule");
      }
    }
  }
  component.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now(), true));
  component.updatePropertyWithValue("last-modified", ICAL.Time.fromJSDate(now(), true));
  component.updatePropertyWithValue(
    "sequence",
    Number(component.getFirstPropertyValue("sequence") ?? 0) + 1,
  );
}
