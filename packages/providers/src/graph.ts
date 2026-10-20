import type { AccountCapabilities, DraftInput, Email, MailboxRole, MailChange, MailChangeResult, MailProvider, SendResult, SyncDelta } from "@passport/types";
import { assertSend, decodeCursor, encodeCursor, localId, NotImplementedError, ProviderError, required } from "./errors.js";
import { HttpConnection, type ProviderOptions } from "./http.js";
import { generatePreview, htmlToText, normalizeAddresses, normalizeHeaders, toIso } from "./normalize/index.js";
import { verifyHeaders, type PassportVerifier } from "./verification.js";

export const graphBase = "https://graph.microsoft.com/v1.0";
export interface GraphAddress { emailAddress: { address: string; name?: string } }
export interface GraphAttachment { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentId?: string; contentBytes?: string; "@odata.type"?: string }
export interface GraphMessage {
  id: string; conversationId?: string; parentFolderId?: string; subject?: string; from?: GraphAddress; sender?: GraphAddress;
  toRecipients?: GraphAddress[]; ccRecipients?: GraphAddress[]; bccRecipients?: GraphAddress[]; replyTo?: GraphAddress[];
  sentDateTime?: string; receivedDateTime?: string; bodyPreview?: string; body?: { contentType: string; content: string };
  isRead?: boolean; isDraft?: boolean; flag?: { flagStatus?: string }; categories?: string[]; hasAttachments?: boolean;
  internetMessageId?: string; internetMessageHeaders?: Array<{ name: string; value: string }>; attachments?: GraphAttachment[]; "@removed"?: unknown;
}
interface GraphFolder { id: string; displayName: string; parentFolderId?: string; childFolderCount?: number; totalItemCount?: number; unreadItemCount?: number; "@removed"?: unknown }
export interface GraphPage<T> { value?: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }
export const graphCapabilities: AccountCapabilities = { mail: true, calendar: false, contacts: false, push: false, labels: false, submit: true };

/** Graph IDs are requested as ImmutableId so moves keep provider identities stable. */
export async function normalizeGraph(message: GraphMessage, accountId: string, verifier?: PassportVerifier): Promise<Email> {
  const addresses = (values: GraphAddress[] = []) => normalizeAddresses(values.map(v => ({ email: v.emailAddress.address, ...(v.emailAddress.name ? { name: v.emailAddress.name } : {}) })));
  const headers = normalizeHeaders(message.internetMessageHeaders ?? []); headers.messageId ??= message.internetMessageId ?? null;
  const html = message.body?.contentType.toLowerCase() === "html" ? message.body.content : null;
  const text = html ? htmlToText(html) : message.body?.content ?? "";
  const keywords: Email["keywords"] = {};
  if (message.isRead) keywords.$seen = true; if (message.isDraft) keywords.$draft = true;
  if (message.flag?.flagStatus === "flagged") keywords.$flagged = true;
  for (const c of message.categories ?? []) keywords[`label:${c}`] = true;
  return { id: localId(accountId, "email", message.id), accountId, providerId: message.id,
    threadId: localId(accountId, "thread", message.conversationId ?? message.id), mailboxIds: message.parentFolderId ? [localId(accountId, "mailbox", message.parentFolderId)] : [], keywords,
    from: addresses(message.from ? [message.from] : message.sender ? [message.sender] : []), to: addresses(message.toRecipients), cc: addresses(message.ccRecipients), bcc: addresses(message.bccRecipients), replyTo: addresses(message.replyTo),
    subject: message.subject ?? "", sentAt: message.sentDateTime ? toIso(message.sentDateTime) : null, receivedAt: toIso(message.receivedDateTime ?? message.sentDateTime ?? 0),
    preview: generatePreview(text || message.bodyPreview || ""), textBody: text, htmlBody: html,
    attachments: (message.attachments ?? []).map(a => ({ id: localId(accountId, "attachment", `${message.id}:${a.id}`), name: a.name ?? "attachment", type: a.contentType ?? "application/octet-stream", size: a.size ?? 0,
      blobId: `graph:${encodeCursor([message.id, a.id])}`, disposition: a.isInline ? "inline" : "attachment", cid: a.contentId ?? null })),
    headers, size: Buffer.byteLength(text) + Buffer.byteLength(html ?? "") + (message.attachments ?? []).reduce((n, a) => n + (a.size ?? 0), 0), verification: await verifyHeaders(headers, verifier), personIds: [] };
}

