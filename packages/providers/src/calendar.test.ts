import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CalDavCalendarProvider, normalizeIcalendar } from "./caldav.js";
import {
  GoogleCalendarProvider,
  type GoogleEvent,
  normalizeGoogleEvent,
} from "./google-calendar.js";
import { GraphCalendarProvider, type GraphEvent, normalizeGraphEvent } from "./graph-calendar.js";
import {
  account,
  collect,
  eventInput,
  fixtureFetch,
  jsonBody,
  lastCursor,
  range,
  response,
} from "./test/helpers.js";
import { parseXml, xmlEscape } from "./xml.js";

const google: GoogleEvent = {
  id: "g-event",
  summary: "Review",
  start: { dateTime: eventInput.start },
  end: { dateTime: eventInput.end },
  status: "confirmed",
  updated: "2026-01-15T00:00:00Z",
  attendees: [{ email: account.emailAddress, responseStatus: "needsAction", self: true }],
  organizer: { email: "sam@example.com" },
  recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
};
const graph: GraphEvent = {
  id: "ms-event",
  subject: "Review",
  start: { dateTime: "2026-01-20T14:00:00", timeZone: "UTC" },
  end: { dateTime: "2026-01-20T15:00:00", timeZone: "UTC" },
  responseStatus: { response: "notResponded" },
  attendees: [
    { emailAddress: { address: account.emailAddress }, status: { response: "notResponded" } },
  ],
  lastModifiedDateTime: "2026-01-15T00:00:00Z",
};
const ics = readFileSync(new URL("./fixtures/event.ics", import.meta.url), "utf8");

describe("calendar normalization", () => {
  it("normalizes Google all-day dates in the calendar's timezone", () => {
    const e = normalizeGoogleEvent(
      { ...google, start: { date: "2026-01-20" }, end: { date: "2026-01-21" } },
      "a",
      "primary",
      account.emailAddress,
      "America/New_York",
    );
    expect(e.allDay).toBe(true);
    expect(e.start).toBe("2026-01-20T05:00:00.000Z");
    expect(e.end).toBe("2026-01-21T05:00:00.000Z");
    expect(e.recurrenceRule).toBe("FREQ=WEEKLY;COUNT=3");
  });
  it("normalizes Graph response states and UTC wall times", () => {
    const e = normalizeGraphEvent(
      { ...graph, responseStatus: { response: "tentativelyAccepted" } },
      "a",
      "default",
    );
    expect(e.myStatus).toBe("tentative");
    expect(e.start).toBe(eventInput.start);
  });
  it("normalizes iCalendar TZID dates, attendees, descriptions, and recurrence", () => {
    const [e] = normalizeIcalendar(
      ics,
      "a",
      "calendar",
      "https://dav.example/calendar/review.ics",
      account.emailAddress,
    );
    expect(e?.start).toBe("2026-01-20T14:00:00.000Z");
    expect(e?.end).toBe("2026-01-20T15:00:00.000Z");
    expect(e?.description).toContain("\n");
    expect(e?.myStatus).toBe("needs-action");
    expect(e?.recurrenceRule).toBe("FREQ=WEEKLY;COUNT=3");
  });
  it("preserves recurrence overrides as separate opaque provider identities", () => {
    const extra = ics.replace(
      "END:VCALENDAR",
      "BEGIN:VEVENT\nUID:review@example.com\nRECURRENCE-ID:20260127T140000Z\nDTSTART:20260127T160000Z\nDTEND:20260127T170000Z\nSUMMARY:Moved review\nEND:VEVENT\nEND:VCALENDAR",
    );
    const events = normalizeIcalendar(
      extra,
      "a",
      "calendar",
      "https://dav.example/calendar/review.ics",
      account.emailAddress,
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.providerId).not.toBe(events[1]?.providerId);
  });
  it("rejects DTDs and malformed WebDAV XML", () => {
    expect(() =>
      parseXml('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private">]><x>&secret;</x>'),
    ).toThrow(expect.objectContaining({ code: "INVALID_XML" }));
    expect(() => parseXml("<root><child></root>")).toThrow();
  });
});

