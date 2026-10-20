import { describe, expect, it } from "vitest";
import sample from "./fixtures/graph.json" with { type: "json" };
import { GraphMailProvider } from "./graph.js";
import { account, collect, draft, fixtureFetch, jsonBody, lastCursor, response } from "./test/helpers.js";

describe("Microsoft Graph mail adapter", () => {
  it("maintains per-folder delta links and resolves move tombstones with immutable IDs", async () => {
    let incremental = false;
    const fetcher = fixtureFetch((url, init) => {
      expect(new Headers(init.headers).get("Prefer")).toContain('IdType="ImmutableId"');
      if (url.pathname.endsWith("/mailFolders/delta")) return response({ value: [{ id: "folder-inbox", displayName: "Inbox" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/delta?token=folders" });
      if (/\/mailFolders\/(inbox|archive|drafts|sentitems|deleteditems|junkemail)$/.test(url.pathname)) return url.pathname.endsWith("/inbox") ? response({ id: "folder-inbox" }) : response({}, 404);
      if (url.pathname.endsWith("/delta")) return response({ value: incremental ? [{ id: "m", "@removed": { reason: "deleted" } }, { id: "gone", "@removed": {} }] : [{ id: "m" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta?token=one" });
      if (url.pathname.includes("/messages/gone")) return response({}, 404);
      if (url.pathname.endsWith("/attachments")) return response({ value: sample.attachments });
      expect(url.searchParams.get("$select")).toContain("internetMessageHeaders"); return response({ ...sample, id: "m", parentFolderId: incremental ? "archive-id" : "folder-inbox" });
    });
    const p = new GraphMailProvider({ fetch: fetcher }); await p.connect(account, { access_token: "token" }); const cursor = lastCursor(await collect(p.sync(null))); incremental = true;
    const deltas = await collect(p.sync(cursor)); expect(deltas).toContainEqual({ kind: "email", op: "delete", providerId: "gone" }); expect(deltas.some(d => d.kind === "email" && d.op === "upsert" && d.email.mailboxIds[0]?.includes("archive-id"))).toBe(true); lastCursor(deltas);
  });
  it("does not send bearer credentials to untrusted continuation origins", async () => {
    const p = new GraphMailProvider({ fetch: fixtureFetch(() => response({ value: [], "@odata.nextLink": "https://evil.example/steal" })) }); await p.connect(account, { access_token: "secret" }); await expect(collect(p.sync(null))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("reconciles messages from a deleted folder using persisted folder membership", async () => {
    let removed = false;
    const p = new GraphMailProvider({ fetch: fixtureFetch(url => {
      if (url.pathname.endsWith("/mailFolders/delta")) return response({ value: removed ? [{ id: "folder-inbox", "@removed": {} }] : [{ id: "folder-inbox", displayName: "Inbox" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/delta?token=folders" });
      if (/\/mailFolders\/(inbox|archive|drafts|sentitems|deleteditems|junkemail)$/.test(url.pathname)) return response({}, 404);
      if (url.pathname.endsWith("/delta")) return response({ value: [{ id: "m" }], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/delta" });
      return removed ? response({}, 404) : response({ ...sample, id: "m", hasAttachments: false, attachments: [] });
    }) }); await p.connect(account, { access_token: "token" }); const cursor = lastCursor(await collect(p.sync(null))); removed = true; const changes = await collect(p.sync(cursor)); expect(changes).toContainEqual({ kind: "email", op: "delete", providerId: "m" }); expect(changes.some(d => d.kind === "mailbox" && d.op === "delete")).toBe(true); lastCursor(changes);
  });
  it("updates read, flag, and categories, and implements move/copy/trash", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const p = new GraphMailProvider({ fetch: fixtureFetch((url, init) => {
      if (!init.method) return response(sample); calls.push({ path: url.pathname, body: jsonBody(init) }); return response(null, 204);
    }) }); await p.connect(account, { access_token: "token" });
    await p.applyChanges([{ op: "setKeywords", providerIds: ["m"], add: ["$seen", "$flagged", "label:New"], remove: ["label:Work"] }, { op: "move", providerIds: ["m"], toMailboxProviderId: "archive" }, { op: "addToMailbox", providerIds: ["m"], mailboxProviderId: "copy-folder" }, { op: "delete", providerIds: ["m"] }]);
    expect(calls[0]?.body).toEqual({ isRead: true, flag: { flagStatus: "flagged" }, categories: ["New"] }); expect(calls[1]?.path).toMatch(/\/move$/); expect(calls[2]?.path).toMatch(/\/copy$/); expect(calls[3]?.body).toEqual({ destinationId: "deleteditems" });
    await expect(p.applyChanges([{ op: "removeFromMailbox", providerIds: ["m"], mailboxProviderId: "inbox" }])).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
  });
  it("creates drafts and submits their actual immutable IDs", async () => {
    let sent = false;
    const p = new GraphMailProvider({ fetch: fixtureFetch((url, init) => {
      if (url.pathname.endsWith("/send")) { sent = true; return response(null, 202); }
      if (url.pathname.endsWith("/messages") && init.method === "POST") { expect(jsonBody(init).toRecipients).toEqual([{ emailAddress: { address: "sam@example.com", name: "Sam" } }]); return response({ id: "draft-id" }); }
      return response({ ...sample, id: "draft-id", isDraft: true, hasAttachments: false, attachments: [] });
    }) }); await p.connect(account, { access_token: "token" }); const result = await p.send({ draft }); expect(result.providerId).toBe("draft-id"); expect(sent).toBe(true);
  });
  it("updates and deletes drafts and downloads file blobs", async () => {
    const methods: string[] = [];
    const p = new GraphMailProvider({ fetch: fixtureFetch((url, init) => {
      methods.push(init.method ?? "GET");
      if (url.pathname.endsWith("/attachments/att-1")) return response(sample.attachments[0]);
      if (init.method) return response(null, 204);
      return response({ ...sample, id: "draft-id", isDraft: true, hasAttachments: false, attachments: [] });
    }) }); await p.connect(account, { access_token: "token" }); await p.updateDraft("draft-id", draft); await p.deleteDraft("draft-id");
    const blob = `graph:${Buffer.from(JSON.stringify(["m", "att-1"])).toString("base64url")}`; expect(Buffer.from((await p.getBlob(blob)).data).toString()).toBe("plan"); expect(methods).toContain("PATCH"); expect(methods).toContain("DELETE");
  });
  it("does not misreport attachment enumeration failures as deleted messages", async () => {
    const p = new GraphMailProvider({ fetch: fixtureFetch(url => url.pathname.endsWith("/attachments") ? response({}, 404) : response(sample)) });
    await p.connect(account, { access_token: "token" }); await expect(p.getEmail("m")).rejects.toMatchObject({ code: "HTTP_404" });
  });
});
