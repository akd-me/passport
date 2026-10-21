import { categorize, createToolRegistry } from "@passport/tools";
import type { Email } from "@passport/types";
import { describe, expect, it } from "vitest";
import { resolvePeople } from "./people.js";
import { FakeExecutor, FakePolicy, MemoryBus } from "./testing/collaborators.js";
import { accountFixture, emailFixture, personFixture, TEST_NOW } from "./testing/fixtures.js";
import { MemoryStore } from "./testing/memory-store.js";

async function resolve(
  email: Email = emailFixture(),
  history: Email[] = [],
  person?: ReturnType<typeof personFixture>,
) {
  const store = new MemoryStore(),
    policy = new FakePolicy(),
    bus = new MemoryBus(),
    executor = new FakeExecutor(store, policy);
  await store.emails.upsertMany([email, ...history]);
  if (person) {
    await store.people.upsert(person);
  }
  await store.accounts.upsert(accountFixture());
  const tools = createToolRegistry({
    store,
    executor,
    policy,
    bus,
    selfAddresses: ["me@example.com"],
    actor: { kind: "agent", id: "run-people" },
  });
  const rerun = async (email: Email) => {
    await store.emails.upsertMany([email]);
    return resolvePeople({
      email,
      store,
      bus,
      now: TEST_NOW,
      selfAddresses: new Set(["me@example.com"]),
      savePerson: async (person, reason) => {
        const result = await tools
          .find((tool) => tool.name === "update_person")!
          .handler(
            {
              accountId: "account-1",
              personId: person.id,
              patch: { displayName: person.displayName },
              reason,
            },
            { personSnapshot: person, projectedPeople: [person], runId: "run-people" },
          );
        if (result.isError) {
          throw new Error(JSON.stringify(result));
        }
      },
    });
  };
  const result = await rerun(email);
  return {
    store,
    bus,
    executor,
    result,
    rerun,
    sender: await store.people.getByEmail(email.from[0]!.email),
  };
}

