import { MockMailProvider } from "@passport/providers";
import type { Email, MailRef } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import { createAgentRuntime } from "./runtime.js";
import { FakeExecutor, FakePolicy, MemoryBus } from "./testing/collaborators.js";
import { FakeLlm, toolOutput } from "./testing/fake-llm.js";
import {
  accountFixture,
  matterFixture,
  newMatterOutput,
  personFixture,
  TEST_NOW,
} from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

const inbox = "account-1:mailbox:Inbox";

async function setup(script: unknown[]) {
  const mock = new MockMailProvider({ fixtures: false });
  await mock.connect(accountFixture());
  mock.setNow(TEST_NOW);
  const store = new MemoryStore(),
    policy = new FakePolicy(),
    llm = new FakeLlm(script);
  await store.accounts.upsert(accountFixture());
  const executor = new FakeExecutor(store, policy);
  const reader = mock.reader();
  const search = vi.spyOn(reader, "search");
  const runtime = createAgentRuntime({
    triage: { mode: "pipeline" },
    store,
    executor,
    policy,
    bus: new MemoryBus(),
    llm,
    selfAddresses: ["me@example.com"],
    now: () => TEST_NOW,
    readers: async () => reader,
  });
  const arrive = async (input: Partial<Email>): Promise<Email> => {
    const email = mock.injectEmail({
      from: [{ name: "Alice", email: "alice@example.com" }],
      to: [{ email: "me@example.com" }],
      cc: [],
      mailboxIds: [inbox],
      receivedAt: TEST_NOW,
      verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "green" },
      ...input,
    });
    const { textBody: _text, htmlBody: _html, ...envelope } = email;
    await store.emails.upsertMany([envelope]);
    return email;
  };
  const watchQueries = () =>
    search.mock.calls
      .map(([input]) => input.query ?? "")
      .filter((query) => query.includes("rfc822msgid:"));
  return { mock, store, executor, llm, runtime, arrive, watchQueries };
}

const headers = (messageId: string) => ({ messageId, inReplyTo: null, references: [] });

describe("triage writes knowledge into notes", () => {
  it("appends one dated line to the matter's notes and one to the sender's notes", async () => {
    const env = await setup([{ category: "other" }, newMatterOutput]);
    await env.store.people.upsert(personFixture({ notes: "Neighbour." }));
    const email = await env.arrive({
      providerId: "q",
      subject: "Quick\nquestion",
      headers: headers("<q@example.com>"),
    });
    await env.runtime.run({ kind: "email.received", emailId: email.id });
    const [matter] = await env.store.matters.list();
    expect(matter?.notes).toBe(
      `- 2026-10-20: other “Quick question” from Alice (${email.id}): Alice asks for a review.`,
    );
    // The executor mirrors attached emails as provider refs.
    expect(matter?.refs).toEqual([
      expect.objectContaining({
        account: "account-1",
        providerId: "q",
        rfc822Id: "<q@example.com>",
      }),
    ]);
    expect((await env.store.people.get("person-alice"))?.notes).toBe(
      `Neighbour.\n- 2026-10-20: wrote “Quick question” (${email.id})`,
    );
    const writes = env.executor.requests.filter((request) => request.reason.startsWith("Log "));
    expect(writes.map((request) => [request.type, request.category])).toEqual([
      ["matter_update", "matters"],
      ["person_update", "matters"],
    ]);
  });

  it("logs routine mail in the matter only, never in the sender's notes", async () => {
    const env = await setup([{ category: "receipts" }, newMatterOutput]);
    await env.store.people.upsert(personFixture());
    const email = await env.arrive({ providerId: "r", subject: "Your receipt" });
    await env.runtime.run({ kind: "email.received", emailId: email.id });
    expect((await env.store.matters.list())[0]?.notes).toContain("receipts “Your receipt”");
    expect((await env.store.people.get("person-alice"))?.notes).toBeUndefined();
  });
});

