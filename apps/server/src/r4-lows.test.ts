import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProviderRegistry,
  MockCalendarProvider,
  MockMailProvider,
  mockCapabilities,
} from "@passport/providers";
import { InMemoryEventBus, openStore } from "@passport/store";
import { type Account, type MailReader, mailHandle } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addAccount } from "./accounts.js";
import { createApp } from "./auth.test-client.js";
import { createRealBackend, type RealBackend } from "./compose.js";
import { defaultConfig, type PassportConfig, saveConfig } from "./config.js";
import { createSyncIdentity } from "./sync/identity.js";
import { MailWatcher } from "./watch/watcher.js";

const at = "2026-10-20T12:00:00.000Z";
const account = (extra: Partial<Account> = {}): Account =>
  ({
    id: "acct",
    kind: "mock",
    displayName: "acct",
    emailAddress: "acct@example.com",
    capabilities: { ...mockCapabilities, calendar: false, push: false },
    settings: {},
    createdAt: at,
    updatedAt: at,
    ...extra,
  }) as Account;

async function watcherFor(acct: Account, wrap?: (reader: MailReader) => MailReader) {
  const store = openStore({ path: ":memory:" });
  await store.migrate();
  await store.accounts.upsert(acct);
  const mail = new MockMailProvider();
  await mail.connect(acct);
  const reader = wrap ? wrap(mail.reader()) : mail.reader();
  const watcher = new MailWatcher({
    store,
    bus: new InMemoryEventBus(),
    readers: async () => reader,
    normalize: createSyncIdentity(store).email,
  });
  return { store, watcher };
}

describe("R4 low-severity fixes", () => {
  const backends: RealBackend[] = [];
  afterEach(async () => {
    await Promise.all(backends.splice(0).map((b) => b.close()));
    vi.restoreAllMocks();
  });

  it("R4-26 a watcher failure carries a bounded code and fixed text, never the raw message", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const { watcher } = await watcherFor(account(), (reader) =>
      Object.assign(Object.create(reader), {
        changes: async (cursor: string | null) => {
          if (calls++ > 0) {
            throw new Error('Unexpected token, "Subject: Payroll for Alice" is not valid JSON');
          }
          return reader.changes(cursor, 1);
        },
      }),
    );
    await watcher.tick("acct");
    const error = await watcher.tick("acct").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "WATCH_FAILED", message: "New-mail check failed" });
  });

  it("R4-28 a watcher success keeps a calendar sync error on a mail+calendar account", async () => {
    const { store, watcher } = await watcherFor(
      account({ capabilities: { ...mockCapabilities }, lastSyncError: "SYNC_INCOMPLETE" }),
    );
    await watcher.tick("acct");
    expect((await store.accounts.get("acct"))?.lastSyncError).toBe("SYNC_INCOMPLETE");
  });

  it("R4-30 saving the config drops the retired sync block", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "passport-r4-config-"));
    await saveConfig({
      ...defaultConfig(),
      dataDir,
      sync: { initialDays: 30 },
    } as PassportConfig);
    const saved = JSON.parse(await readFile(join(dataDir, "passport.config.json"), "utf8"));
    expect(saved).not.toHaveProperty("sync");
  });

  it("R4-32 explicit triage of a message still queued for triage answers 409", async () => {
    const providers = createProviderRegistry();
    vi.spyOn(providers, "mail").mockReturnValue(new MockMailProvider());
    vi.spyOn(providers, "calendar").mockReturnValue(new MockCalendarProvider());
    const backend = await createRealBackend(defaultConfig(), { storePath: ":memory:", providers });
    backends.push(backend);
    const acct = await addAccount(backend, {
      kind: "mock",
      emailAddress: "a@example.com",
      fields: {},
    });
    const run = vi.spyOn(backend.agent, "run");
    const id = mailHandle(acct.id, "email", "fixture-20");
    await backend.store.kv.set(
      `arrival:${id}`,
      JSON.stringify({ accountId: acct.id, attempts: 0, nextAttemptAt: at, lastError: null }),
    );
    const response = await createApp(backend).request(
      `/api/agent/triage/${encodeURIComponent(id)}`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });
});