describe("people inference", () => {
  it("normalizes email addresses, infers self, and deduplicates from/to/cc", async () => {
    const env = await resolve(
      emailFixture({ to: [{ email: "ME@EXAMPLE.COM" }], cc: [{ email: "Alice@Example.com" }] }),
    );
    expect(await env.store.people.list()).toHaveLength(2);
    expect(await env.store.people.getByEmail("me@example.com")).toMatchObject({
      relationship: "self",
      primaryEmail: "me@example.com",
    });
    expect(env.sender).toMatchObject({
      primaryEmail: "alice@example.com",
      relationship: "stranger",
      stats: { received: 1 },
    });
  });

  it.each([
    { listId: "news.example" },
    { extra: { precedence: "bulk" } },
    { extra: { precedence: "list" } },
  ])("uses sender headers to infer services: %j", async (headers) => {
    const env = await resolve(
      emailFixture({ headers: { messageId: null, inReplyTo: null, references: [], ...headers } }),
    );
    expect(env.sender?.relationship).toBe("service");
    expect((await env.store.people.getByEmail("me@example.com"))?.relationship).toBe("self");
  });

  it("infers no-reply senders as services without marking other recipients service", async () => {
    const env = await resolve(
      emailFixture({
        from: [{ email: "noreply@system.test" }],
        cc: [{ email: "bob@example.com" }],
      }),
    );
    expect(env.sender?.relationship).toBe("service");
    expect((await env.store.people.getByEmail("bob@example.com"))?.relationship).toBe("stranger");
  });

  it("infers known after any previously sent message, including BCC", async () => {
    const previous = emailFixture({
      id: "sent",
      provenance: "sent",
      from: [{ email: "me@example.com" }],
      to: [],
      bcc: [{ email: "alice@example.com" }],
      receivedAt: "2026-10-01T00:00:00.000Z",
    });
    const env = await resolve(emailFixture(), [previous]);
    expect(env.sender).toMatchObject({ relationship: "known", stats: { sent: 1, received: 1 } });
  });

  it("requires two prior received messages rather than counting the current message", async () => {
    const previous = emailFixture({ id: "prior-1", receivedAt: "2026-10-01T00:00:00.000Z" });
    const one = await resolve(emailFixture(), [previous]);
    expect(one.sender?.relationship).toBe("stranger");
    const two = await resolve(emailFixture(), [previous, { ...previous, id: "prior-2" }]);
    expect(two.sender).toMatchObject({ relationship: "known", stats: { received: 3 } });
  });

  it("uses prior recorded stats when normalized historical emails are absent", async () => {
    const env = await resolve(
      emailFixture(),
      [],
      personFixture({
        relationship: "stranger",
        stats: { sent: 0, received: 2, lastContactAt: null },
      }),
    );
    expect(env.sender?.relationship).toBe("known");
  });

  it("ignores future messages and unsent drafts when inferring prior contact", async () => {
    const sent = emailFixture({
      id: "future",
      receivedAt: "2026-10-25T00:00:00.000Z",
      from: [{ email: "me@example.com" }],
      to: [{ email: "alice@example.com" }],
    });
    const draft = {
      ...sent,
      id: "draft",
      receivedAt: "2026-10-01T00:00:00.000Z",
      keywords: { $draft: true },
    };
    const env = await resolve(emailFixture(), [sent, draft]);
    expect(env.sender?.relationship).toBe("stranger");
  });

  it("derives verification only for the actual sender and emits blue-to-green downgrade alerts", async () => {
    const env = await resolve(
      emailFixture(),
      [],
      personFixture({ verification: "blue", lastSeenBlueAt: "2026-10-01T00:00:00.000Z" }),
    );
    expect(env.sender).toMatchObject({
      verification: "green",
      lastSeenBlueAt: "2026-10-01T00:00:00.000Z",
    });
    expect(env.bus.events).toEqual([
      expect.objectContaining({
        type: "person.downgraded",
        emailId: "email-1",
        person: expect.objectContaining({ id: "person-alice" }),
      }),
    ]);
    expect(env.executor.requests[0]?.counterparty?.class).toBe("stranger");
  });

  it("never upgrades recipients from a sender's blue verification", async () => {
    const env = await resolve(
      emailFixture({
        verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "blue" },
        cc: [{ email: "bob@example.com" }],
      }),
    );
    expect(env.sender).toMatchObject({ verification: "blue", lastSeenBlueAt: TEST_NOW });
    expect((await env.store.people.getByEmail("bob@example.com"))?.verification).toBe("unknown");
  });

  it("refreshes a sender's unknown verification from normalized green headers", async () => {
    const env = await resolve(emailFixture(), [], personFixture({ verification: "unknown" }));
    expect(env.sender?.verification).toBe("green");
    expect(env.bus.events).toEqual([]);
  });

  it("paginates the entire history when counting prior messages", async () => {
    const history = Array.from({ length: 202 }, (_, i) =>
      emailFixture({
        id: `old-${i}`,
        from: [{ email: i >= 200 ? "alice@example.com" : "other@example.com" }],
        receivedAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    const env = await resolve(emailFixture(), history);
    expect(env.sender).toMatchObject({ relationship: "known", stats: { received: 3 } });
  });
});

it("T4 forged self From never contributes sent history or promotes its recipient", async () => {
  const forged = emailFixture({
    id: "forged",
    receivedAt: "2026-10-01T00:00:00.000Z",
    from: [{ email: "me@example.com" }],
    to: [{ email: "alice@example.com" }],
    verification: { dkim: "fail", spf: "fail", dmarc: "fail", passport: "green" },
  });
  const env = await resolve(emailFixture(), [forged]);
  expect(env.sender).toMatchObject({ relationship: "stranger", stats: { sent: 0 } });
  const warning = await env.rerun({ ...forged, receivedAt: TEST_NOW });
  expect(warning.downgraded).toHaveLength(1);
  expect(env.bus.events.at(-1)).toMatchObject({ type: "person.downgraded", emailId: "forged" });
  expect(
    categorize({
      type: "archive",
      emails: [forged],
      people: warning.people,
      selfEmails: ["me@example.com"],
    }),
  ).toMatchObject({ counterparty: { class: "stranger" } });
});

it("T4 only sent-role mail, explicit provider provenance, or executed sends prove outbound contact", async () => {
  const env = await resolve(emailFixture());
  await env.store.mailboxes.upsertMany([
    {
      id: "sent-box",
      providerId: "sent",
      accountId: "account-1",
      name: "Sent",
      role: "sent",
      totalEmails: 0,
      unreadEmails: 0,
    },
  ]);
  await env.store.emails.upsertMany([
    emailFixture({
      id: "sent",
      mailboxIds: ["sent-box"],
      from: [{ email: "me@example.com" }],
      to: [{ email: "alice@example.com" }],
      receivedAt: "2026-10-01T00:00:00.000Z",
    }),
  ]);
  await env.rerun(emailFixture());
  expect(await env.store.people.getByEmail("alice@example.com")).toMatchObject({
    relationship: "known",
    stats: { sent: 1 },
  });
  const other = await resolve(emailFixture());
  await other.store.actions.insert({
    id: "sent-action",
    request: {
      type: "send",
      accountId: "account-1",
      actor: { kind: "human", id: "user" },
      category: "replies_stranger",
      reason: "Send",
      params: {
        draft: {
          accountId: "account-1",
          to: [{ email: "alice@example.com" }],
          subject: "Hi",
          textBody: "Hi",
        },
      },
    },
    status: "executed",
    createdAt: "2026-10-01T00:00:00.000Z",
    executedAt: "2026-10-01T00:00:00.000Z",
    decision: {
      outcome: "allow",
      risk: "high",
      trustLevel: "full_access",
      reversibility: "irreversible",
      category: "replies_stranger",
      reason: "Approved",
    },
  });
  await other.rerun(emailFixture());
  expect(await other.store.people.getByEmail("alice@example.com")).toMatchObject({
    relationship: "known",
    stats: { sent: 1 },
  });
});

it("T5 processing the same stored email three times contributes once and cannot promote its sender", async () => {
  const env = await resolve(emailFixture());
  await env.rerun(emailFixture());
  await env.rerun(emailFixture());
  expect(await env.store.people.getByEmail("alice@example.com")).toMatchObject({
    relationship: "stranger",
    stats: { sent: 0, received: 1 },
  });
  await env.rerun(emailFixture({ id: "second" }));
  expect(await env.store.people.getByEmail("alice@example.com")).toMatchObject({
    relationship: "stranger",
    stats: { received: 2 },
  });
  await env.rerun(emailFixture({ id: "third" }));
  expect(await env.store.people.getByEmail("alice@example.com")).toMatchObject({
    relationship: "known",
    stats: { received: 3 },
  });
});

it("T6 downgrade warnings and stranger risk persist until blue returns or a human acknowledges", async () => {
  const env = await resolve(
    emailFixture(),
    [],
    personFixture({ verification: "blue", lastSeenBlueAt: "2026-10-01T00:00:00.000Z" }),
  );
  const second = await env.rerun(emailFixture({ id: "second" }));
  expect(second.downgraded).toHaveLength(1);
  expect(
    categorize({ type: "archive", emails: [emailFixture()], people: second.people }),
  ).toMatchObject({ counterparty: { class: "stranger" } });
  const person = (await env.store.people.getByEmail("alice@example.com"))!;
  await env.store.people.upsert({ ...person, downgradeAcknowledgedAt: TEST_NOW });
  expect((await env.rerun(emailFixture({ id: "acknowledged" }))).downgraded).toEqual([]);
  const blue = emailFixture({
    id: "blue",
    receivedAt: "2026-10-21T00:00:00.000Z",
    verification: { dkim: "pass", spf: "pass", dmarc: "pass", passport: "blue" },
  });
  expect((await env.rerun(blue)).downgraded).toEqual([]);
  expect(
    (await env.rerun(emailFixture({ id: "after-blue", receivedAt: "2026-10-22T00:00:00.000Z" })))
      .downgraded,
  ).toHaveLength(1);
});

it("T5 sent history remains idempotent when a logged send later gains a synced sent copy", async () => {
  const env = await resolve(emailFixture());
  const sent = {
    id: "send",
    request: {
      type: "send" as const,
      accountId: "account-1",
      actor: { kind: "human" as const, id: "user" },
      category: "replies_stranger" as const,
      reason: "Send",
      params: {
        draft: {
          accountId: "account-1",
          to: [{ email: "alice@example.com" }],
          subject: "Hi",
          textBody: "Hi",
        },
      },
    },
    status: "executed" as const,
    createdAt: "2026-10-01T00:00:00.000Z",
    executedAt: "2026-10-01T00:00:00.000Z",
    result: { providerId: "sent-provider-id" },
    decision: {
      outcome: "allow" as const,
      risk: "high" as const,
      trustLevel: "full_access" as const,
      reversibility: "irreversible" as const,
      category: "replies_stranger" as const,
      reason: "Approved",
    },
  };
  await env.store.actions.insert(sent);
  await env.rerun(emailFixture());
  expect((await env.store.people.getByEmail("alice@example.com"))?.stats.sent).toBe(1);
  await env.store.emails.upsertMany([
    emailFixture({
      id: "sent-copy",
      providerId: "sent-provider-id",
      provenance: "sent",
      from: [{ email: "me@example.com" }],
      to: [{ email: "alice@example.com" }],
      receivedAt: sent.executedAt,
    }),
  ]);
  await env.rerun(emailFixture());
  expect((await env.store.people.getByEmail("alice@example.com"))?.stats.sent).toBe(1);
});

it("T5 contributions aggregate all aliases of the same person without recounting imported history", async () => {
  const prior = emailFixture({
    id: "prior",
    receivedAt: "2026-10-01T00:00:00.000Z",
    from: [{ email: "alias@example.com" }],
  });
  const contact = personFixture({
    emails: ["alice@example.com", "alias@example.com"],
    stats: { sent: 0, received: 1, lastContactAt: prior.receivedAt },
  });
  const email = emailFixture({ cc: [{ email: "alias@example.com" }] });
  const env = await resolve(email, [prior], contact);
  await env.rerun(email);
  expect((await env.store.people.get(contact.id))?.stats.received).toBe(2);
});