describe("Google Calendar adapter", () => {
  it("paginates sync tokens and cancelled event tombstones", async () => {
    let incremental = false;
    const p = new GoogleCalendarProvider({
      fetch: fixtureFetch((url) => {
        if (url.pathname.endsWith("/calendarList"))
          return response({
            items: [
              { id: account.emailAddress, summary: "Personal", primary: true, timeZone: "UTC" },
            ],
          });
        if (incremental) {
          expect(url.searchParams.get("syncToken")).toBe("sync-1");
          return response({ items: [], nextSyncToken: "sync-2" });
        }
        return response(
          url.searchParams.has("pageToken")
            ? { items: [{ id: "gone", status: "cancelled" }], nextSyncToken: "sync-1" }
            : { items: [google], nextPageToken: "page2" },
        );
      }),
    });
    await p.connect(account, { access_token: "token" });
    const calendars = await p.listCalendars(),
      deltas = await collect(p.sync(null, range)),
      cursor = lastCursor(deltas);
    expect(cursor).toBe("sync-1");
    expect(deltas).toContainEqual({ kind: "event", op: "delete", providerId: "gone" });
    const first = deltas.find((d) => d.kind === "event" && d.op === "upsert");
    expect(first?.kind === "event" && first.op === "upsert" && first.event.calendarId).toBe(
      calendars[0]?.id,
    );
    incremental = true;
    expect(lastCursor(await collect(p.sync(cursor)))).toBe("sync-2");
  });
  it("supports create/patch/delete, attendee response, and free/busy", async () => {
    const mutations: Array<{ method: string; body: Record<string, unknown> }> = [];
    const p = new GoogleCalendarProvider({
      fetch: fixtureFetch((url, init) => {
        if (url.pathname.endsWith("/freeBusy"))
          return response({
            calendars: { primary: { busy: [{ start: eventInput.start, end: eventInput.end }] } },
          });
        if (init.method)
          mutations.push({ method: init.method, body: init.body ? jsonBody(init) : {} });
        return init.method === "DELETE" ? response(null, 204) : response(google);
      }),
    });
    await p.connect(account, { access_token: "token" });
    expect((await p.createEvent(eventInput)).title).toBe("Review");
    await p.updateEvent("g-event", { title: "Updated" });
    await p.respond("g-event", "accepted", "See you");
    await p.deleteEvent("g-event");
    expect(await p.freeBusy(range)).toEqual([{ start: eventInput.start, end: eventInput.end }]);
    expect(
      mutations.some(
        (m) =>
          m.method === "PATCH" &&
          (m.body.attendees as Array<{ responseStatus?: string }> | undefined)?.[0]
            ?.responseStatus === "accepted",
      ),
    ).toBe(true);
    expect(mutations.map((m) => m.method)).toContain("DELETE");
  });
  it("loads the calendar timezone for date-only events and retains it in patches", async () => {
    const allDay = { ...google, start: { date: "2026-01-20" }, end: { date: "2026-01-21" } };
    const p = new GoogleCalendarProvider({
      fetch: fixtureFetch((url, init) => {
        if (url.pathname.endsWith("/calendars/primary"))
          return response({ timeZone: "America/New_York" });
        if (init.method === "PATCH") {
          expect(jsonBody(init).start).toEqual({ date: "2026-01-22" });
          return response(allDay);
        }
        if (url.pathname.endsWith("/events"))
          return response({ items: [allDay], nextSyncToken: "token" });
        return response(allDay);
      }),
    });
    await p.connect(account, { access_token: "token" });
    const deltas = await collect(p.sync(null)),
      first = deltas.find((d) => d.kind === "event" && d.op === "upsert");
    expect(first?.kind === "event" && first.op === "upsert" && first.event.start).toBe(
      "2026-01-20T05:00:00.000Z",
    );
    await p.updateEvent("g-event", {
      start: "2026-01-22T05:00:00.000Z",
      end: "2026-01-23T05:00:00.000Z",
    });
  });
  it("reports expired sync tokens and free/busy per-calendar errors", async () => {
    const p = new GoogleCalendarProvider({
      fetch: fixtureFetch((url) =>
        url.pathname.endsWith("/freeBusy")
          ? response({ calendars: { primary: { errors: [{ reason: "forbidden" }] } } })
          : response({}, 410),
      ),
    });
    await p.connect(account, { access_token: "token" });
    await expect(collect(p.sync("expired"))).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await expect(p.freeBusy(range)).rejects.toMatchObject({ code: "FREEBUSY_FAILED" });
  });
});

