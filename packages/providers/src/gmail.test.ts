import { describe, expect, it } from "vitest";
import sample from "./fixtures/gmail.json" with { type: "json" };
import { GmailMailProvider, normalizeGmail } from "./gmail.js";
import { createProviderRegistry } from "./registry.js";
import {
  account,
  collect,
  draft,
  fixtureFetch,
  jsonBody,
  lastCursor,
  response,
} from "./test/helpers.js";

describe("Gmail API adapter", () => {
  it("paginates a full sync with a watermark captured before listing", async () => {
    const seen: string[] = [];
    const fetcher = fixtureFetch((url) => {
      seen.push(url.pathname);
      if (url.pathname.endsWith("/labels")) {
        return response({ labels: [{ id: "INBOX", name: "Inbox" }] });
      }
      if (url.pathname.endsWith("/labels/INBOX")) {
        return response({ messagesTotal: 2, messagesUnread: 1 });
      }
      if (url.pathname.endsWith("/profile")) {
        return response({ historyId: "before-list" });
      }
      if (url.pathname.endsWith("/messages")) {
        return response(
          url.searchParams.has("pageToken")
            ? { messages: [{ id: "m2" }] }
            : { messages: [{ id: "m1" }], nextPageToken: "page2" },
        );
      }
      return response({ ...sample, id: url.pathname.split("/").at(-1) });
    });
    const p = new GmailMailProvider({ fetch: fetcher });
    await p.connect(account, { access_token: "token" });
    const deltas = await collect(p.sync(null, { maxEmails: 1 }));
    expect(lastCursor(deltas)).toBe("before-list");
    expect(deltas.filter((d) => d.kind === "email")).toHaveLength(2);
    expect(seen.indexOf("/gmail/v1/users/me/profile")).toBeLessThan(
      seen.indexOf("/gmail/v1/users/me/messages"),
    );
  });
  it("coalesces paginated history updates and deletion tombstones", async () => {
    const fetcher = fixtureFetch((url) => {
      if (url.pathname.endsWith("/labels")) {
        return response({ labels: [] });
      }
      if (url.pathname.endsWith("/history")) {
        return response(
          url.searchParams.has("pageToken")
            ? { historyId: "102", history: [{ messagesDeleted: [{ message: { id: "gone" } }] }] }
            : {
                historyId: "101",
                nextPageToken: "page2",
                history: [
                  {
                    messagesAdded: [{ message: { id: "new" } }],
                    labelsAdded: [{ message: { id: "new" } }],
                  },
                ],
              },
        );
      }
      return response({ ...sample, id: "new" });
    });
    const p = new GmailMailProvider({ fetch: fetcher });
    await p.connect(account, { access_token: "token" });
    const deltas = await collect(p.sync("100"));
    expect(lastCursor(deltas)).toBe("102");
    expect(deltas.filter((d) => d.kind === "email" && d.op === "upsert")).toHaveLength(1);
    expect(deltas).toContainEqual({ kind: "email", op: "delete", providerId: "gone" });
  });
  it("reports expired history without silently returning an incomplete cursor", async () => {
    const p = new GmailMailProvider({
      fetch: fixtureFetch((url) =>
        url.pathname.endsWith("/labels") ? response({ labels: [] }) : response({}, 404),
      ),
    });
    await p.connect(account, { access_token: "token" });
    await expect(collect(p.sync("expired"))).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });
  it("backs off on Gmail's per-user quota 403 instead of failing the read", async () => {
    const quota = { error: { code: 403, errors: [{ reason: "rateLimitExceeded" }] } };
    let throttled = 2;
    const waits: number[] = [];
    const p = new GmailMailProvider({
      fetch: fixtureFetch(() =>
        throttled-- > 0
          ? response(quota, 403, { "retry-after": "5" })
          : response({ ...sample, id: "m1" }),
      ),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await p.connect(account, { access_token: "token" });
    await expect(p.getEmail("m1")).resolves.toMatchObject({ subject: expect.any(String) });
    expect(waits).toEqual([5000, 5000]);
  });
  it("reports exhausted quota as RATE_LIMITED and leaves other 403s unretried", async () => {
    const quota = { error: { errors: [{ reason: "userRateLimitExceeded" }] } };
    for (const [body, code, attempts] of [
      [quota, "RATE_LIMITED", 6],
      [{ error: { errors: [{ reason: "insufficientPermissions" }] } }, "HTTP_403", 1],
    ] as const) {
      const fetcher = fixtureFetch(() => response(body, 403));
      const p = new GmailMailProvider({ fetch: fetcher, sleep: async () => {} });
      await p.connect(account, { access_token: "token" });
      await expect(p.getEmail("m1")).rejects.toMatchObject({ code, status: 403 });
      expect(fetcher).toHaveBeenCalledTimes(attempts);
    }
  });
  it("never replays a rate-limited mutation", async () => {
    const fetcher = fixtureFetch(() => response({}, 429));
    const p = new GmailMailProvider({ fetch: fetcher, sleep: async () => {} });
    await p.connect(account, { access_token: "token" });
    await expect(p.applyChanges([{ op: "delete", providerIds: ["m"] }])).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("modifies seen/flag labels and moves deletes to trash", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const p = new GmailMailProvider({
      fetch: fixtureFetch((url, init) => {
        calls.push({ path: url.pathname, body: init.body ? jsonBody(init) : {} });
        return response({});
      }),
    });
    await p.connect(account, { access_token: "token" });
    await p.applyChanges([
      { op: "setKeywords", providerIds: ["m"], add: ["$seen", "$flagged"], remove: ["$junk"] },
      { op: "delete", providerIds: ["m"] },
    ]);
    expect(calls[0]?.body).toEqual({
      addLabelIds: ["STARRED"],
      removeLabelIds: ["UNREAD", "SPAM"],
    });
    expect(calls[1]?.path).toMatch(/\/messages\/m\/trash$/);
  });
  it("creates missing labels, applies label membership, and returns blobs", async () => {
    const p = new GmailMailProvider({
      fetch: fixtureFetch((url, init) => {
        if (url.pathname.endsWith("/labels") && init.method === "POST") {
          return response({ id: "new-label", name: "Project" });
        }
        if (url.pathname.endsWith("/labels")) {
          return response({ labels: [] });
        }
        if (url.pathname.includes("/attachments/")) {
          return response({ data: Buffer.from("plan").toString("base64url") });
        }
        if (url.pathname.endsWith("/modify")) {
          expect(jsonBody(init).addLabelIds).toEqual(["new-label"]);
          return response({});
        }
        return response(sample);
      }),
    });
    await p.connect(account, { access_token: "token" });
    await p.applyChanges([
      { op: "addToMailbox", providerIds: ["m"], mailboxProviderId: "Project" },
    ]);
    const e = (await p.getEmail("m"))!;
    expect(Buffer.from((await p.getBlob(e.attachments[0]!.blobId)).data).toString()).toBe("plan");
  });
  it("hydrates large externalized text bodies without turning them into file attachments", async () => {
    const p = new GmailMailProvider({
      fetch: fixtureFetch((url) =>
        url.pathname.includes("/attachments/")
          ? response({ data: Buffer.from("Externalized body text").toString("base64url") })
          : response({
              id: "large",
              payload: {
                mimeType: "text/plain",
                body: { attachmentId: "body-handle" },
                headers: [],
              },
            }),
      ),
    });
    await p.connect(account, { access_token: "token" });
    const e = await p.getEmail("large");
    expect(e?.textBody).toBe("Externalized body text");
    expect(e?.attachments).toHaveLength(0);
  });
  it("does not misreport a missing referenced body as a deleted email", async () => {
    const p = new GmailMailProvider({
      fetch: fixtureFetch((url) =>
        url.pathname.includes("/attachments/")
          ? response({}, 404)
          : response({
              id: "large",
              payload: { mimeType: "text/plain", body: { attachmentId: "gone-body" } },
            }),
      ),
    });
    await p.connect(account, { access_token: "token" });
    await expect(p.getEmail("large")).rejects.toMatchObject({ code: "HTTP_404" });
  });
  it("creates, replaces, sends, and deletes drafts using draft IDs distinct from email IDs", async () => {
    let state = "create";
    const requests: string[] = [];
    const p = new GmailMailProvider({
      fetch: fixtureFetch((url, init) => {
        requests.push(`${init.method ?? "GET"} ${url.pathname}`);
        if (url.pathname.endsWith("/drafts/send")) {
          expect(jsonBody(init).id).toBe("draft-api-id");
          return response({ id: "sent", threadId: "thread" });
        }
        if (url.pathname.endsWith("/drafts/draft-api-id") && init.method === "DELETE") {
          return response(null, 204);
        }
        if (url.pathname.includes("/drafts") && ["POST", "PUT"].includes(init.method ?? "")) {
          const m = jsonBody(init).message as { raw: string };
          expect(Buffer.from(m.raw, "base64url").toString()).toContain("Subject: Hello");
          return response({
            id: "draft-api-id",
            message: { id: state === "replace" ? "replacement" : "draft-email" },
          });
        }
        return response({ ...sample, id: url.pathname.split("/").at(-1), labelIds: ["DRAFT"] });
      }),
    });
    await p.connect(account, { access_token: "token" });
    const e = await p.createDraft(draft);
    expect(e.providerId).toBe("draft-email");
    state = "replace";
    const updated = await p.updateDraft(e.providerId, draft);
    expect(updated.providerId).toBe("replacement");
    expect(await p.send({ draftProviderId: updated.providerId })).toEqual({
      providerId: "sent",
      messageId: null,
      threadId: "thread",
    });
    const discard = await p.createDraft(draft);
    await p.deleteDraft(discard.providerId);
    expect(requests).toContain("PUT /gmail/v1/users/me/drafts/draft-api-id");
    expect(requests).toContain("DELETE /gmail/v1/users/me/drafts/draft-api-id");
  });
  it("sends new MIME messages and rejects unsupported keywords", async () => {
    const p = new GmailMailProvider({
      fetch: fixtureFetch((url, init) => {
        expect(url.pathname).toMatch(/messages\/send$/);
        expect(jsonBody(init).raw).toBeTypeOf("string");
        return response({ id: "sent" });
      }),
    });
    await p.connect(account, { access_token: "token" });
    expect((await p.send({ draft })).providerId).toBe("sent");
    await expect(
      p.applyChanges([{ op: "setKeywords", providerIds: ["m"], add: ["$draft"] }]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_KEYWORD" });
  });
  it.each(["store", "provider", "adapter"] as const)(
    "resolves %s reply IDs without treating a store thread ID as a Gmail ID",
    async (kind) => {
      const stored = {
        ...(await normalizeGmail(sample, account.id)),
        id: "store-email-ulid",
        threadId: "store-thread-ulid",
      };
      const p = createProviderRegistry({
        resolveEmail: async (id) => (id === stored.id ? stored : null),
        fetch: fixtureFetch((url, init) => {
          if (url.pathname.endsWith("/send")) {
            const body = jsonBody(init);
            expect(body.threadId).toBe(sample.threadId);
            expect(Buffer.from(String(body.raw), "base64url").toString()).toContain(
              "In-Reply-To: <review@example.com>",
            );
            return response({ id: "sent" });
          }
          return response(sample);
        }),
      }).mail("gmail");
      await p.connect(account, { access_token: "token" });
      const id =
        kind === "store"
          ? stored.id
          : kind === "provider"
            ? sample.id
            : `${account.id}:email:${encodeURIComponent(sample.id)}`;
      expect((await p.send({ draft: { ...draft, inReplyToEmailId: id } })).providerId).toBe("sent");
    },
  );
});

it("T7 creates a provider label with a stable local mailbox ID for executor membership", async () => {
  const fetcher = fixtureFetch((url, init) => {
    if (url.pathname.endsWith("/labels") && init.method === "POST") {
      expect(jsonBody(init)).toMatchObject({ name: "Receipts" });
      return response({ id: "Label_created", name: "Receipts" });
    }
    if (url.pathname.endsWith("/modify")) {
      expect(jsonBody(init).addLabelIds).toEqual(["Label_created"]);
      return response({});
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const provider = new GmailMailProvider({ fetch: fetcher });
  await provider.connect(account, { access_token: "token" });
  const label = await provider.createMailbox("Receipts");
  expect(label).toMatchObject({
    accountId: account.id,
    providerId: "Label_created",
    name: "Receipts",
    role: null,
  });
  await provider.applyChanges([
    { op: "addToMailbox", providerIds: ["message"], mailboxProviderId: label.providerId },
  ]);
});
