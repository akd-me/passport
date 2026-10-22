import type { Email, EmailGetOptions, MailEnvelope } from "@passport/types";
import { describe, expect, it } from "vitest";
import { email, request, setup } from "./testing/fixtures.js";

/**
 * Wraps the in-memory store with a read-through like the SQLite store's: `fresh` reads ask a fake
 * MailReader for the envelope and patch labels/flags before returning.
 */
async function freshFixture() {
  const fixture = await setup();
  const { store } = fixture;
  const provider = new Map<string, Pick<MailEnvelope, "mailboxIds" | "keywords">>();
  const reads: Array<{ id: string; opts?: EmailGetOptions }> = [];
  const envelopeCalls: string[][] = [];
  const reader = {
    async envelopes(providerIds: string[]) {
      envelopeCalls.push(providerIds);
      return new Map(providerIds.map((id) => [id, structuredClone(provider.get(id)) ?? null]));
    },
  };
  const get = store.emails.get.bind(store.emails);
  store.emails.get = async (id, opts) => {
    reads.push({ id, ...(opts ? { opts } : {}) });
    const cached = await get(id, opts);
    if (cached && opts?.fresh) {
      const envelope = (await reader.envelopes([cached.providerId])).get(cached.providerId);
      if (envelope) {
        await store.emails.patchMany([id], envelope);
        return { ...cached, ...envelope };
      }
    }
    return cached;
  };
  const seed = async (cached: Email, remote: Pick<Email, "mailboxIds" | "keywords">) => {
    await store.emails.upsertMany([cached]);
    provider.set(cached.providerId, structuredClone(remote));
  };
  return { ...fixture, provider, reads, envelopeCalls, seed };
}

describe("executor pre-images", () => {
  it("captures inverses from fresh provider state, not the cache", async () => {
    const { executor, store, mail, reads, envelopeCalls, seed } = await freshFixture();
    // The cache believes the message is read; the provider says unread, flagged and archived.
    await seed(email({ mailboxIds: ["inbox"], keywords: { $seen: true } }), {
      mailboxIds: ["archive"],
      keywords: { $flagged: true },
    });
    const action = await executor.submit(request("mark_read", { emailIds: ["email"] }));
    expect(action.status).toBe("executed");
    expect(reads).toContainEqual({ id: "email", opts: { fresh: true, includeBodies: false } });
    expect(envelopeCalls[0]).toEqual(["remote-email"]);
    expect(action.inverse?.params).toMatchObject({
      __passportPolicyInverse: {
        kind: "mail",
        emails: [{ id: "email", mailboxIds: ["archive"], keywords: { $flagged: true } }],
      },
    });
    expect(mail.changes).toEqual([
      [{ op: "setKeywords", providerIds: ["remote-email"], add: ["$seen"] }],
    ]);
    expect((await store.emails.get("email"))?.keywords).toEqual({ $flagged: true, $seen: true });
  });

  it("stores body-free inverses with only identity, labels, flags, thread and subject", async () => {
    const { executor, seed } = await freshFixture();
    const secret = "Confidential body text that must not reach the action log";
    await seed(
      email({
        textBody: secret,
        htmlBody: `<p>${secret}</p>`,
        attachments: [{ id: "a", name: "plan.pdf", type: "application/pdf", size: 1, blobId: "b" }],
      }),
      { mailboxIds: ["inbox", "tag"], keywords: {} },
    );
    const action = await executor.submit(request("archive", { emailIds: ["email"] }));
    const params = action.inverse?.params as Record<string, { emails: object[] }> | undefined;
    expect(params?.__passportPolicyInverse?.emails).toEqual([
      {
        id: "email",
        accountId: "account",
        providerId: "remote-email",
        threadId: "thread",
        mailboxIds: ["inbox", "tag"],
        keywords: {},
        subject: "Hello",
      },
    ]);
    expect(JSON.stringify(action.inverse)).not.toContain("Confidential");
    expect(JSON.stringify(action.inverse)).not.toContain("plan.pdf");
  });

  it("diffs undo against fresh provider state", async () => {
    const { executor, mail, provider, reads, seed } = await freshFixture();
    await seed(email({ mailboxIds: ["inbox"], keywords: {} }), {
      mailboxIds: ["inbox"],
      keywords: {},
    });
    const action = await executor.submit(request("mark_read", { emailIds: ["email"] }));
    // Out of band, the user marks the message unread again on the provider; the cache is stale.
    provider.set("remote-email", { mailboxIds: ["inbox"], keywords: {} });
    reads.length = 0;
    await executor.undo(action.id);
    expect(reads).toContainEqual({ id: "email", opts: { fresh: true, includeBodies: false } });
    // Provider state already equals the pre-image, so undo issues no provider change.
    expect(mail.changes).toEqual([
      [{ op: "setKeywords", providerIds: ["remote-email"], add: ["$seen"] }],
    ]);
  });
});
