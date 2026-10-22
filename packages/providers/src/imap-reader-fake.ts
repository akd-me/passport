/**
 * Test double for the IMAP reader: an in-memory server with the slice of the imapflow API the
 * reader uses (LIST, SELECT locks, STATUS, SEARCH incl. ESEARCH COUNT, `exec` for UID SORT,
 * FETCH incl. CHANGEDSINCE/VANISHED). Every command is appended to `log`. Not exported from the
 * package index.
 */
import { EventEmitter } from "node:events";
import type { ImapFlow, SearchObject } from "imapflow";

export interface FakeMessageInput {
  from: string;
  to?: string;
  subject: string;
  messageId: string;
  date: string;
  body?: string;
  inReplyTo?: string;
  references?: string;
  listId?: string;
  attachment?: string;
  flags?: string[];
  threadId?: string;
}

interface FakeMessage extends Omit<FakeMessageInput, "flags"> {
  uid: number;
  flags: Set<string>;
  modseq: bigint;
  source: Buffer;
}

interface FakeFolder {
  path: string;
  specialUse?: string;
  validity: bigint;
  uidNext: number;
  messages: Map<number, FakeMessage>;
  vanished: Array<{ uid: number; modseq: bigint }>;
}

function address(value: string): { name?: string; address: string } {
  const match = /^(.*)<([^>]+)>$/.exec(value.trim());
  return match?.[1]?.trim()
    ? { name: match[1].trim(), address: match[2] as string }
    : { address: (match?.[2] ?? value).trim() };
}

