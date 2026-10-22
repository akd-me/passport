import { mkdir, mkdtemp, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
  mockCapabilities,
  ProviderError,
} from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import type { Account, MailReader, MailRow, Store } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "./accounts.js";
import { ARRIVAL_LIMITS, type DroppedCounts } from "./arrival-backlog.js";
import { ArrivalQueue } from "./arrivals.js";
import { createApp } from "./auth.test-client.js";
import { createRealBackend, type RealBackend } from "./compose.js";
import { defaultConfig } from "./config.js";
import { sweepExports } from "./ondemand-wiring.js";
import { createSyncIdentity } from "./sync/identity.js";
import { MailWatcher } from "./watch/watcher.js";

const start = Date.parse("2026-10-20T12:00:00.000Z");
const mk = (id: string): Account =>
  ({
    id,
    kind: "mock",
    displayName: id,
    emailAddress: `${id}@example.com`,
    capabilities: { ...mockCapabilities, calendar: false, push: false },
    settings: {},
    createdAt: new Date(start).toISOString(),
    updatedAt: new Date(start).toISOString(),
  }) as Account;

async function fixture(account: Account) {
  let clock = start;
  const store = openStore({ path: ":memory:" });
  await store.migrate();
  await store.accounts.upsert(account);
  const mail = new MockMailProvider({ now: () => new Date(clock) });
  await mail.connect(account);
  const bus = new InMemoryEventBus();
  const reader = mail.reader();
  const watcher = new MailWatcher({
    store,
    bus,
    readers: async () => reader,
    normalize: createSyncIdentity(store).email,
    now: () => clock,
  });
  return { store, mail, bus, watcher, reader, advance: (ms: number) => (clock += ms) };
}

const pending = async (store: Store) =>
  Object.keys(JSON.parse((await store.kv.get("arrival:pending")) ?? "{}"));

describe("R4 arrivals", () => {
  it("R4-11 the queue keeps only the newest arrivals while no model is configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = mk("acct");
    const { store, mail, bus, watcher, advance } = await fixture(account);
    const agent = { run: vi.fn() } as never;
    const reports: DroppedCounts[] = [];
    const queue = new ArrivalQueue(
      store,
      bus,
      agent,
      () => false,
      async (c) => {
        reports.push(c);
      },
    );
    await watcher.tick(account.id);
    const total = ARRIVAL_LIMITS.maxPending + 30;
    for (let i = 0; i < total; i += 23) {
      advance(30_000);
      for (let j = i; j < Math.min(total, i + 23); j++) {
        mail.injectEmail({
          providerId: `n${j}`,
          from: [{ email: "x@unknown.example", name: "X" }],
          mailboxIds: [`${account.id}:mailbox:Inbox`],
        });
      }
      await watcher.tick(account.id);
    }
    const ids = await pending(store);
    expect(ids).toHaveLength(ARRIVAL_LIMITS.maxPending);
    expect(ids).toContain(`${account.id}:email:n${total - 1}`);
    expect(ids).not.toContain(`${account.id}:email:n0`);
    expect(await store.kv.get(`arrival:${account.id}:email:n0`)).toBeNull();
    await queue.drainDue();
    expect(reports).toEqual([{ [account.id]: { backlog: 30 } }]);
  });

  it("R4-11 a never-attempted arrival older than 24 h is dropped, not triaged late", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = mk("acct");
    const { store, mail, bus, watcher, advance } = await fixture(account);
    await watcher.tick(account.id);
    advance(30_000);
    mail.injectEmail({
      providerId: "old",
      from: [{ email: "x@unknown.example" }],
      mailboxIds: [`${account.id}:mailbox:Inbox`],
    });
    await watcher.tick(account.id);
    const [id] = await pending(store);
    const entry = JSON.parse((await store.kv.get(`arrival:${id}`))!);
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await store.kv.set(`arrival:${id}`, JSON.stringify({ ...entry, createdAt: old }));
    const run = vi.fn();
    const reports: DroppedCounts[] = [];
    const queue = new ArrivalQueue(
      store,
      bus,
      { run } as never,
      () => true,
      async (c) => {
        reports.push(c);
      },
    );
    await queue.drainDue();
    await queue.drainDue();
    expect(run).not.toHaveBeenCalled();
    expect(await pending(store)).toEqual([]);
    expect(reports).toEqual([{ [account.id]: { backlog: 1 } }]);
  });

  it("R4-12 an arrival whose message is gone is dropped after one retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = mk("acct");
    const { store, mail, bus, reader, advance } = await fixture(account);
    let gone = false;
    let reads = 0;
    const wrapped = new Proxy(reader, {
      get: (t, p) =>
        p === "envelopes"
          ? async (ids: string[], o: unknown) => {
              reads++;
              const r = await t.envelopes(ids, o as never);
              return gone ? { ...r, value: new Map() } : r;
            }
          : typeof (t as never)[p] === "function"
            ? (t as never as Record<string | symbol, (...a: unknown[]) => unknown>)[p]!.bind(t)
            : (t as never)[p],
    }) as MailReader;
    store.setMailReaderResolver?.(async () => wrapped);
    const watcher = new MailWatcher({
      store,
      bus,
      readers: async () => wrapped,
      normalize: createSyncIdentity(store).email,
      now: () => start,
    });
    await watcher.tick(account.id);
    advance(30_000);
    mail.injectEmail({
      providerId: "doomed",
      from: [{ email: "x@unknown.example" }],
      mailboxIds: [`${account.id}:mailbox:Inbox`],
    });
    await watcher.tick(account.id);
    const [id] = await pending(store);
    gone = true;
    await store.emails.deleteMany([id!]);
    const run = vi.fn();
    const reports: DroppedCounts[] = [];
    const queue = new ArrivalQueue(
      store,
      bus,
      { run } as never,
      () => true,
      async (c) => {
        reports.push(c);
      },
    );
    const before = reads;
    for (let i = 0; i < 5; i++) {
      await queue.drainDue();
    }
    expect(await pending(store)).toEqual([]);
    expect(reads - before).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(reports).toEqual([{ [account.id]: { gone: 1 } }]);
  });
});

