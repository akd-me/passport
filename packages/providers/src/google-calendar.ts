import type {
  Calendar,
  CalendarEvent,
  CalendarProvider,
  ParticipationStatus,
  TimeRange,
} from "@passport/types";
import { localDate, validateEvent, validateRange, zonedToUtc } from "./calendar-common.js";
import { localId, ProviderError, required } from "./errors.js";
import { HttpConnection, type ProviderOptions } from "./http.js";
import type { CalendarDelta, EventInput } from "./mock.js";
import { toIso } from "./normalize/index.js";

interface GoogleDate {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}
export interface GoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleDate;
  end?: GoogleDate;
  status?: string;
  organizer?: { email?: string; displayName?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    optional?: boolean;
    organizer?: boolean;
    self?: boolean;
  }>;
  recurrence?: string[];
  updated?: string;
}
const base = "https://www.googleapis.com/calendar/v3";
const fromGoogle = (v?: string): ParticipationStatus =>
  (
    ({
      accepted: "accepted",
      declined: "declined",
      tentative: "tentative",
      needsAction: "needs-action",
    }) as Record<string, ParticipationStatus>
  )[v ?? ""] ?? "needs-action";
const toGoogle = (v: ParticipationStatus): string => (v === "needs-action" ? "needsAction" : v);

export function normalizeGoogleEvent(
  event: GoogleEvent,
  accountId: string,
  calendarId: string,
  owner: string,
  zone = "UTC",
): CalendarEvent {
  if (!event.start || !event.end) {
    throw new ProviderError("INVALID_RESPONSE", "Google event is missing start or end");
  }
  const timeZone = event.start.timeZone ?? zone;
  return {
    id: localId(accountId, "event", event.id),
    accountId,
    providerId: event.id,
    calendarId: localId(accountId, "calendar", calendarId),
    title: event.summary ?? "",
    description: event.description ?? null,
    location: event.location ?? null,
    start: zonedToUtc(required(event.start.dateTime ?? event.start.date, "event start"), timeZone),
    end: zonedToUtc(
      required(event.end.dateTime ?? event.end.date, "event end"),
      event.end.timeZone ?? timeZone,
    ),
    timeZone,
    allDay: Boolean(event.start.date),
    status:
      event.status === "cancelled"
        ? "cancelled"
        : event.status === "tentative"
          ? "tentative"
          : "confirmed",
    organizer: event.organizer?.email
      ? {
          email: event.organizer.email.toLowerCase(),
          ...(event.organizer.displayName ? { name: event.organizer.displayName } : {}),
        }
      : null,
    participants: (event.attendees ?? []).map((a) => ({
      email: a.email.toLowerCase(),
      ...(a.displayName ? { name: a.displayName } : {}),
      status: fromGoogle(a.responseStatus),
      role: a.organizer ? "organizer" : a.optional ? "optional" : "attendee",
    })),
    myStatus: fromGoogle(
      event.attendees?.find((a) => a.self || a.email.toLowerCase() === owner.toLowerCase())
        ?.responseStatus,
    ),
    recurrenceRule: event.recurrence?.find((r) => r.startsWith("RRULE:"))?.slice(6) ?? null,
    updatedAt: toIso(event.updated ?? 0),
  };
}

