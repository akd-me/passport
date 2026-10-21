import { randomUUID } from "node:crypto";
import type {
  Calendar,
  CalendarEvent,
  CalendarProvider,
  ParticipationStatus,
  TimeRange,
} from "@passport/types";
import ICAL from "ical.js";
import { localDate, validateEvent, validateRange, zonedToUtc } from "./calendar-common.js";
import {
  decodeCursor,
  encodeCursor,
  localId,
  NotImplementedError,
  ProviderError,
  required,
} from "./errors.js";
import { HttpConnection, type ProviderOptions } from "./http.js";
import { type CalendarDelta, type EventInput, overlaps } from "./mock.js";
import { toIso } from "./normalize/index.js";
import { descendants, parseXml, type XmlNode, xmlEscape, xmlText } from "./xml.js";

interface ResourceState {
  etag: string;
  ids: string[];
}
interface DavCursor {
  account: string;
  collection: string;
  token: string | null;
  resources: Record<string, ResourceState>;
}
interface DavResource {
  href: string;
  status: number;
  etag?: string;
  data?: string;
}
const participation: Record<string, ParticipationStatus> = {
  ACCEPTED: "accepted",
  DECLINED: "declined",
  TENTATIVE: "tentative",
  "NEEDS-ACTION": "needs-action",
};