describe("matter watch queries", () => {
  it("offers the matter whose watch matches the arrival and tags its log line", async () => {
    const env = await setup([{ category: "other" }, { ...newMatterOutput, matterId: "matter-w" }]);
    await env.store.matters.upsert(
      matterFixture({
        id: "matter-w",
        title: "Lease",
        watch: "from:alice@example.com newer_than:30d",
      }),
    );
    await env.store.matters.upsert(
      matterFixture({ id: "matter-x", title: "Other", watch: "from:bob@example.com" }),
    );
    const email = await env.arrive({
      providerId: "w",
      subject: "Signed",
      headers: headers("<w@x>"),
    });
    await env.runtime.run({ kind: "email.received", emailId: email.id });
    expect(env.watchQueries().sort()).toEqual([
      "(from:alice@example.com newer_than:30d) rfc822msgid:w@x",
      "(from:bob@example.com) rfc822msgid:w@x",
    ]);
    const prompt = String(env.llm.calls[1]?.messages[0]?.content);
    expect(prompt).toContain('"id":"matter-w"');
    expect(prompt).not.toContain('"id":"matter-x"');
    expect(env.executor.requests.find((r) => r.type === "matter_attach")).toMatchObject({
      params: { matterId: "matter-w" },
    });
    expect((await env.store.matters.get("matter-w"))?.notes).toContain(`(${email.id}) [watch]`);
  });

  it("checks at most five watched matters per arrival, people's matters first", async () => {
    const env = await setup([{ category: "other" }, newMatterOutput]);
    await env.store.people.upsert(personFixture());
    for (let index = 0; index < 7; index++) {
      await env.store.matters.upsert(
        matterFixture({
          id: `matter-${index}`,
          title: `Topic ${index}`,
          watch: `subject:topic${index}`,
          personIds: index === 6 ? ["person-alice"] : [],
        }),
      );
    }
    await env.store.matters.upsert(matterFixture({ id: "done", watch: "x", status: "done" }));
    const email = await env.arrive({ providerId: "b", headers: headers("<b@x>") });
    await env.runtime.run({ kind: "email.received", emailId: email.id });
    const queries = env.watchQueries();
    expect(queries).toHaveLength(5);
    expect(queries[0]).toBe("(subject:topic6) rfc822msgid:b@x");
    expect(queries.join(" ")).not.toContain("(x)");
  });
});

describe("matter review over refs", () => {
  const ref = (providerId: string, date: string): MailRef => ({
    account: "account-1",
    providerId,
    rfc822Id: null,
    date,
    subject: `Subject ${providerId}`,
  });

  it("reads refs through the envelope cache and skips matters with recent refs without reads", async () => {
    const env = await setup([
      toolOutput("update_matter", {
        accountId: "account-1",
        matterId: "matter-1",
        reason: "Review inactive matter",
        patch: { summary: "Quiet", nextStep: "Nudge Dana", status: "waiting" },
      }),
      "Reviewed.",
    ]);
    const refs = Array.from({ length: 25 }, (_, i) =>
      ref(`p${i}`, `2026-09-${String(1 + i).padStart(2, "0")}T00:00:00.000Z`),
    );
    await env.store.matters.upsert(matterFixture({ refs, emailIds: ["legacy-id"] }));
    await env.store.matters.upsert(
      matterFixture({ id: "fresh", refs: [ref("new", "2026-10-19T00:00:00.000Z")] }),
    );
    const get = vi.spyOn(env.store.emails, "get");
    await env.runtime.run({ kind: "schedule", name: "matter_review" });
    expect(get.mock.calls.map(([id, opts]) => [id, opts])).toEqual(
      refs
        .slice(-20)
        .map((item) => [
          `account-1:email:${item.providerId}`,
          { includeBodies: false, cacheOnly: true },
        ]),
    );
    expect(await env.store.matters.get("matter-1")).toMatchObject({ status: "waiting" });
    expect(await env.store.matters.get("fresh")).toMatchObject({ status: "active" });
  });
});