describe("R4 routes and maintenance", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((b) => b.close()));
    vi.restoreAllMocks();
  });

  async function twoAccounts(dataDir?: string) {
    const providers = createProviderRegistry();
    // One mock per account: a shared mock serves only the account it connected last.
    vi.spyOn(providers, "mail").mockImplementation(() => new MockMailProvider());
    vi.spyOn(providers, "calendar").mockReturnValue(new MockCalendarProvider());
    const config = { ...defaultConfig(), ...(dataDir ? { dataDir } : {}) };
    const backend = await createRealBackend(config, { storePath: ":memory:", providers });
    backends.push(backend);
    const a = await addAccount(backend, {
      kind: "mock",
      emailAddress: "a@example.com",
      fields: {},
    });
    const b = await addAccount(backend, {
      kind: "mock",
      emailAddress: "b@example.com",
      fields: {},
    });
    return { backend, a, b, app: createApp(backend) };
  }

  it("R4-13 GET /api/emails skips accounts that need sign-in or fail, and reports them", async () => {
    const { backend, a, b, app } = await twoAccounts();
    const readers = backend.readers!;
    const failing = async (id: string) => {
      const reader = await readers(id);
      return id === b.id
        ? ({
            ...reader,
            search: async () => {
              throw new ProviderError("OAUTH_REFRESH_FAILED", "Re-authorize this account");
            },
          } as MailReader)
        : reader;
    };
    Object.assign(backend, { readers: failing });
    const res = await app.request("/api/emails?q=Garden");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: MailRow[]; skipped: unknown[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((row) => row.account === a.id)).toBe(true);
    expect(body.skipped).toEqual([{ account: b.id, code: "OAUTH_REFRESH_FAILED" }]);

    const account = (await backend.store.accounts.get(b.id))!;
    await backend.store.accounts.upsert({
      ...account,
      settings: { ...account.settings, reauthorizationRequired: true },
    });
    const skipped = (await (await app.request("/api/emails?q=Garden")).json()) as {
      skipped: unknown[];
    };
    expect(skipped.skipped).toEqual([{ account: b.id, code: "REAUTHORIZE_REQUIRED" }]);
  });

  it("R4-14 exported mail older than 24 h is swept, newer sessions stay", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-r4-"));
    const scratch = join(dataDir, "scratch");
    await mkdir(join(scratch, "old"), { recursive: true });
    await mkdir(join(scratch, "fresh"), { recursive: true });
    const past = new Date(Date.now() - 25 * 3_600_000);
    await utimes(join(scratch, "old"), past, past);
    expect(await sweepExports(dataDir)).toBe(1);
    await expect(stat(join(scratch, "old"))).rejects.toThrow();
    expect((await stat(join(scratch, "fresh"))).isDirectory()).toBe(true);
  });
});
