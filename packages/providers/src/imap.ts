import type {
  Account,
  AccountCapabilities,
  AccountCredentials,
  DraftInput,
  Email,
  MailChange,
  MailChangeResult,
  MailProvider,
  MailReader,
  SendResult,
  SyncDelta,
} from "@passport/types";
import { type FetchMessageObject, ImapFlow, type ImapFlowOptions } from "imapflow";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import {
  assertSend,
  decodeCursor,
  encodeCursor,
  localId,
  ProviderError,
  required,
  SubmissionAcceptedError,
} from "./errors.js";
import type { ProviderOptions } from "./http.js";
import { ImapMailReader } from "./imap-reader.js";
import {
  imapFlagMap as flagMap,
  imapIdentity as identity,
  imapRole,
  normalizeImapSource,
  parseImapIdentity as parseIdentity,
} from "./imap-reader-shared.js";
import { type ImapExtension, probeImapExtensions } from "./imap-reader-support.js";
import { composeMime, decodeMimeBlob, mimeAttachment } from "./normalize/index.js";
import { resolveReplyEmail } from "./reply.js";

export interface SmtpClient {
  sendMail(message: SendMailOptions): Promise<{ messageId?: string }>;
  close(): void;
}
export interface ImapProviderOptions extends ProviderOptions {
  imapFactory?: (options: ImapFlowOptions) => ImapFlow;
  smtpFactory?: (options: SMTPTransport.Options) => SmtpClient;
}
interface FolderState {
  validity: string;
  next: number;
  modseq: string | null;
  uids: number[];
}
interface ImapCursor {
  account: string;
  since?: string;
  folders: Record<string, FolderState>;
}
export const imapCapabilities: AccountCapabilities = {
  mail: true,
  calendar: false,
  contacts: false,
  push: true,
  labels: false,
  submit: true,
  search: true,
  onDemand: true,
};
export { imapFlagsToKeywords } from "./imap-reader-shared.js";
/** IMAP folder+UIDVALIDITY+UID identities deliberately change on copy/move. */
export class ImapMailProvider implements MailProvider {
  readonly kind = "imap" as const;
  readonly capabilities = imapCapabilities;
  private account!: Account;
  private client?: ImapFlow;
  private smtp?: SmtpClient;
  private terminalError?: ProviderError;
  private mailReader?: ImapMailReader;
  private probed = new Set<ImapExtension>();
  /** Recent move/copy destinations, searched by `reader().findByRfc822`. */
  private readonly moveTargets = new Set<string>();
  constructor(private readonly options: ImapProviderOptions = {}) {}
  /**
   * Extensions probed on connect (ESEARCH, SORT, THREAD=REFERENCES, CONDSTORE, QRESYNC, OBJECTID,
   * X-GM-EXT-1, MOVE, IDLE). Kept in memory: the adapter has no hook to persist Account.settings.
   */
  get extensions(): ReadonlySet<ImapExtension> {
    return this.probed;
  }
  /** On-demand reader over the connected IMAP session (one instance per provider). */
  reader(): MailReader {
    this.mailReader ??= new ImapMailReader({
      account: () => {
        this.check();
        return this.account;
      },
      client: () => this.check(),
      extensions: () => this.probed,
      moveTargets: () => this.moveTargets,
      options: this.options,
    });
    return this.mailReader;
  }
  async connect(account: Account, credentials: AccountCredentials): Promise<void> {
    if (this.client) {
      throw new ProviderError(
        "ALREADY_CONNECTED",
        "Disconnect the IMAP provider before connecting again",
      );
    }
    this.account = structuredClone(account);
    this.terminalError = undefined;
    const auth = credentials.access_token
      ? {
          user: String(account.settings.username ?? account.emailAddress),
          accessToken: credentials.access_token,
        }
      : {
          user: String(account.settings.username ?? account.emailAddress),
          pass: required(credentials.password, "password or access_token"),
        };
    this.client = (this.options.imapFactory ?? ((o) => new ImapFlow(o)))({
      host: required(account.settings.host, "host"),
      port: Number(account.settings.port ?? 993),
      secure: account.settings.tls !== false,
      doSTARTTLS: account.settings.tls === false ? true : undefined,
      auth,
      logger: false,
      qresync: true,
      maxIdleTime: 240_000,
    });
    this.client.on("error", () => {
      this.terminalError = new ProviderError(
        "IMAP_CONNECTION_ERROR",
        "IMAP connection failed; reconnect before retrying",
      );
    });
    try {
      await this.client.connect();
      this.probed = probeImapExtensions(this.client);
    } catch {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      this.client.close();
      this.client = undefined;
      throw new ProviderError("IMAP_CONNECT_FAILED", "IMAP connection or authentication failed");
    }
    const smtpHost = account.settings.smtpHost;
    if (typeof smtpHost === "string" && smtpHost) {
      const user = String(
        account.settings.smtpUsername ?? account.settings.username ?? account.emailAddress,
      );
      this.smtp = (this.options.smtpFactory ?? ((o) => nodemailer.createTransport(o)))({
        host: smtpHost,
        port: Number(account.settings.smtpPort ?? 465),
        secure: account.settings.smtpTls !== false,
        requireTLS: account.settings.smtpTls === false,
        logger: false,
        debug: false,
        auth:
          credentials.smtpAccessToken || credentials.access_token
            ? {
                type: "OAuth2",
                user,
                accessToken: credentials.smtpAccessToken ?? credentials.access_token,
              }
            : { user, pass: credentials.smtpPassword ?? credentials.password },
      });
    }
  }
  private check(): ImapFlow {
    if (this.terminalError) {
      throw this.terminalError;
    }
    if (!this.client) {
      throw new ProviderError("NOT_CONNECTED", "Connect the IMAP provider first");
    }
    return this.client;
  }
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      if (e instanceof ProviderError) {
        throw e;
      }
      throw new ProviderError("IMAP_ERROR", "IMAP operation failed");
    }
  }
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.smtp?.close();
    this.smtp = undefined;
    if (client) {
      await this.guard(async () => {
        try {
          await client.logout();
        } finally {
          client.close();
        }
      });
    }
  }
  private normalize(message: FetchMessageObject, path: string, validity: string): Promise<Email> {
    return normalizeImapSource(message, {
      accountId: this.account.id,
      path,
      validity,
      verifier: this.options.verifier,
    });
  }
  async checkConnection(): Promise<void> {
    await this.guard(() => this.check().noop());
  }
  async *sync(cursor: string | null, opts: { since?: string } = {}): AsyncIterable<SyncDelta> {
    try {
      const client = this.check(),
        previous: ImapCursor = cursor
          ? decodeCursor<ImapCursor>(cursor)
          : { account: this.account.id, folders: {} };
      if (previous.account !== this.account.id || !previous.folders) {
        throw new ProviderError("INVALID_CURSOR", "Invalid IMAP account cursor");
      }
      const since = previous.since ?? opts.since;
      const next: ImapCursor = { account: this.account.id, since, folders: {} },
        folders = (await client.list()).filter((f) => !f.flags.has("\\Noselect"));
      for (const [path, saved] of Object.entries(previous.folders)) {
        if (!folders.some((f) => f.path === path)) {
          yield { kind: "mailbox", op: "delete", id: localId(this.account.id, "mailbox", path) };
          for (const uid of saved.uids) {
            yield { kind: "email", op: "delete", providerId: identity(path, saved.validity, uid) };
          }
        }
      }
      for (const folder of folders) {
        const lock = await client.getMailboxLock(folder.path);
        try {
          const selected = client.mailbox;
          if (!selected) {
            throw new ProviderError("IMAP_ERROR", "IMAP mailbox selection failed");
          }
          const validity = String(selected.uidValidity),
            modseq = selected.highestModseq ? String(selected.highestModseq) : null,
            uidNext = selected.uidNext;
          const old = previous.folders[folder.path],
            same = old?.validity === validity;
          const uids = await client.search(since ? { since: new Date(since) } : { all: true }, {
            uid: true,
          });
          if (!Array.isArray(uids)) {
            throw new ProviderError("IMAP_ERROR", "IMAP UID enumeration failed");
          }
          const current = new Set(uids);
          if (old) {
            for (const uid of old.uids) {
              if (!same || !current.has(uid)) {
                yield {
                  kind: "email",
                  op: "delete",
                  providerId: identity(folder.path, old.validity, uid),
                };
              }
            }
          }
          const status = await client.status(folder.path, { messages: true, unseen: true });
          yield {
            kind: "mailbox",
            op: "upsert",
            mailbox: {
              id: localId(this.account.id, "mailbox", folder.path),
              accountId: this.account.id,
              providerId: folder.path,
              name: folder.name,
              role: imapRole(folder),
              parentId: folder.parentPath
                ? localId(this.account.id, "mailbox", folder.parentPath)
                : null,
              totalEmails: status ? (status.messages ?? uids.length) : uids.length,
              unreadEmails: status ? (status.unseen ?? 0) : 0,
            },
          };
          if (uids.length) {
            const changedSince = same && old.modseq && modseq ? BigInt(old.modseq) : undefined;
            // Enumerate UIDs for expunges even with CONDSTORE. FETCH only changed bodies when possible.
            const ranges = since
              ? Array.from({ length: Math.ceil(uids.length / 100) }, (_, i) =>
                  uids.slice(i * 100, i * 100 + 100).join(","),
                )
              : ["1:*"];
            for (const range of ranges) {
              for await (const message of client.fetch(
                range,
                { uid: true, flags: true, source: true, internalDate: true },
                { uid: true, ...(changedSince ? { changedSince } : {}) },
              )) {
                if (
                  current.has(message.uid) &&
                  (!since ||
                    !message.internalDate ||
                    new Date(message.internalDate).getTime() >= Date.parse(since))
                ) {
                  yield {
                    kind: "email",
                    op: "upsert",
                    email: await this.normalize(message, folder.path, validity),
                  };
                }
              }
            }
          }
          next.folders[folder.path] = {
            validity,
            next: uidNext ?? Math.max(0, ...uids) + 1,
            modseq,
            uids,
          };
        } finally {
          lock.release();
        }
      }
      yield { kind: "cursor", cursor: encodeCursor(next) };
    } catch (e) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      if (e instanceof ProviderError) {
        throw e;
      }
      throw new ProviderError("IMAP_SYNC_FAILED", "IMAP synchronization failed");
    }
  }
  private async withMessage<T>(
    providerId: string,
    fn: (client: ImapFlow, path: string, validity: string, uid: number) => Promise<T>,
  ): Promise<T> {
    return this.guard(async () => {
      const client = this.check(),
        [path, validity, uid] = parseIdentity(providerId),
        lock = await client.getMailboxLock(path);
      try {
        if (!client.mailbox || String(client.mailbox.uidValidity) !== validity) {
          throw new ProviderError("STALE_ID", "IMAP UIDVALIDITY changed; resync this mailbox");
        }
        return await fn(client, path, validity, uid);
      } finally {
        lock.release();
      }
    });
  }
  async getEmail(providerId: string): Promise<Email | null> {
    try {
      return await this.withMessage(providerId, async (client, path, validity, uid) => {
        const message = await client.fetchOne(
          uid,
          { uid: true, flags: true, source: true, internalDate: true },
          { uid: true },
        );
        return message ? this.normalize(message, path, validity) : null;
      });
    } catch (e) {
      // A stale IMAP identity means the original message no longer exists.

      if (e instanceof ProviderError && e.code === "STALE_ID") {
        return null;
      }
      throw e;
    }
  }
  async getBlob(blobId: string): Promise<{ type: string; data: Uint8Array }> {
    const [id, index] = decodeMimeBlob(blobId);
    return this.withMessage(id, async (client, _path, _validity, uid) => {
      const message = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!message || !message.source) {
        throw new ProviderError("NOT_FOUND", "IMAP message source is missing");
      }
      return mimeAttachment(message.source, index);
    });
  }
  private async folder(role: string): Promise<string> {
    const configured = this.account.settings[`${role}Folder`];
    if (typeof configured === "string") {
      return configured;
    }
    const names: Record<string, string> = { drafts: "\\Drafts", sent: "\\Sent", trash: "\\Trash" };
    const found = (await this.check().list()).find((f) => f.specialUse === names[role]);
    if (!found) {
      throw new ProviderError("MAILBOX_NOT_FOUND", `Configure ${role}Folder for this IMAP server`);
    }
    return found.path;
  }
  async applyChanges(changes: MailChange[]): Promise<MailChangeResult[]> {
    const results: MailChangeResult[] = [];
    for (const c of changes) {
      let destination: string | undefined;
      if (c.op === "delete") {
        destination = await this.folder("trash");
      } else if (c.op === "move") {
        destination = c.toMailboxProviderId;
      } else if (c.op === "addToMailbox") {
        destination = c.mailboxProviderId;
      }
      for (const id of c.providerIds) {
        await this.withMessage(id, async (client, path, _validity, uid) => {
          if (c.op === "setKeywords") {
            if (
              c.add?.length &&
              !(await client.messageFlagsAdd(
                uid,
                c.add.map((k) => flagMap[k] ?? k),
                { uid: true },
              ))
            ) {
              throw new ProviderError("IMAP_ERROR", "IMAP flag update failed");
            }
            if (
              c.remove?.length &&
              !(await client.messageFlagsRemove(
                uid,
                c.remove.map((k) => flagMap[k] ?? k),
                { uid: true },
              ))
            ) {
              throw new ProviderError("IMAP_ERROR", "IMAP flag update failed");
            }
          } else {
            const target =
              c.op === "removeFromMailbox"
                ? path === c.mailboxProviderId
                  ? await this.folder("trash")
                  : undefined
                : destination;
            if (!target || path === target) {
              return;
            }
            this.moveTargets.add(target);
            const result =
              c.op === "addToMailbox"
                ? await client.messageCopy(uid, target, { uid: true })
                : await client.messageMove(uid, target, { uid: true });
            if (!result) {
              throw new ProviderError("IMAP_ERROR", "IMAP copy or move failed");
            }
            const newUid = result.uidMap?.get(uid);
            if (!result.uidValidity || !newUid) {
              throw new ProviderError(
                "IMAP_UIDPLUS_REQUIRED",
                "Mail changed folders without COPYUID; resync before retrying",
              );
            }
            results.push({
              op: c.op,
              providerId: id,
              newProviderId: identity(target, String(result.uidValidity), newUid),
              newMailboxProviderId: target,
            });
          }
        });
      }
    }
    return results;
  }
  private async raw(draft: DraftInput): Promise<Buffer> {
    this.check();
    const reply = await resolveReplyEmail(
      this.account.id,
      draft.inReplyToEmailId,
      (id) => this.getEmail(id),
      this.options.resolveEmail,
    );
    return composeMime(this.account, draft, (id) => this.getBlob(id), reply);
  }
  async createDraft(draft: DraftInput): Promise<Email> {
    return this.guard(async () => {
      const path = await this.folder("drafts"),
        result = await this.check().append(path, await this.raw(draft), ["\\Draft", "\\Seen"]);
      if (!result || !result.uid || !result.uidValidity) {
        throw new ProviderError(
          "IMAP_UIDPLUS_REQUIRED",
          "Draft was appended, but the server did not return APPENDUID; resync Drafts before retrying",
        );
      }
      const email = await this.getEmail(identity(path, String(result.uidValidity), result.uid));
      if (!email) {
        throw new ProviderError("NOT_FOUND", "Appended IMAP draft was not readable");
      }
      return email;
    });
  }
  async updateDraft(providerId: string, draft: DraftInput): Promise<Email> {
    if (!(await this.getEmail(providerId))?.keywords.$draft) {
      throw new ProviderError("NOT_A_DRAFT", "IMAP message is not a draft");
    }
    const replacement = await this.createDraft(draft);
    await this.deleteDraft(providerId);
    return replacement;
  }
  async deleteDraft(providerId: string): Promise<void> {
    if (!(await this.getEmail(providerId))?.keywords.$draft) {
      throw new ProviderError("NOT_A_DRAFT", "IMAP message is not a draft");
    }
    await this.withMessage(providerId, async (client, _path, _validity, uid) => {
      if (!(await client.messageDelete(uid, { uid: true }))) {
        throw new ProviderError("IMAP_ERROR", "IMAP draft removal failed");
      }
    });
  }
  async send(input: { draftProviderId?: string; draft?: DraftInput }): Promise<SendResult> {
    assertSend(input);
    this.check();
    if (!this.smtp) {
      throw new ProviderError("SMTP_NOT_CONFIGURED", "Configure smtpHost to submit IMAP mail");
    }
    let raw: Buffer,
      email: Email | null = null;
    if (input.draft) {
      raw = await this.raw(input.draft);
    } else {
      email = await this.getEmail(input.draftProviderId!);
      if (!email?.keywords.$draft) {
        throw new ProviderError("NOT_A_DRAFT", "IMAP draft does not exist");
      }
      raw = await this.withMessage(email.providerId, async (client, _path, _validity, uid) => {
        const m = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!m || !m.source) {
          throw new ProviderError("NOT_FOUND", "IMAP draft source is missing");
        }
        return m.source;
      });
    }
    const recipients = input.draft
      ? [...input.draft.to, ...(input.draft.cc ?? []), ...(input.draft.bcc ?? [])]
      : [...email!.to, ...email!.cc, ...email!.bcc];
    let result: { messageId?: string };
    // Raw SMTP input bypasses Nodemailer's header filtering. Retain Bcc only in the private sent copy.
    const separator = raw.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n",
      split = raw.indexOf(separator);
    const wire =
      split < 0
        ? raw
        : Buffer.concat([
            Buffer.from(
              raw
                .subarray(0, split)
                .toString()
                .replace(/^bcc:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*\r?\n?/gim, ""),
            ),
            Buffer.from(separator),
            raw.subarray(split + separator.length),
          ]);
    try {
      result = await this.smtp.sendMail({
        raw: wire,
        envelope: { from: this.account.emailAddress, to: recipients.map((r) => r.email) },
      });
    } catch {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      throw new ProviderError("SMTP_SEND_FAILED", "SMTP submission failed");
    }
    // SMTP has already accepted the message: never report a retryable send failure for sent-copy cleanup.
    const messageId = result.messageId ?? email?.headers.messageId ?? null;
    try {
      const path = await this.folder("sent"),
        appended = await this.check().append(path, raw, ["\\Seen"]);
      if (!appended || !appended.uid || !appended.uidValidity) {
        throw new SubmissionAcceptedError(messageId);
      }
      if (email) {
        await this.deleteDraft(email.providerId);
      }
      return { providerId: identity(path, String(appended.uidValidity), appended.uid), messageId };
    } catch {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      throw new SubmissionAcceptedError(messageId);
    }
  }
  async waitForChanges(signal: AbortSignal): Promise<void> {
    const client = this.check();
    if (signal.aborted) {
      return;
    }
    if (!client.mailbox || client.mailbox.path.toUpperCase() !== "INBOX") {
      const lock = await client.getMailboxLock("INBOX");
      lock.release();
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        for (const event of ["exists", "flags", "expunge", "close", "error"]) {
          client.off(event, done);
        }
        signal.removeEventListener("abort", done);
        resolve();
      };
      for (const event of ["exists", "flags", "expunge", "close", "error"]) {
        client.on(event, done);
      }
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) {
        done();
      }
    });
  }
}
