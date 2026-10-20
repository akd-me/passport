import { describe, expect, it } from "vitest";
import sample from "./fixtures/jmap.json" with { type: "json" };
import { JmapMailProvider } from "./jmap.js";
import { account, collect, draft, fixtureFetch, jsonBody, lastCursor, response } from "./test/helpers.js";

const mail = "urn:ietf:params:jmap:mail", core = "urn:ietf:params:jmap:core", submission = "urn:ietf:params:jmap:submission";
const session = { apiUrl: "https://jmap.example/api", uploadUrl: "https://jmap.example/upload/{accountId}", downloadUrl: "https://jmap.example/download/{accountId}/{blobId}/{name}?type={type}", capabilities: { [core]: {}, [mail]: {}, [submission]: {} }, primaryAccounts: { [mail]: "remote" }, accounts: { remote: { name: "Alex", accountCapabilities: { [mail]: {}, [submission]: {} } } } };
const boxes = [{ id: "inbox", name: "Inbox", role: "inbox" }, { id: "drafts", name: "Drafts", role: "drafts" }, { id: "sent", name: "Sent", role: "sent" }, { id: "trash", name: "Trash", role: "trash" }];
function server(handler: (method: string, args: Record<string, unknown>) => unknown = () => undefined) {
  return fixtureFetch((url, init) => {
    if (url.pathname === "/.well-known/jmap") return response(session);
    if (url.pathname.startsWith("/download/")) return response("attachment", 200, { "content-type": "text/plain" });
    const [method, args, tag] = (jsonBody(init).methodCalls as Array<[string, Record<string, unknown>, string]>)[0]!;
    const value = handler(method!, args!) ?? (method === "Mailbox/get" ? { list: boxes } : method === "Email/get" ? { list: (args!.ids as string[]).length ? [{ ...sample, id: (args!.ids as string[])[0], keywords: { $draft: true } }] : [], state: "initial-state" } : method === "Email/query" ? { ids: [sample.id], total: 1 } : method === "Email/set" ? { created: { draft: { id: "draft-email" } } } : method === "Identity/get" ? { list: [{ id: "identity", email: account.emailAddress }] } : method === "EmailSubmission/set" ? { created: { send: { id: "submission" } } } : {});
    return response({ methodResponses: [[method, value, tag]] });
  });
}
const configured = { ...account, settings: { sessionUrl: "https://jmap.example/.well-known/jmap" } };

describe("JMAP adapter", () => {
  it("discovers a session and paginates Email/query from a prior Email/get watermark", async () => {
    const p = new JmapMailProvider({ fetch: server((method, args) => method === "Email/query" ? { ids: [Number(args.position) === 0 ? "one" : "two"], total: 2 } : undefined) }); await p.connect(configured, { token: "token" }); const deltas = await collect(p.sync(null, { maxEmails: 1 })); expect(deltas.filter(d => d.kind === "email")).toHaveLength(2); expect(lastCursor(deltas)).toBe("initial-state");
  });
  it("consumes Email/changes pages, including deletions, before advancing state", async () => {
    const p = new JmapMailProvider({ fetch: server((method, args) => method === "Email/changes" ? args.sinceState === "s0" ? { newState: "s1", hasMoreChanges: true, created: ["one"], updated: [], destroyed: [] } : { newState: "s2", hasMoreChanges: false, created: [], updated: ["two"], destroyed: ["gone"] } : undefined) }); await p.connect(configured, { token: "token" }); const deltas = await collect(p.sync("s0")); expect(lastCursor(deltas)).toBe("s2"); expect(deltas).toContainEqual({ kind: "email", op: "delete", providerId: "gone" });
  });
  it("applies escaped keyword paths, mailbox changes, and reversible trash moves", async () => {
    const updates: unknown[] = [];
    const p = new JmapMailProvider({ fetch: server((method, args) => { if (method === "Email/set") updates.push(args.update); }) }); await p.connect(configured, { token: "token" });
    await p.applyChanges([{ op: "setKeywords", providerIds: ["m"], add: ["label:a/b~c"], remove: ["$seen"] }, { op: "move", providerIds: ["m"], toMailboxProviderId: "archive" }, { op: "addToMailbox", providerIds: ["m"], mailboxProviderId: "label" }, { op: "removeFromMailbox", providerIds: ["m"], mailboxProviderId: "label" }, { op: "delete", providerIds: ["m"] }]); expect(updates[0]).toEqual({ m: { "keywords/label:a~1b~0c": true, "keywords/$seen": null } }); expect(updates.at(-1)).toEqual({ m: { mailboxIds: { trash: true } } });
  });
  it("creates/replaces/deletes drafts, submits an identity, and downloads blobs", async () => {
    const methods: string[] = [];
    const p = new JmapMailProvider({ fetch: server((method, args) => { methods.push(method); if (method === "EmailSubmission/set") expect(args.onSuccessUpdateEmail).toEqual({ "#send": { "keywords/$draft": null, mailboxIds: { sent: true } } }); }) }); await p.connect(configured, { token: "token" });
    const e = await p.createDraft(draft); expect(e.providerId).toBe("draft-email"); await p.updateDraft(e.providerId, draft); await p.deleteDraft(e.providerId); expect((await p.send({ draft })).providerId).toBe("draft-email"); expect(methods).toContain("EmailSubmission/set"); expect(Buffer.from((await p.getBlob("blob-1")).data).toString()).toBe("attachment");
  });
  it("fails on set-level errors even when HTTP succeeded", async () => {
    const p = new JmapMailProvider({ fetch: server(method => method === "Email/set" ? { notUpdated: { m: { type: "forbidden" } } } : undefined) }); await p.connect(configured, { token: "token" }); await expect(p.applyChanges([{ op: "delete", providerIds: ["m"] }])).rejects.toMatchObject({ code: "JMAP_SET_FAILED" });
  });
  it("fails clearly for expired states and missing Mail capability", async () => {
    const p = new JmapMailProvider({ fetch: fixtureFetch(url => url.pathname === "/.well-known/jmap" ? response(session) : response({ methodResponses: [["error", { type: "cannotCalculateChanges" }, "0"]] })) }); await p.connect(configured, { token: "token" }); await expect(p.getEmail("m")).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    const q = new JmapMailProvider({ fetch: fixtureFetch(() => response({ ...session, capabilities: {} })) }); await expect(q.connect(configured, { token: "token" })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
});