describe("Graph Calendar adapter", () => {
  it("syncs partial delta records and tombstones within a cursor-bound time window", async () => {
    const p = new GraphCalendarProvider({
      fetch: fixtureFetch((url) => {
        if (url.pathname.endsWith("/calendarView/delta"))
          return response({
            value: [{ id: "ms-event" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/second-page",
          });
        if (url.pathname.endsWith("/second-page"))
          return response({
            value: [{ id: "gone", "@removed": {} }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-state",
          });
        if (url.pathname.endsWith("/calendar-state"))
          return response({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-state-2",
          });
        if (url.pathname.endsWith("/calendars"))
          return response({
            value: [{ id: "remote-calendar", name: "Primary", isDefaultCalendar: true }],
          });
        return response(graph);
      }),
    });
    await p.connect(account, { access_token: "token" });
    const calendars = await p.listCalendars(),
      deltas = await collect(p.sync(null, range)),
      cursor = lastCursor(deltas);
    expect(deltas).toContainEqual({ kind: "event", op: "delete", providerId: "gone" });
    const first = deltas.find((d) => d.kind === "event" && d.op === "upsert");
    expect(first?.kind === "event" && first.op === "upsert" && first.event.calendarId).toBe(
      calendars[0]?.id,
    );
    lastCursor(await collect(p.sync(cursor)));
    await expect(
      collect(p.sync(cursor, { ...range, end: "2027-01-01T00:00:00Z" })),
    ).rejects.toMatchObject({ code: "CURSOR_RANGE_MISMATCH" });
  });
  it("supports create/update/delete, RSVP methods, and getSchedule availability", async () => {
    const calls: string[] = [];
    const p = new GraphCalendarProvider({
      fetch: fixtureFetch((url, init) => {
        calls.push(`${init.method ?? "GET"} ${url.pathname}`);
        if (url.pathname.endsWith("/getSchedule"))
          return response({
            value: [
              {
                scheduleItems: [
                  { status: "busy", start: graph.start, end: graph.end },
                  { status: "free", start: graph.start, end: graph.end },
                ],
              },
            ],
          });
        if (init.method === "DELETE" || /\/(accept|decline|tentativelyAccept)$/.test(url.pathname))
          return response(null, 204);
        return response(graph);
      }),
    });
    await p.connect(account, { access_token: "token" });
    await p.createEvent(eventInput);
    await p.updateEvent("ms-event", { title: "Updated" });
    for (const status of ["accepted", "declined", "tentative"] as const)
      await p.respond("ms-event", status);
    await p.deleteEvent("ms-event");
    expect(await p.freeBusy(range)).toEqual([{ start: eventInput.start, end: eventInput.end }]);
    expect(calls).toContain("POST /v1.0/me/events/ms-event/tentativelyAccept");
  });
  it("clearly rejects unsupported recurrence writes, needs-action responses, and secondary delta", async () => {
    const p = new GraphCalendarProvider();
    await p.connect(account, { access_token: "token" });
    await expect(
      p.createEvent({ ...eventInput, recurrenceRule: "FREQ=WEEKLY" }),
    ).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(p.respond("id", "needs-action")).rejects.toMatchObject({
      code: "UNSUPPORTED_RESPONSE",
    });
    const q = new GraphCalendarProvider();
    await q.connect(
      { ...account, settings: { calendarId: "secondary" } },
      { access_token: "token" },
    );
    await expect(collect(q.sync(null, range))).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
  it("reports an expired delta and unsupported getSchedule service responses", async () => {
    const p = new GraphCalendarProvider({
      fetch: fixtureFetch((url) =>
        url.pathname.endsWith("/getSchedule")
          ? response({ value: [{ error: { message: "private" } }] })
          : response({}, 410),
      ),
    });
    await p.connect(account, { access_token: "token" });
    await expect(collect(p.sync(null, range))).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await expect(p.freeBusy(range)).rejects.toMatchObject({ code: "FREEBUSY_FAILED" });
  });
});

function davServer(
  options: { syncTokens?: boolean; freeBusy?: boolean; failWrites?: boolean } = {},
) {
  const collection = "https://dav.example/calendars/alex/",
    href = `${collection}review.ics`;
  const resources = new Map<string, string>([[href, ics]]),
    deleted: string[] = [],
    requests: Array<{ method: string; body: string; headers: Headers }> = [];
  let revision = 1;
  const propfind = () =>
    `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${collection}</d:href><d:propstat><d:prop><d:displayname>Personal &amp; Work</d:displayname>${options.syncTokens === false ? "" : `<d:sync-token>token-${revision}</d:sync-token>`}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
  const multistatus = (includeData: boolean) =>
    `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${[...resources].map(([url, data]) => `<d:response><d:href>${xmlEscape(url)}</d:href><d:propstat><d:prop><d:getetag>"etag-${revision}"</d:getetag>${includeData ? `<c:calendar-data><![CDATA[${data}]]></c:calendar-data>` : ""}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}${deleted.map((url) => `<d:response><d:href>${xmlEscape(url)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`).join("")}<d:sync-token>token-${revision}</d:sync-token></d:multistatus>`;
  const fetcher = fixtureFetch((url, init) => {
    const method = init.method ?? "GET",
      body = String(init.body ?? ""),
      headers = new Headers(init.headers);
    requests.push({ method, body, headers });
    if (method === "PROPFIND") return response(propfind(), 207);
    if (method === "REPORT") {
      if (body.includes("free-busy-query"))
        return options.freeBusy === false
          ? response("unsupported", 405)
          : response(
              "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VFREEBUSY\r\nFREEBUSY:20260120T140000Z/20260120T150000Z\r\nEND:VFREEBUSY\r\nEND:VCALENDAR\r\n",
            );
      return response(multistatus(body.includes("calendar-query")), 207);
    }
    if (["PUT", "DELETE"].includes(method)) {
      if (options.failWrites) return response("private conflict detail", 412);
      if (method === "PUT") resources.set(url.href, body);
      else {
        resources.delete(url.href);
        deleted.push(url.href);
      }
      revision++;
      return response(null, 204);
    }
    const data = resources.get(url.href);
    return data ? response(data, 200, { etag: `"etag-${revision}"` }) : response("missing", 404);
  });
  return {
    collection,
    href,
    resources,
    fetcher,
    requests,
    change: () => {
      revision++;
    },
  };
}

describe("CalDAV adapter", () => {
  it("queries a collection, consumes sync-collection tokens, and deletes known resource identities", async () => {
    const server = davServer(),
      p = new CalDavCalendarProvider({ fetch: server.fetcher });
    await p.connect(
      { ...account, settings: { calendarUrl: server.collection } },
      { password: "secret" },
    );
    expect((await p.listCalendars())[0]?.name).toBe("Personal & Work");
    const initial = await collect(p.sync(null)),
      cursor = lastCursor(initial);
    expect(initial.filter((d) => d.kind === "event")).toHaveLength(1);
    server.resources.set(server.href, ics.replace("Design review", "Updated review"));
    server.change();
    const changes = await collect(p.sync(cursor));
    expect(
      changes.some(
        (d) => d.kind === "event" && d.op === "upsert" && d.event.title === "Updated review",
      ),
    ).toBe(true);
    const e = changes.find((d) => d.kind === "event" && d.op === "upsert");
    if (e?.kind !== "event" || e.op !== "upsert") throw new Error("No event");
    await p.deleteEvent(e.event.providerId);
    const deleted = await collect(p.sync(lastCursor(changes)));
    expect(deleted).toContainEqual({ kind: "event", op: "delete", providerId: e.event.providerId });
    lastCursor(deleted);
    expect(server.requests.some((r) => r.body.includes("sync-collection"))).toBe(true);
  });
  it("writes iCalendar events with conditional PUTs, updates attendees, and deletes resources", async () => {
    const server = davServer(),
      p = new CalDavCalendarProvider({ fetch: server.fetcher });
    await p.connect(
      { ...account, settings: { calendarUrl: server.collection } },
      { password: "secret" },
    );
    const e = await p.createEvent(eventInput);
    expect(e.title).toBe("Review");
    expect(server.requests.find((r) => r.method === "PUT")?.headers.get("If-None-Match")).toBe("*");
    const updated = await p.updateEvent(e.providerId, { title: "Updated" });
    expect(updated.title).toBe("Updated");
    await p.respond(e.providerId, "accepted", "See you");
    expect(
      server.requests.some(
        (r) =>
          r.method === "PUT" && r.body.includes("PARTSTAT=ACCEPTED") && r.headers.has("If-Match"),
      ),
    ).toBe(true);
    await p.deleteEvent(e.providerId);
    expect(server.requests.some((r) => r.method === "DELETE" && r.headers.has("If-Match"))).toBe(
      true,
    );
  });
  it("supports CalDAV free-busy REPORTs", async () => {
    const server = davServer(),
      p = new CalDavCalendarProvider({ fetch: server.fetcher });
    await p.connect(
      { ...account, settings: { calendarUrl: server.collection } },
      { token: "token" },
    );
    expect(await p.freeBusy(range)).toEqual([{ start: eventInput.start, end: eventInput.end }]);
  });
  it("uses ETag scans without sync tokens and detects removed resources", async () => {
    const server = davServer({ syncTokens: false }),
      p = new CalDavCalendarProvider({ fetch: server.fetcher });
    await p.connect(
      { ...account, settings: { calendarUrl: server.collection } },
      { password: "secret" },
    );
    const cursor = lastCursor(await collect(p.sync(null)));
    server.resources.delete(server.href);
    const changes = await collect(p.sync(cursor));
    expect(changes.some((d) => d.kind === "event" && d.op === "delete")).toBe(true);
    lastCursor(changes);
  });
  it("falls back to event bounds for free/busy, refusing unexpanded recurrence", async () => {
    const server = davServer({ freeBusy: false }),
      p = new CalDavCalendarProvider({ fetch: server.fetcher });
    await p.connect(
      { ...account, settings: { calendarUrl: server.collection } },
      { password: "secret" },
    );
    await expect(p.freeBusy(range)).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    server.resources.set(server.href, ics.replace(/RRULE:[^\n]+\n/, ""));
    expect(await p.freeBusy(range)).toEqual([{ start: eventInput.start, end: eventInput.end }]);
  });
  it("preserves conflict errors and rejects external collection resources", async () => {
    const server = davServer({ failWrites: true }),
      p = new CalDavCalendarProvider({ fetch: server.fetcher });
    await p.connect(
      { ...account, settings: { calendarUrl: server.collection } },
      { password: "secret" },
    );
    await expect(p.createEvent(eventInput)).rejects.toMatchObject({ code: "HTTP_412" });
    const q = new CalDavCalendarProvider({
      fetch: fixtureFetch(() =>
        response(
          '<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://evil.example/x.ics</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
          207,
        ),
      ),
    });
    await q.connect(
      { ...account, settings: { calendarUrl: server.collection } },
      { password: "secret" },
    );
    await expect(collect(q.sync(null))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