function mime(m: FakeMessageInput): Buffer {
  const head = [
    `From: ${m.from}`,
    `To: ${m.to ?? "Alex <alex@example.com>"}`,
    `Subject: ${m.subject}`,
    `Message-ID: ${m.messageId}`,
    `Date: ${new Date(m.date).toUTCString()}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    ...(m.listId ? [`List-Id: ${m.listId}`] : []),
    "MIME-Version: 1.0",
  ];
  const text = m.body ?? "Hello";
  if (!m.attachment) {
    return Buffer.from(
      [...head, "Content-Type: text/plain; charset=utf-8", "", text, ""].join("\r\n"),
    );
  }
  return Buffer.from(
    [
      ...head,
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      "--b1",
      `Content-Type: application/pdf; name="${m.attachment}"`,
      `Content-Disposition: attachment; filename="${m.attachment}"`,
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0=",
      "--b1--",
      "",
    ].join("\r\n"),
  );
}

const includes = (haystack: string | undefined, needle: string) =>
  (haystack ?? "").toLowerCase().includes(needle.toLowerCase());

export class FakeImapServer extends EventEmitter {
  readonly log: string[] = [];
  readonly capabilities: Map<string, boolean>;
  readonly enabled: Set<string>;
  readonly folders = new Map<string, FakeFolder>();
  private selected: FakeFolder | undefined;
  private modseq = 10n;

  constructor(caps: string[] = []) {
    super();
    this.capabilities = new Map(caps.map((c) => [c, true]));
    this.enabled = new Set(caps.filter((c) => c === "CONDSTORE" || c === "QRESYNC"));
    for (const [path, specialUse] of [
      ["INBOX", "\\Inbox"],
      ["Sent", "\\Sent"],
      ["Drafts", "\\Drafts"],
      ["Trash", "\\Trash"],
      ["Archive", "\\Archive"],
      ["Projects", undefined],
    ] as const) {
      this.folders.set(path, {
        path,
        ...(specialUse ? { specialUse } : {}),
        validity: 7n,
        uidNext: 1,
        messages: new Map(),
        vanished: [],
      });
    }
  }

  get client(): ImapFlow {
    return this as unknown as ImapFlow;
  }

  get mailbox() {
    const f = this.selected;
    if (!f) {
      return false;
    }
    return {
      path: f.path,
      uidValidity: f.validity,
      uidNext: f.uidNext,
      exists: f.messages.size,
      ...(this.enabled.has("CONDSTORE") ? { highestModseq: this.modseq } : {}),
    };
  }

  folder(path: string): FakeFolder {
    const f = this.folders.get(path);
    if (!f) {
      throw new Error(`No folder ${path}`);
    }
    return f;
  }

  add(path: string, input: FakeMessageInput): number {
    const f = this.folder(path);
    const uid = f.uidNext++;
    f.messages.set(uid, {
      ...input,
      uid,
      flags: new Set(input.flags ?? []),
      modseq: ++this.modseq,
      source: mime(input),
    });
    return uid;
  }

  setFlags(path: string, uid: number, flags: string[]): void {
    const m = this.folder(path).messages.get(uid);
    if (m) {
      m.flags = new Set(flags);
      m.modseq = ++this.modseq;
    }
  }

  expunge(path: string, uid: number): void {
    const f = this.folder(path);
    f.messages.delete(uid);
    f.vanished.push({ uid, modseq: ++this.modseq });
  }

  resetValidity(path: string): void {
    this.folder(path).validity++;
  }

  // --- imapflow surface ------------------------------------------------------------------

  async connect() {}
  async logout() {}
  close() {}
  async noop() {}

  async list() {
    this.log.push("LIST");
    return [...this.folders.values()].map((f) => ({
      path: f.path,
      name: f.path,
      flags: new Set<string>(),
      specialUse: f.specialUse,
      parentPath: "",
      delimiter: "/",
    }));
  }

  async getMailboxLock(path: string) {
    if (this.selected?.path !== path) {
      this.log.push(`SELECT ${path}`);
    }
    this.selected = this.folder(path);
    return { path, release() {} };
  }

  async status(path: string) {
    this.log.push(`STATUS ${path}`);
    const f = this.folder(path);
    const unseen = [...f.messages.values()].filter((m) => !m.flags.has("\\Seen")).length;
    return { path, messages: f.messages.size, unseen };
  }

  async search(query: SearchObject, options: { returnOptions?: string[] } = {}) {
    const uids = this.matching(query);
    if (options.returnOptions && this.capabilities.has("ESEARCH")) {
      this.log.push(`UID SEARCH RETURN (${options.returnOptions.join(" ")})`);
      return { count: uids.length };
    }
    this.log.push(`UID SEARCH ${JSON.stringify(query)}`);
    return uids;
  }

  /** Only `UID SORT (REVERSE ARRIVAL) UTF-8 <criteria>` with ALL / FROM / SUBJECT / UNSEEN. */
  async exec(
    command: string,
    attributes: unknown[],
    options: { untagged?: Record<string, (u: { numbers: number[] }) => Promise<void>> } = {},
  ) {
    this.log.push(command);
    if (command !== "UID SORT") {
      throw new Error(`Unsupported command ${command}`);
    }
    const flat = attributes.slice(2) as Array<{ value: string }>;
    const query: SearchObject = {};
    for (let i = 0; i < flat.length; i++) {
      const key = flat[i]?.value.toUpperCase();
      if (key === "FROM" || key === "SUBJECT") {
        query[key === "FROM" ? "from" : "subject"] = flat[++i]?.value;
      } else if (key === "UNSEEN") {
        query.seen = false;
      }
    }
    const sorted = this.matching(query).sort((a, b) => b - a);
    await options.untagged?.SORT?.({ numbers: sorted });
    return { next() {} };
  }

  async *fetch(
    range: string,
    query: Record<string, unknown>,
    options: { changedSince?: bigint } = {},
  ) {
    const f = this.selected as FakeFolder;
    this.log.push(
      options.changedSince ? `UID FETCH CHANGEDSINCE ${options.changedSince}` : "UID FETCH",
    );
    let wanted: number[];
    if (range === "1:*") {
      wanted = [...f.messages.keys()];
    } else {
      wanted = range.split(",").map(Number);
    }
    if (options.changedSince !== undefined && this.enabled.has("QRESYNC")) {
      for (const v of f.vanished.filter((x) => x.modseq > (options.changedSince as bigint))) {
        this.emit("expunge", { path: f.path, uid: v.uid, vanished: true, earlier: true });
      }
    }
    for (const uid of wanted) {
      const m = f.messages.get(uid);
      if (!m || (options.changedSince !== undefined && m.modseq <= options.changedSince)) {
        continue;
      }
      yield this.project(m, query);
    }
  }

  private project(m: FakeMessage, query: Record<string, unknown>) {
    const source = query.source as boolean | { maxLength?: number } | undefined;
    const headers = (query.headers as string[] | undefined) ?? [];
    const headerLines = m.source
      .toString()
      .split("\r\n\r\n")[0]
      ?.split("\r\n")
      .filter((line) => headers.includes(line.slice(0, line.indexOf(":")).toLowerCase()));
    const gmail = this.capabilities.has("X-GM-EXT-1") || this.capabilities.has("OBJECTID");
    return {
      seq: m.uid,
      uid: m.uid,
      modseq: m.modseq,
      flags: new Set(m.flags),
      internalDate: new Date(m.date),
      size: m.source.length,
      envelope: {
        date: new Date(m.date),
        subject: m.subject,
        messageId: m.messageId,
        inReplyTo: m.inReplyTo,
        from: [address(m.from)],
        to: [address(m.to ?? "Alex <alex@example.com>")],
      },
      bodyStructure: m.attachment
        ? {
            type: "multipart/mixed",
            childNodes: [
              { part: "1", type: "text/plain", size: 5 },
              {
                part: "2",
                type: "application/pdf",
                disposition: "attachment",
                dispositionParameters: { filename: m.attachment },
                size: 5,
              },
            ],
          }
        : { type: "text/plain", size: 5 },
      headers: Buffer.from(`${(headerLines ?? []).join("\r\n")}\r\n`),
      ...(source
        ? {
            source:
              typeof source === "object" && source.maxLength
                ? m.source.subarray(0, source.maxLength)
                : m.source,
          }
        : {}),
      ...(gmail && query.threadId && m.threadId ? { threadId: m.threadId } : {}),
    };
  }

  private matching(query: SearchObject): number[] {
    const f = this.selected as FakeFolder;
    return [...f.messages.values()].filter((m) => this.matches(m, query)).map((m) => m.uid);
  }

  private matches(m: FakeMessage, q: SearchObject): boolean {
    const header = (name: string) =>
      new RegExp(`^${name}: (.*)$`, "im").exec(m.source.toString().split("\r\n\r\n")[0] ?? "")?.[1];
    const checks: boolean[] = [
      q.seen === undefined || m.flags.has("\\Seen") === q.seen,
      q.flagged === undefined || m.flags.has("\\Flagged") === q.flagged,
      q.from === undefined || includes(m.from, q.from),
      q.to === undefined || includes(m.to ?? "alex@example.com", q.to),
      q.subject === undefined || includes(m.subject, q.subject),
      q.larger === undefined || m.source.length > q.larger,
      q.since === undefined || Date.parse(m.date) >= new Date(q.since).getTime(),
      q.before === undefined || Date.parse(m.date) < new Date(q.before).getTime(),
      q.threadId === undefined || m.threadId === q.threadId,
      q.uid === undefined || m.uid >= Number(String(q.uid).split(":")[0]),
      Object.entries(q.header ?? {}).every(([k, v]) => includes(header(k), String(v))),
      q.not === undefined || !this.matches(m, q.not),
      q.or === undefined || q.or.some((o) => this.matches(m, o)),
    ];
    return checks.every(Boolean);
  }
}
