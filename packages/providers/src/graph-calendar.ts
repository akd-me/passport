import type { Calendar, CalendarEvent, CalendarProvider, ParticipationStatus, TimeRange } from "@passport/types";
import { decodeCursor, encodeCursor, localId, NotImplementedError, ProviderError, required } from "./errors.js";
import { graphStatus, localDate, validateEvent, validateRange, zonedToUtc } from "./calendar-common.js";
import { HttpConnection, type ProviderOptions } from "./http.js";
import { graphBase, type GraphAddress, type GraphPage } from "./graph.js";
import { htmlToText, toIso } from "./normalize/index.js";
import type { CalendarDelta, EventInput } from "./mock.js";

interface GraphDate { dateTime: string; timeZone?: string }
export interface GraphEvent {
  id: string; subject?: string; body?: { contentType: string; content: string }; location?: { displayName?: string }; start?: GraphDate; end?: GraphDate;
  isAllDay?: boolean; isCancelled?: boolean; showAs?: string; organizer?: GraphAddress;
  attendees?: Array<GraphAddress & { type?: string; status?: { response?: string } }>; responseStatus?: { response?: string };
  lastModifiedDateTime?: string; recurrence?: unknown; "@removed"?: unknown;
}

export function normalizeGraphEvent(event: GraphEvent, accountId: string, calendarId: string): CalendarEvent {
  if (!event.start || !event.end) throw new ProviderError("INVALID_RESPONSE", "Graph event is missing start or end");
  return { id: localId(accountId, "event", event.id), accountId, calendarId: localId(accountId, "calendar", calendarId), providerId: event.id, title: event.subject ?? "",
    description: event.body?.contentType.toLowerCase() === "html" ? htmlToText(event.body.content) : event.body?.content ?? null, location: event.location?.displayName ?? null,
    start: zonedToUtc(event.start.dateTime, event.start.timeZone ?? "UTC"), end: zonedToUtc(event.end.dateTime, event.end.timeZone ?? "UTC"), timeZone: event.start.timeZone ?? "UTC", allDay: event.isAllDay ?? false,
    status: event.isCancelled ? "cancelled" : event.showAs === "tentative" ? "tentative" : "confirmed", organizer: event.organizer ? { email: event.organizer.emailAddress.address.toLowerCase(), ...(event.organizer.emailAddress.name ? { name: event.organizer.emailAddress.name } : {}) } : null,
    participants: (event.attendees ?? []).map(a => ({ email: a.emailAddress.address.toLowerCase(), ...(a.emailAddress.name ? { name: a.emailAddress.name } : {}), status: graphStatus(a.status?.response), role: a.type === "optional" ? "optional" : "attendee" })),
    myStatus: graphStatus(event.responseStatus?.response), recurrenceRule: null, updatedAt: toIso(event.lastModifiedDateTime ?? 0) };
}

