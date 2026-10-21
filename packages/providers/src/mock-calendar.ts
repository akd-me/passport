import type {
  Account,
  AccountCredentials,
  Calendar,
  CalendarEvent,
  CalendarProvider,
  ParticipationStatus,
  TimeRange,
} from "@passport/types";
import { validateEvent, validateRange } from "./calendar-common.js";
import { decodeCursor, encodeCursor, localId, ProviderError } from "./errors.js";
import { clone, fixtureEpoch } from "./mock-fixtures.js";
import { toIso } from "./normalize/index.js";

export type CalendarDelta =
  | { kind: "event"; op: "upsert"; event: CalendarEvent }
  | { kind: "event"; op: "delete"; providerId: string }
  | { kind: "cursor"; cursor: string };

export type EventInput = Omit<CalendarEvent, "id" | "providerId" | "updatedAt">;

/** In-memory calendar with deterministic events and revision cursors. */
export class MockCalendarProvider implements CalendarProvider {
  readonly kind = "mock" as const;
  private account?: Account;
  private connected = false;
  private events = new Map<string, CalendarEvent>();
  private changes: CalendarDelta[] = [];
  private sequence = 0;
  async connect(account: Account, _credentials: AccountCredentials = {}): Promise<void> {
    if (this.account && this.account.id !== account.id) {
      throw new ProviderError("ACCOUNT_MISMATCH", "Use a separate mock instance per account");
    }
    const first = !this.account;
    this.account = clone(account);
    this.connected = true;
    if (first) {
      for (let i = 0; i < 6; i++) {
        await this.createEvent({
          accountId: account.id,
          calendarId: localId(account.id, "calendar", "primary"),
          title: [
            "Design review",
            "Coffee with Sam",
            "Planning",
            "Dentist",
            "Reading group",
            "Project demo",
          ][i]!,
          start: new Date(fixtureEpoch + i * 86400_000).toISOString(),
          end: new Date(fixtureEpoch + i * 86400_000 + 3600_000).toISOString(),
          allDay: false,
          status: "confirmed",
          participants: [{ email: account.emailAddress, status: "accepted" }],
          myStatus: "accepted",
        });
      }
    }
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  private check(): Account {
    if (!this.account || !this.connected) {
      throw new ProviderError("NOT_CONNECTED", "Connect the mock calendar first");
    }
    return this.account;
  }
  async listCalendars(): Promise<Calendar[]> {
    const a = this.check();
    return [
      {
        id: localId(a.id, "calendar", "primary"),
        accountId: a.id,
        providerId: "primary",
        name: "Personal",
        isPrimary: true,
        timeZone: "UTC",
      },
    ];
  }
  async *sync(cursor: string | null, _range?: TimeRange): AsyncIterable<CalendarDelta> {
    const a = this.check(),
      end = this.changes.length;
    const c = cursor
      ? decodeCursor<{ account: string; revision: number }>(cursor)
      : { account: a.id, revision: 0 };
    if (c.account !== a.id || !Number.isInteger(c.revision) || c.revision < 0 || c.revision > end) {
      throw new ProviderError("INVALID_CURSOR", "Invalid mock calendar cursor");
    }
    const events = cursor
      ? this.changes.slice(c.revision, end)
      : [...this.events.values()].map((event) => ({ kind: "event", op: "upsert", event }) as const);
    // Sync a complete collection; moving an event out of a display window must reach the store.
    for (const delta of clone(events)) {
      yield delta;
    }
    yield { kind: "cursor", cursor: encodeCursor({ account: a.id, revision: end }) };
  }
  async createEvent(input: EventInput): Promise<CalendarEvent> {
    const a = this.check();
    if (input.accountId !== a.id) {
      throw new ProviderError("ACCOUNT_MISMATCH", "Event belongs to another account");
    }
    validateEvent(input);
    const providerId = `event-${++this.sequence}`,
      event: CalendarEvent = {
        ...clone(input),
        id: localId(a.id, "event", providerId),
        providerId,
        start: toIso(input.start),
        end: toIso(input.end),
        updatedAt: new Date(fixtureEpoch + this.sequence * 1000).toISOString(),
      };
    this.events.set(providerId, event);
    this.changes.push({ kind: "event", op: "upsert", event: clone(event) });
    return clone(event);
  }
  async updateEvent(providerId: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent> {
    this.check();
    const previous = this.events.get(providerId);
    if (!previous) {
      throw new ProviderError("NOT_FOUND", "Mock event does not exist");
    }
    const event = {
      ...previous,
      ...clone(patch),
      id: previous.id,
      accountId: previous.accountId,
      providerId,
      updatedAt: new Date(fixtureEpoch + ++this.sequence * 1000).toISOString(),
    };
    validateEvent(event);
    event.start = toIso(event.start);
    event.end = toIso(event.end);
    this.events.set(providerId, event);
    this.changes.push({ kind: "event", op: "upsert", event: clone(event) });
    return clone(event);
  }
  async deleteEvent(providerId: string): Promise<void> {
    this.check();
    if (!this.events.delete(providerId)) {
      throw new ProviderError("NOT_FOUND", "Mock event does not exist");
    }
    this.changes.push({ kind: "event", op: "delete", providerId });
  }
  async respond(providerId: string, status: ParticipationStatus): Promise<void> {
    const a = this.check(),
      event = this.events.get(providerId);
    if (!event) {
      throw new ProviderError("NOT_FOUND", "Mock event does not exist");
    }
    await this.updateEvent(providerId, {
      myStatus: status,
      participants: event.participants.map((p) =>
        p.email.toLowerCase() === a.emailAddress.toLowerCase() ? { ...p, status } : p,
      ),
    });
  }
  async freeBusy(range: TimeRange): Promise<TimeRange[]> {
    this.check();
    validateRange(range);
    return [...this.events.values()]
      .filter((e) => e.status !== "cancelled" && e.myStatus !== "declined" && overlaps(e, range))
      .map((e) => ({
        start: e.start > range.start ? e.start : range.start,
        end: e.end < range.end ? e.end : range.end,
      }));
  }
}

export function overlaps(event: TimeRange, range: TimeRange): boolean {
  return (
    Date.parse(event.start) < Date.parse(range.end) &&
    Date.parse(event.end) > Date.parse(range.start)
  );
}