function parseCalendar(source: string): ICAL.Component {
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
function components(root: ICAL.Component): ICAL.Component[] {
  return root.getAllSubcomponents("vevent");
}
function key(component: ICAL.Component): [string, string] {
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

export class CalDavCalendarProvider extends HttpConnection implements CalendarProvider {
  readonly kind = "caldav" as const;
  constructor(options: ProviderOptions = {}) {
    super(options);
  }
  private get collection(): string {
    this.check();
    const url = new URL(required(this.account.settings.calendarUrl, "calendarUrl"));
    if (url.protocol !== "https:") {
      throw new ProviderError("CONFIG_INVALID", "CalDAV calendarUrl must use HTTPS");
    }
    return url.href.endsWith("/") ? url.href : `${url.href}/`;
  }
  private resourceUrl(href: string): string {
    const url = this.safeLink(href, this.collection);
    if (!url.startsWith(this.collection) || url === this.collection) {
      throw new ProviderError(
        "INVALID_RESPONSE",
        "CalDAV resource lies outside the configured calendar collection",
      );
    }
    return url;
  }
  private async dav(method: string, body: string, depth = "1"): Promise<XmlNode> {
    const response = await this.http(this.collection, {
      method,
      headers: { "content-type": "application/xml; charset=utf-8", Depth: depth },
      body,
    });
    return parseXml(await response.text());
  }
  private async properties(): Promise<XmlNode> {
    return this.dav(
      "PROPFIND",
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:sync-token/><c:calendar-timezone/></d:prop></d:propfind>',
      "0",
    );
  }
  async listCalendars(): Promise<Calendar[]> {
    const data = await this.properties();
    return [
      {
        id: localId(this.account.id, "calendar", this.collection),
        accountId: this.account.id,
        providerId: this.collection,
        name: xmlText(data, "displayname") ?? this.account.displayName,
        isPrimary: true,
        timeZone: String(this.account.settings.timeZone ?? "UTC"),
      },
    ];
  }
  private resources(xml: XmlNode): DavResource[] {
    return descendants(xml, "response").flatMap((node) => {
      const href = xmlText(node, "href");
      if (!href) {
        throw new ProviderError("INVALID_XML", "WebDAV response is missing href");
      }
      if (
        new URL(href, this.collection).href.replace(/\/$/, "") ===
        this.collection.replace(/\/$/, "")
      ) {
        return [];
      }
      const directStatus = node.children.find((n) => n.name === "status")?.text;
      if (directStatus && /\s(404|410)\b/.test(directStatus)) {
        return [{ href: this.resourceUrl(href), status: 404 }];
      }
      const successful = descendants(node, "propstat").filter((p) =>
        /\s200\b/.test(xmlText(p, "status") ?? ""),
      );
      if (!successful.length) {
        throw new ProviderError(
          "CALDAV_RESOURCE_ERROR",
          "CalDAV returned an unsuccessful resource response",
        );
      }
      const data = successful.map((p) => xmlText(p, "calendar-data")).find((v) => v !== undefined),
        etag = successful.map((p) => xmlText(p, "getetag")).find((v) => v !== undefined);
      return [
        {
          href: this.resourceUrl(href),
          status: 200,
          ...(data !== undefined ? { data } : {}),
          ...(etag !== undefined ? { etag } : {}),
        },
      ];
    });
  }
  private normalize(source: string, href: string): CalendarEvent[] {
    return normalizeIcalendar(
      source,
      this.account.id,
      this.collection,
      href,
      this.account.emailAddress,
      String(this.account.settings.timeZone ?? "UTC"),
    );
  }
  async *sync(cursor: string | null, _range?: TimeRange): AsyncIterable<CalendarDelta> {
    this.check();
    const previous: DavCursor = cursor
      ? decodeCursor<DavCursor>(cursor)
      : { account: this.account.id, collection: this.collection, token: null, resources: {} };
    if (
      previous.account !== this.account.id ||
      previous.collection !== this.collection ||
      !previous.resources
    ) {
      throw new ProviderError("INVALID_CURSOR", "CalDAV cursor belongs to another collection");
    }
    const incremental = Boolean(previous.token),
      next: DavCursor = {
        ...previous,
        resources: incremental ? structuredClone(previous.resources) : {},
        token: null,
      };
    let xml: XmlNode;
    if (incremental) {
      try {
        xml = await this.dav(
          "REPORT",
          `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${xmlEscape(previous.token!)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
        );
      } catch (e) {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        if (e instanceof ProviderError && [403, 409, 410].includes(e.status ?? 0)) {
          throw new ProviderError(
            "CURSOR_EXPIRED",
            "CalDAV sync token is invalid or unauthorized; verify credentials and reset calendar state",
          );
        }
        throw e;
      }
      next.token = required(xmlText(xml, "sync-token"), "CalDAV sync-token");
      // RFC 6578 permits truncation with a new token. Return the partial watermark; next sync resumes it.
    } else {
      // Capture a token before listing; replays are harmless and concurrent additions cannot be skipped.
      next.token = xmlText(await this.properties(), "sync-token") ?? null;
      xml = await this.dav(
        "REPORT",
        '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>',
      );
    }
    for (const resource of this.resources(xml)) {
      const old = previous.resources[resource.href];
      if (resource.status === 404) {
        for (const id of old?.ids ?? []) {
          yield { kind: "event", op: "delete", providerId: id };
        }
        delete next.resources[resource.href];
        continue;
      }
      if (resource.etag && old?.etag === resource.etag) {
        next.resources[resource.href] = old;
        continue;
      }
      let source = resource.data;
      if (source === undefined) {
        source = await (await this.http(resource.href)).text();
      }
      const events = this.normalize(source, resource.href),
        ids = events.map((e) => e.providerId);
      for (const id of old?.ids ?? []) {
        if (!ids.includes(id)) {
          yield { kind: "event", op: "delete", providerId: id };
        }
      }
      for (const event of events) {
        yield event.status === "cancelled"
          ? { kind: "event", op: "delete", providerId: event.providerId }
          : { kind: "event", op: "upsert", event };
      }
      next.resources[resource.href] = { etag: resource.etag ?? "", ids };
    }
    if (!incremental) {
      for (const [href, old] of Object.entries(previous.resources)) {
        if (!next.resources[href]) {
          for (const id of old.ids) {
            yield { kind: "event", op: "delete", providerId: id };
          }
        }
      }
    }
    yield { kind: "cursor", cursor: encodeCursor(next) };
  }
  private async load(
    id: string,
  ): Promise<{ root: ICAL.Component; component: ICAL.Component; href: string; etag: string }> {
    if (!id.startsWith("caldav:")) {
      throw new ProviderError("INVALID_PROVIDER_ID", "Invalid CalDAV event identity");
    }
    const [rawHref, uid, recurrence] = decodeCursor<[string, string, string]>(id.slice(7)),
      href = this.resourceUrl(rawHref);
    const response = await this.http(href),
      root = parseCalendar(await response.text());
    const component = components(root).find((c) => {
      const k = key(c);
      return k[0] === uid && k[1] === recurrence;
    });
    if (!component) {
      throw new ProviderError("NOT_FOUND", "CalDAV VEVENT does not exist");
    }
    return {
      root,
      component,
      href,
      etag: required(response.headers.get("etag"), "CalDAV ETag for conditional update"),
    };
  }
  private write(component: ICAL.Component, patch: Partial<CalendarEvent>): void {
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
        property.setParameter(
          "role",
          p.role === "optional" ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT",
        );
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
    component.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(this.now(), true));
    component.updatePropertyWithValue("last-modified", ICAL.Time.fromJSDate(this.now(), true));
    component.updatePropertyWithValue(
      "sequence",
      Number(component.getFirstPropertyValue("sequence") ?? 0) + 1,
    );
  }
  async createEvent(input: EventInput): Promise<CalendarEvent> {
    this.check();
    if (input.accountId !== this.account.id) {
      throw new ProviderError("ACCOUNT_MISMATCH", "Event belongs to another account");
    }
    const uid = randomUUID(),
      href = `${this.collection}${uid}.ics`,
      root = new ICAL.Component("vcalendar"),
      component = new ICAL.Component("vevent");
    root.addPropertyWithValue("version", "2.0");
    root.addPropertyWithValue("prodid", "-//Passport//Calendar//EN");
    root.addSubcomponent(component);
    component.addPropertyWithValue("uid", uid);
    this.write(component, input);
    await this.http(href, {
      method: "PUT",
      headers: { "content-type": "text/calendar; charset=utf-8", "If-None-Match": "*" },
      body: root.toString(),
    });
    return this.normalize(root.toString(), href)[0]!;
  }
  async updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    const { root, component, href, etag } = await this.load(id);
    if (patch.start || patch.end) {
      const current = this.normalize(root.toString(), href).find((e) => e.providerId === id)!;
      patch = {
        ...patch,
        allDay: patch.allDay ?? current.allDay,
        timeZone: patch.timeZone ?? current.timeZone,
      };
    }
    this.write(component, patch);
    await this.http(href, {
      method: "PUT",
      headers: { "content-type": "text/calendar; charset=utf-8", "If-Match": etag },
      body: root.toString(),
    });
    return this.normalize(root.toString(), href).find((e) => e.providerId === id)!;
  }
  async deleteEvent(id: string): Promise<void> {
    const { root, component, href, etag } = await this.load(id);
    if (component.hasProperty("recurrence-id")) {
      throw new NotImplementedError(
        "Deleting a recurrence override requires an EXDATE update on its master; delete the series or update its recurrence rule",
      );
    }
    if (components(root).filter((c) => key(c)[0] !== key(component)[0]).length) {
      throw new NotImplementedError(
        "Deleting one UID from a multi-UID CalDAV resource is not supported",
      );
    }
    await this.http(href, { method: "DELETE", headers: { "If-Match": etag } });
  }
  async respond(id: string, status: ParticipationStatus, comment?: string): Promise<void> {
    const { root, component, href, etag } = await this.load(id);
    const attendee = component.getAllProperties("attendee").find(
      (p) =>
        String(p.getFirstValue())
          .replace(/^mailto:/i, "")
          .toLowerCase() === this.account.emailAddress.toLowerCase(),
    );
    if (!attendee) {
      throw new ProviderError(
        "NOT_AN_ATTENDEE",
        "The account is not an attendee of this CalDAV event",
      );
    }
    attendee.setParameter("partstat", status.toUpperCase());
    if (comment) {
      component.updatePropertyWithValue("comment", comment);
    }
    this.write(component, {});
    await this.http(href, {
      method: "PUT",
      headers: { "content-type": "text/calendar; charset=utf-8", "If-Match": etag },
      body: root.toString(),
    });
  }
  async freeBusy(range: TimeRange): Promise<TimeRange[]> {
    validateRange(range);
    const stamp = (s: string) =>
      toIso(s)
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    try {
      const response = await this.http(this.collection, {
        method: "REPORT",
        headers: { "content-type": "application/xml; charset=utf-8", Depth: "1" },
        body: `<c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="${stamp(range.start)}" end="${stamp(range.end)}"/></c:free-busy-query>`,
      });
      const calendar = parseCalendar(await response.text());
      return calendar.getAllSubcomponents("vfreebusy").flatMap((c) =>
        c
          .getAllProperties("freebusy")
          .filter((p) => p.getParameter("fbtype") !== "FREE")
          .flatMap((p) =>
            p.getValues().map((value) => {
              const period = value as ICAL.Period;
              return {
                start: toIso(period.start.toJSDate()),
                end: toIso(period.getEnd().toJSDate()),
              };
            }),
          ),
      );
    } catch (e) {
      // Unsupported free-busy REPORT uses bounded event fallback; other provider errors propagate.

      if (!(e instanceof ProviderError && [403, 405, 501].includes(e.status ?? 0))) {
        throw e;
      }
      // Documented best effort fallback: materialized event bounds, with bounded recurrence expansion.
      const busy: TimeRange[] = [];
      for await (const delta of this.sync(null)) {
        if (
          delta.kind === "event" &&
          delta.op === "upsert" &&
          delta.event.status !== "cancelled" &&
          delta.event.myStatus !== "declined"
        ) {
          if (delta.event.recurrenceRule) {
            throw new NotImplementedError(
              "This CalDAV server has no free-busy REPORT; recurring availability cannot be calculated reliably",
            );
          }
          if (overlaps(delta.event, range)) {
            busy.push({
              start: delta.event.start > range.start ? delta.event.start : range.start,
              end: delta.event.end < range.end ? delta.event.end : range.end,
            });
          }
        }
      }
      return busy;
    }
  }
}