export class GraphMailProvider extends HttpConnection implements MailProvider {
  readonly kind = "graph" as const;
  readonly capabilities = graphCapabilities;
  constructor(options: ProviderOptions = {}) { super(options, "microsoft"); }
  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers); headers.set("Prefer", [headers.get("Prefer"), 'IdType="ImmutableId", outlook.body-content-type="html"'].filter(Boolean).join(", "));
    return this.json<T>(this.safeLink(path, `${graphBase}/`), { ...init, headers });
  }
  private async empty(path: string, init: RequestInit): Promise<void> {
    const headers = new Headers(init.headers); headers.set("Prefer", 'IdType="ImmutableId"');
    await this.http(this.safeLink(path, `${graphBase}/`), { ...init, headers });
  }
  private async all<T>(path: string): Promise<T[]> {
    const out: T[] = []; let link: string | undefined = path;
    while (link) { const p: GraphPage<T> = await this.api(link); out.push(...(p.value ?? [])); link = p["@odata.nextLink"]; }
    return out;
  }
  private async folders(saved?: { link: string; items: Record<string, GraphFolder> }): Promise<{ link: string; items: Record<string, GraphFolder> }> {
    const items = { ...saved?.items };
    let link: string | undefined = saved?.link ?? `${graphBase}/me/mailFolders/delta`, final: string | undefined;
    while (link) {
      let page: GraphPage<GraphFolder>;
      try { page = await this.api(link, { headers: { Prefer: "odata.maxpagesize=100" } }); }
      catch (error) { if (error instanceof ProviderError && [404, 410].includes(error.status ?? 0)) throw new ProviderError("CURSOR_EXPIRED", "Graph folder delta expired; run a full sync"); throw error; }
      for (const folder of page.value ?? []) {
        if (folder["@removed"]) delete items[folder.id];
        else items[folder.id] = { ...items[folder.id], ...folder };
      }
      final = page["@odata.deltaLink"]; link = page["@odata.nextLink"];
    }
    return { link: this.safeLink(required(final, "Graph folder deltaLink"), graphBase), items };
  }
  async *sync(cursor: string | null, opts: { maxEmails?: number; since?: string } = {}): AsyncIterable<SyncDelta> {
    this.check();
    const previous = cursor ? decodeCursor<{ account: string; folders: Record<string, string>; members?: Record<string, string[]>; since?: string; hierarchy?: { link: string; items: Record<string, GraphFolder> } }>(cursor) : { account: this.account.id, folders: {}, members: {} };
    if (previous.account !== this.account.id || !previous.folders) throw new ProviderError("INVALID_CURSOR", "Invalid Graph folder cursor");
    const hierarchy = await this.folders("hierarchy" in previous ? previous.hierarchy : undefined);
    const since = "since" in previous ? previous.since : opts.since;
    const folders = Object.values(hierarchy.items), roleIds = new Map<string, MailboxRole>();
    const wellKnown: Record<string, MailboxRole> = { inbox: "inbox", archive: "archive", drafts: "drafts", sentitems: "sent", deleteditems: "trash", junkemail: "junk" };
    for (const [name, role] of Object.entries(wellKnown)) {
      try { roleIds.set((await this.api<GraphFolder>(`${graphBase}/me/mailFolders/${name}`)).id, role); }
      catch (e) { if (!(e instanceof ProviderError && e.status === 404)) throw e; }
    }
    const next: Record<string, string> = {}, members: Record<string, string[]> = {}, changed = new Set<string>();
    for (const missing of Object.keys(previous.folders)) if (!folders.some(f => f.id === missing)) {
      yield { kind: "mailbox", op: "delete", id: localId(this.account.id, "mailbox", missing) };
      for (const id of previous.members?.[missing] ?? []) changed.add(id);
    }
    for (const f of folders) {
      yield { kind: "mailbox", op: "upsert", mailbox: { id: localId(this.account.id, "mailbox", f.id), accountId: this.account.id, providerId: f.id, name: f.displayName, role: roleIds.get(f.id) ?? null,
        parentId: f.parentFolderId && folders.some(p => p.id === f.parentFolderId) ? localId(this.account.id, "mailbox", f.parentFolderId) : null, totalEmails: f.totalItemCount ?? 0, unreadEmails: f.unreadItemCount ?? 0 } };
      let link: string | undefined = previous.folders[f.id] ?? `${graphBase}/me/mailFolders/${encodeURIComponent(f.id)}/messages/delta?${new URLSearchParams({ "$orderby": "receivedDateTime desc", "$select": "id,receivedDateTime,lastModifiedDateTime,isRead,isDraft,flag,categories" })}`;
      const folderMembers = new Set(previous.members?.[f.id] ?? []);
      while (link) {
        let page: GraphPage<GraphMessage>;
        try { page = await this.api(link, { headers: { Prefer: `odata.maxpagesize=${Math.max(1, Math.min(opts.maxEmails ?? 100, 1000))}` } }); }
        catch (e) { if (e instanceof ProviderError && [410, 404].includes(e.status ?? 0)) throw new ProviderError("CURSOR_EXPIRED", "Graph delta expired; reset local sync state and run a full sync"); throw e; }
        // Drain metadata pages through deltaLink even beyond the window. Stopping early loses the cursor.
        for (const message of page.value ?? []) {
          if (message["@removed"]) { changed.add(message.id); folderMembers.delete(message.id); }
          else if (!since || !message.receivedDateTime || Date.parse(message.receivedDateTime) >= Date.parse(since)) { changed.add(message.id); folderMembers.add(message.id); }
        }
        if (page["@odata.deltaLink"]) next[f.id] = this.safeLink(page["@odata.deltaLink"], graphBase);
        link = page["@odata.nextLink"];
      }
      if (!next[f.id]) throw new ProviderError("INVALID_RESPONSE", "Graph did not return a final deltaLink");
      members[f.id] = [...folderMembers];
    }
    // A folder tombstone can mean a move. Resolve every changed immutable ID globally before deleting.
    for (const providerId of changed) {
      const email = await this.getEmail(providerId);
      if (email) { if (!since || Date.parse(email.receivedAt) >= Date.parse(since)) yield { kind: "email", op: "upsert", email }; } else yield { kind: "email", op: "delete", providerId };
    }
    yield { kind: "cursor", cursor: encodeCursor({ account: this.account.id, folders: next, members, since, hierarchy }) };
  }
  async checkConnection(): Promise<void> { await this.api(`${graphBase}/me?$select=id`); }
  async getEmail(providerId: string): Promise<Email | null> {
    const properties = "id,conversationId,parentFolderId,subject,from,sender,toRecipients,ccRecipients,bccRecipients,replyTo,sentDateTime,receivedDateTime,bodyPreview,body,isRead,isDraft,flag,categories,hasAttachments,internetMessageId,internetMessageHeaders";
    let message: GraphMessage;
    try { message = await this.api<GraphMessage>(`${graphBase}/me/messages/${encodeURIComponent(providerId)}?$select=${properties}`); }
    catch (e) { if (e instanceof ProviderError && e.status === 404) return null; throw e; }
    if (message.hasAttachments || /cid:/i.test(message.body?.content ?? "")) message.attachments = await this.all<GraphAttachment>(`${graphBase}/me/messages/${encodeURIComponent(providerId)}/attachments`);
    return normalizeGraph(message, this.account.id, this.options.verifier);
  }
  async getBlob(blobId: string): Promise<{ type: string; data: Uint8Array }> {
    if (!blobId.startsWith("graph:")) throw new ProviderError("INVALID_BLOB_ID", "Invalid Graph attachment handle");
    const [message, attachment] = decodeCursor<[string, string]>(blobId.slice(6));
    const url = `${graphBase}/me/messages/${encodeURIComponent(message)}/attachments/${encodeURIComponent(attachment)}`;
    const a = await this.api<GraphAttachment>(url);
    if (a.contentBytes !== undefined) return { type: a.contentType ?? "application/octet-stream", data: Buffer.from(a.contentBytes, "base64") };
    if (a["@odata.type"] === "#microsoft.graph.referenceAttachment") throw new NotImplementedError("Graph cloud reference attachments must be downloaded through their owning service");
    return { type: a.contentType ?? "message/rfc822", data: new Uint8Array(await (await this.http(`${url}/$value`, { headers: { Prefer: 'IdType="ImmutableId"' } })).arrayBuffer()) };
  }
  async applyChanges(changes: MailChange[]): Promise<MailChangeResult[]> {
    const results: MailChangeResult[] = [];
    for (const c of changes) for (const id of c.providerIds) {
      const path = `${graphBase}/me/messages/${encodeURIComponent(id)}`;
      if (c.op === "setKeywords") {
        const patch: Record<string, unknown> = {}, categories = new Set<string>();
        if ([...(c.add ?? []), ...(c.remove ?? [])].some(k => k.startsWith("label:"))) {
          const current = await this.api<GraphMessage>(path); for (const category of current.categories ?? []) categories.add(category);
        }
        for (const [list, value] of [[c.add ?? [], true], [c.remove ?? [], false]] as const) for (const keyword of list) {
          if (keyword === "$seen") patch.isRead = value;
          else if (keyword === "$flagged") patch.flag = { flagStatus: value ? "flagged" : "notFlagged" };
          else if (keyword.startsWith("label:")) { if (value) categories.add(keyword.slice(6)); else categories.delete(keyword.slice(6)); patch.categories = [...categories]; }
          else throw new ProviderError("UNSUPPORTED_KEYWORD", `Graph cannot directly set keyword ${keyword}`);
        }
        if (Object.keys(patch).length) await this.empty(path, this.body(patch, "PATCH"));
      } else if (c.op === "removeFromMailbox") throw new NotImplementedError("Graph messages require one folder; use move with a destination folder");
      else {
        const destinationId = c.op === "delete" ? "deleteditems" : c.op === "move" ? c.toMailboxProviderId : c.mailboxProviderId;
        const moved = await this.api<GraphMessage>(`${path}/${c.op === "addToMailbox" ? "copy" : "move"}`, this.body({ destinationId }));
        if (!moved?.id) throw new ProviderError("INVALID_RESPONSE", "Graph did not return the moved message identity; resync before retrying");
        results.push({ op: c.op, providerId: id, newProviderId: moved.id, newMailboxProviderId: moved.parentFolderId ?? destinationId });
      }
    }
    return results;
  }
  private async draftBody(draft: DraftInput): Promise<Record<string, unknown>> {
    this.check(); if (draft.accountId !== this.account.id) throw new ProviderError("ACCOUNT_MISMATCH", "Draft belongs to another account");
    const addresses = (a: DraftInput["to"] = []) => a.map(v => ({ emailAddress: { address: v.email, name: v.name ?? "" } }));
    return { subject: draft.subject, body: { contentType: draft.htmlBody ? "HTML" : "Text", content: draft.htmlBody ?? draft.textBody },
      toRecipients: addresses(draft.to), ccRecipients: addresses(draft.cc), bccRecipients: addresses(draft.bcc),
      attachments: await Promise.all((draft.attachments ?? []).map(async a => ({ "@odata.type": "#microsoft.graph.fileAttachment", name: a.name, contentType: a.type, contentBytes: Buffer.from((await this.getBlob(a.blobId)).data).toString("base64") }))) };
  }
  async createDraft(draft: DraftInput): Promise<Email> {
    const body = await this.draftBody(draft); let message: GraphMessage;
    if (draft.inReplyToEmailId) {
      const reply = await this.reply(draft.inReplyToEmailId, id => this.getEmail(id));
      message = await this.api<GraphMessage>(`${graphBase}/me/messages/${encodeURIComponent(reply!.providerId)}/createReply`, this.body({}));
      return this.updateDraft(message.id, draft);
    }
    message = await this.api<GraphMessage>(`${graphBase}/me/messages`, this.body(body));
    return this.requireEmail(message.id);
  }
  private async requireEmail(id: string): Promise<Email> { const e = await this.getEmail(id); if (!e) throw new ProviderError("NOT_FOUND", "Graph draft does not exist"); return e; }
  async updateDraft(providerId: string, draft: DraftInput): Promise<Email> {
    const existing = await this.requireEmail(providerId); if (!existing.keywords.$draft) throw new ProviderError("NOT_A_DRAFT", "Graph message is not a draft");
    const { attachments, ...body } = await this.draftBody(draft);
    await this.empty(`${graphBase}/me/messages/${encodeURIComponent(providerId)}`, this.body(body, "PATCH"));
    for (const a of existing.attachments) {
      const [, attachmentId] = decodeCursor<[string, string]>(a.blobId.slice(6));
      await this.empty(`${graphBase}/me/messages/${encodeURIComponent(providerId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    }
    for (const a of attachments as unknown[]) await this.empty(`${graphBase}/me/messages/${encodeURIComponent(providerId)}/attachments`, this.body(a));
    return this.requireEmail(providerId);
  }
  async deleteDraft(providerId: string): Promise<void> {
    if (!(await this.requireEmail(providerId)).keywords.$draft) throw new ProviderError("NOT_A_DRAFT", "Graph message is not a draft");
    await this.empty(`${graphBase}/me/messages/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  }
  async send(input: { draftProviderId?: string; draft?: DraftInput }): Promise<SendResult> {
    assertSend(input);
    // Graph's 202 response has no sent message ID. Create a draft first to retain a real immutable ID.
    const email = input.draft ? await this.createDraft(input.draft) : await this.requireEmail(input.draftProviderId!);
    if (!email.keywords.$draft) throw new ProviderError("NOT_A_DRAFT", "Graph message is not a draft");
    await this.empty(`${graphBase}/me/messages/${encodeURIComponent(email.providerId)}/send`, { method: "POST" });
    return { providerId: email.providerId, messageId: email.headers.messageId, threadId: email.threadId };
  }
}