export class GoogleCalendarProvider extends HttpConnection implements CalendarProvider {
  readonly kind = "google-calendar" as const;
  private calendarZone?: string;
  constructor(options: ProviderOptions = {}) {
    super(options, "google");
  }
  override async disconnect(): Promise<void> {
    this.calendarZone = undefined;
    await super.disconnect();
  }
  private get calendarId(): string {
    this.check();
    return String(this.account.settings.calendarId ?? "primary");
  }
  private get calendarPath(): string {
    return `${base}/calendars/${encodeURIComponent(this.calendarId)}`;
  }
  private async normalize(event: GoogleEvent): Promise<CalendarEvent> {
    if (event.start?.date && !this.calendarZone && !this.account.settings.timeZone) {
      this.calendarZone = required(
        (await this.json<{ timeZone: string }>(this.calendarPath)).timeZone,
        "Google calendar timeZone",
      );
    }
    return normalizeGoogleEvent(
      event,
      this.account.id,
      this.calendarId,
      this.account.emailAddress,
      String(this.account.settings.timeZone ?? this.calendarZone ?? "UTC"),
    );
  }
  async listCalendars(): Promise<Calendar[]> {
    // calendar.events permits event feeds, but not users/me/calendarList.
    if (
      this.credentials.scope &&
      !this.credentials.scope
        .split(" ")
        .some((s) =>
          [
            "https://www.googleapis.com/auth/calendar",
            "https://www.googleapis.com/auth/calendar.readonly",
            "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          ].includes(s),
        )
    ) {
      const feed = await this.json<{ summary?: string; timeZone?: string }>(
        `${this.calendarPath}/events?maxResults=1`,
      );
      this.calendarZone = feed.timeZone;
      return [
        {
          id: localId(this.account.id, "calendar", this.calendarId),
          accountId: this.account.id,
          providerId: this.calendarId,
          name: feed.summary ?? this.calendarId,
          isPrimary: this.calendarId === "primary",
          timeZone: feed.timeZone ?? null,
        },
      ];
    }
    const out: Calendar[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.json<{
        items?: Array<{ id: string; summary?: string; primary?: boolean; timeZone?: string }>;
        nextPageToken?: string;
      }>(`${base}/users/me/calendarList?${new URLSearchParams(pageToken ? { pageToken } : {})}`);
      out.push(
        ...(page.items ?? []).map((c) => {
          const id = this.calendarId === "primary" && c.primary ? "primary" : c.id;
          if (id === this.calendarId) {
            this.calendarZone = c.timeZone;
          }
          return {
            id: localId(this.account.id, "calendar", id),
            accountId: this.account.id,
            providerId: id,
            name: c.summary ?? c.id,
            isPrimary: c.primary ?? false,
            timeZone: c.timeZone ?? null,
          };
        }),
      );
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }
  async *sync(cursor: string | null, _range?: TimeRange): AsyncIterable<CalendarDelta> {
    // A complete collection is needed for a reusable syncToken. Range filtering would omit moved events.
    let pageToken: string | undefined, state: string | undefined;
    do {
      const params = new URLSearchParams({
        showDeleted: "true",
        maxResults: "250",
        ...(cursor ? { syncToken: cursor } : {}),
        ...(pageToken ? { pageToken } : {}),
      });
      let page: {
        items?: GoogleEvent[];
        timeZone?: string;
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      try {
        page = await this.json(`${this.calendarPath}/events?${params}`);
      } catch (e) {
        if (e instanceof ProviderError && e.status === 410) {
          throw new ProviderError(
            "CURSOR_EXPIRED",
            "Google Calendar sync token expired; reset local calendar state and resync",
          );
        }
        throw e;
      }
      this.calendarZone ??= page.timeZone;
      for (const event of page.items ?? []) {
        if (event.status === "cancelled") {
          yield { kind: "event", op: "delete", providerId: event.id };
        } else {
          yield { kind: "event", op: "upsert", event: await this.normalize(event) };
        }
      }
      state = page.nextSyncToken;
      pageToken = page.nextPageToken;
    } while (pageToken);
    yield { kind: "cursor", cursor: required(state, "Google Calendar nextSyncToken") };
  }
  private eventBody(input: Partial<CalendarEvent>): Record<string, unknown> {
    validateEvent(input);
    const out: Record<string, unknown> = {};
    if (input.title !== undefined) {
      out.summary = input.title;
    }
    for (const k of ["description", "location", "status"] as const) {
      if (input[k] !== undefined) {
        out[k] = input[k];
      }
    }
    for (const key of ["start", "end"] as const) {
      if (input[key]) {
        out[key] = input.allDay
          ? { date: localDate(input[key], input.timeZone ?? "UTC") }
          : {
              dateTime: toIso(input[key]),
              ...(input.timeZone ? { timeZone: input.timeZone } : {}),
            };
      }
    }
    if (input.participants) {
      out.attendees = input.participants
        .filter((p) => p.role !== "organizer")
        .map((p) => ({
          email: p.email,
          displayName: p.name,
          responseStatus: toGoogle(p.status),
          optional: p.role === "optional",
        }));
    }
    if (input.recurrenceRule !== undefined) {
      out.recurrence = input.recurrenceRule
        ? [`RRULE:${input.recurrenceRule.replace(/^RRULE:/, "")}`]
        : [];
    }
    return out;
  }
  async createEvent(event: EventInput): Promise<CalendarEvent> {
    this.check();
    if (event.accountId !== this.account.id) {
      throw new ProviderError("ACCOUNT_MISMATCH", "Event belongs to another account");
    }
    return this.normalize(
      await this.json<GoogleEvent>(
        `${this.calendarPath}/events?sendUpdates=all`,
        this.body(this.eventBody(event)),
      ),
    );
  }
  async updateEvent(providerId: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    if (patch.start || patch.end || patch.allDay !== undefined) {
      const existing = await this.normalize(
        await this.json<GoogleEvent>(
          `${this.calendarPath}/events/${encodeURIComponent(providerId)}`,
        ),
      );
      patch = {
        ...patch,
        start: patch.start ?? existing.start,
        end: patch.end ?? existing.end,
        allDay: patch.allDay ?? existing.allDay,
        timeZone: patch.timeZone ?? existing.timeZone,
      };
    }
    return this.normalize(
      await this.json<GoogleEvent>(
        `${this.calendarPath}/events/${encodeURIComponent(providerId)}?sendUpdates=all`,
        this.body(this.eventBody(patch), "PATCH"),
      ),
    );
  }
  async deleteEvent(providerId: string): Promise<void> {
    await this.http(
      `${this.calendarPath}/events/${encodeURIComponent(providerId)}?sendUpdates=all`,
      { method: "DELETE" },
    );
  }
  async respond(providerId: string, status: ParticipationStatus, comment?: string): Promise<void> {
    const event = await this.json<GoogleEvent>(
      `${this.calendarPath}/events/${encodeURIComponent(providerId)}`,
    );
    let found = false;
    const attendees = (event.attendees ?? []).map((attendee) => {
      const isOwner =
        attendee.self || attendee.email.toLowerCase() === this.account.emailAddress.toLowerCase();
      if (!isOwner) {
        return attendee;
      }
      found = true;
      return { ...attendee, responseStatus: toGoogle(status), ...(comment ? { comment } : {}) };
    });
    if (!found) {
      throw new ProviderError(
        "NOT_AN_ATTENDEE",
        "The account is not an attendee of this Google event",
      );
    }
    await this.http(
      `${this.calendarPath}/events/${encodeURIComponent(providerId)}?sendUpdates=all`,
      this.body({ attendees }, "PATCH"),
    );
  }
  async freeBusy(range: TimeRange): Promise<TimeRange[]> {
    validateRange(range);
    const result = await this.json<{
      calendars: Record<string, { busy?: TimeRange[]; errors?: unknown[] }>;
    }>(
      `${base}/freeBusy`,
      this.body({ timeMin: range.start, timeMax: range.end, items: [{ id: this.calendarId }] }),
    );
    const calendar = result.calendars[this.calendarId];
    if (!calendar || calendar.errors?.length) {
      throw new ProviderError("FREEBUSY_FAILED", "Google could not return calendar availability");
    }
    return (calendar.busy ?? []).map((r) => ({ start: toIso(r.start), end: toIso(r.end) }));
  }
}