export class GraphCalendarProvider extends HttpConnection implements CalendarProvider {
  readonly kind = "graph-calendar" as const;
  constructor(options: ProviderOptions = {}) { super(options, "microsoft"); }
  private get calendarId(): string { this.check(); return String(this.account.settings.calendarId ?? "default"); }
  private get path(): string { return this.calendarId === "default" ? `${graphBase}/me/calendar` : `${graphBase}/me/calendars/${encodeURIComponent(this.calendarId)}`; }
  private async api<T>(url: string, init: RequestInit = {}): Promise<T> { return this.json<T>(this.safeLink(url, graphBase), { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' } }); }
  private async empty(url: string, init: RequestInit): Promise<void> { await this.http(this.safeLink(url, graphBase), { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Prefer: 'outlook.timezone="UTC", IdType="ImmutableId"' } }); }
  async listCalendars(): Promise<Calendar[]> {
    const out: Calendar[] = []; let link: string | undefined = `${graphBase}/me/calendars`;
    while (link) {
      const page: GraphPage<{ id: string; name: string; isDefaultCalendar?: boolean }> = await this.api(link);
      out.push(...(page.value ?? []).map(c => { const id = this.calendarId === "default" && c.isDefaultCalendar ? "default" : c.id; return { id: localId(this.account.id, "calendar", id), accountId: this.account.id, providerId: id, name: c.name, isPrimary: c.isDefaultCalendar ?? false, timeZone: "UTC" }; }));
      link = page["@odata.nextLink"];
    } return out;
  }
  async *sync(cursor: string | null, range?: TimeRange): AsyncIterable<CalendarDelta> {
    this.check();
    const saved = cursor ? decodeCursor<{ account: string; calendar: string; link: string; range: TimeRange }>(cursor) : null;
    if (saved && (saved.account !== this.account.id || saved.calendar !== this.calendarId)) throw new ProviderError("INVALID_CURSOR", "Graph cursor belongs to another calendar");
    const window = range ?? saved?.range ?? { start: new Date(this.now().getTime() - 30 * 86400_000).toISOString(), end: new Date(this.now().getTime() + 365 * 86400_000).toISOString() };
    validateRange(window);
    if (saved && (window.start !== saved.range.start || window.end !== saved.range.end)) throw new ProviderError("CURSOR_RANGE_MISMATCH", "Start a full Graph calendar sync when changing its time window");
    if (this.calendarId !== "default") throw new NotImplementedError("Graph v1.0 calendarView delta supports the primary calendar only; leave calendarId unset");
    let link: string | undefined = saved?.link ?? `${graphBase}/me/calendarView/delta?${new URLSearchParams({ startDateTime: window.start, endDateTime: window.end })}`, state: string | undefined;
    while (link) {
      let page: GraphPage<GraphEvent>;
      try { page = await this.api(link); }
      catch (e) { if (e instanceof ProviderError && e.status === 410) throw new ProviderError("CURSOR_EXPIRED", "Graph calendar delta expired; reset local calendar state and resync"); throw e; }
      for (const event of page.value ?? []) {
        if (event["@removed"] || event.isCancelled) yield { kind: "event", op: "delete", providerId: event.id };
        else {
          // Delta events can be partial. Fetch the complete record before normalizing.
          const full = await this.api<GraphEvent>(`${graphBase}/me/events/${encodeURIComponent(event.id)}`);
          yield { kind: "event", op: "upsert", event: normalizeGraphEvent(full, this.account.id, this.calendarId) };
        }
      }
      state = page["@odata.deltaLink"]; link = page["@odata.nextLink"];
    }
    yield { kind: "cursor", cursor: encodeCursor({ account: this.account.id, calendar: this.calendarId, link: this.safeLink(required(state, "Graph calendar deltaLink"), graphBase), range: window }) };
  }
  private eventBody(input: Partial<CalendarEvent>): Record<string, unknown> {
    validateEvent(input); const out: Record<string, unknown> = {};
    if (input.recurrenceRule) throw new NotImplementedError("Graph recurrence writes require a Graph pattern/range; RRULE conversion is not implemented");
    if (input.title !== undefined) out.subject = input.title;
    if (input.description !== undefined) out.body = { contentType: "Text", content: input.description ?? "" };
    if (input.location !== undefined) out.location = { displayName: input.location ?? "" };
    for (const key of ["start", "end"] as const) if (input[key]) out[key] = input.allDay ? { dateTime: `${localDate(input[key], input.timeZone ?? "UTC")}T00:00:00`, timeZone: input.timeZone ?? "UTC" } : { dateTime: toIso(input[key]).replace(/Z$/, ""), timeZone: "UTC" };
    if (input.allDay !== undefined) out.isAllDay = input.allDay;
    if (input.participants) out.attendees = input.participants.filter(p => p.role !== "organizer").map(p => ({ emailAddress: { address: p.email, name: p.name ?? "" }, type: p.role === "optional" ? "optional" : "required" }));
    if (input.status === "cancelled") throw new ProviderError("UNSUPPORTED_UPDATE", "Use deleteEvent to cancel a Graph event");
    if (input.status) out.showAs = input.status === "tentative" ? "tentative" : "busy";
    return out;
  }
  async createEvent(input: EventInput): Promise<CalendarEvent> {
    this.check();
    if (input.accountId !== this.account.id) throw new ProviderError("ACCOUNT_MISMATCH", "Event belongs to another account");
    return normalizeGraphEvent(await this.api<GraphEvent>(`${this.path}/events`, this.body(this.eventBody(input))), this.account.id, this.calendarId);
  }
  async updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> { return normalizeGraphEvent(await this.api<GraphEvent>(`${graphBase}/me/events/${encodeURIComponent(id)}`, this.body(this.eventBody(patch), "PATCH")), this.account.id, this.calendarId); }
  async deleteEvent(id: string): Promise<void> { await this.empty(`${graphBase}/me/events/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  async respond(id: string, status: ParticipationStatus, comment?: string): Promise<void> {
    const method = ({ accepted: "accept", declined: "decline", tentative: "tentativelyAccept" } as Partial<Record<ParticipationStatus, string>>)[status];
    if (!method) throw new ProviderError("UNSUPPORTED_RESPONSE", "Graph cannot reset a response to needs-action");
    await this.empty(`${graphBase}/me/events/${encodeURIComponent(id)}/${method}`, this.body({ comment: comment ?? "", sendResponse: true }));
  }
  async freeBusy(range: TimeRange): Promise<TimeRange[]> {
    this.check();
    validateRange(range);
    const result = await this.api<{ value?: Array<{ error?: unknown; scheduleItems?: Array<{ status: string; start: GraphDate; end: GraphDate }> }> }>(`${graphBase}/me/calendar/getSchedule`, this.body({ schedules: [this.account.emailAddress], startTime: { dateTime: toIso(range.start).replace(/Z$/, ""), timeZone: "UTC" }, endTime: { dateTime: toIso(range.end).replace(/Z$/, ""), timeZone: "UTC" }, availabilityViewInterval: 30 }));
    if (!result.value?.length || result.value.some(v => v.error)) throw new ProviderError("FREEBUSY_FAILED", "Graph could not return calendar availability");
    return result.value.flatMap(v => (v.scheduleItems ?? []).filter(i => i.status !== "free").map(i => ({ start: zonedToUtc(i.start.dateTime, i.start.timeZone), end: zonedToUtc(i.end.dateTime, i.end.timeZone) })));
  }
}
