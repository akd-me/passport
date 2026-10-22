import { GraphMailProvider } from "../graph.js";
import type { GraphReaderOptions } from "../graph-reader.js";
import type { ProviderOptions } from "../http.js";
import { account, fixtureFetch, response } from "./helpers.js";

/** One request the fake Graph saw (`$batch` inner requests are recorded with `batch: true`). */
export interface SeenRequest {
  method: string;
  url: URL;
  headers: Headers;
  batch: boolean;
}

export interface FakeReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

type Route = (url: URL, request: SeenRequest) => FakeReply | undefined;

const folders = [
  {
    id: "id-inbox",
    displayName: "Inbox",
    childFolderCount: 1,
    totalItemCount: 10,
    unreadItemCount: 3,
  },
  { id: "id-sent", displayName: "Sent Items", totalItemCount: 4, unreadItemCount: 0 },
  { id: "id-junk", displayName: "Junk Email", totalItemCount: 2, unreadItemCount: 2 },
  { id: "id-deleted", displayName: "Deleted Items", totalItemCount: 1, unreadItemCount: 1 },
  { id: "id-drafts", displayName: "Drafts", totalItemCount: 0, unreadItemCount: 0 },
].map((f) => ({ parentFolderId: "id-root", childFolderCount: 0, ...f }));
const children = [
  {
    id: "id-projects",
    displayName: "Projects",
    parentFolderId: "id-inbox",
    childFolderCount: 0,
    totalItemCount: 5,
    unreadItemCount: 1,
  },
];
const wellKnown: Record<string, string> = {
  inbox: "id-inbox",
  sentitems: "id-sent",
  junkemail: "id-junk",
  deleteditems: "id-deleted",
  drafts: "id-drafts",
};

/** A Graph message with the reader's row columns. */
export function message(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    conversationId: `conv-${id}`,
    internetMessageId: `<${id}@example.com>`,
    receivedDateTime: "2026-10-20T10:00:00Z",
    from: { emailAddress: { address: "sam@example.com", name: "Sam" } },
    toRecipients: [{ emailAddress: { address: "alex@example.com" } }],
    subject: `Subject ${id}`,
    bodyPreview: `Preview ${id}`,
    isRead: false,
    flag: { flagStatus: "notFlagged" },
    hasAttachments: false,
    parentFolderId: "id-inbox",
    categories: [],
    ...overrides,
  };
}

/** In-memory Graph mailbox: folders, categories and messages by id; tests add routes. */
export class FakeGraph {
  readonly seen: SeenRequest[] = [];
  readonly routes: Route[] = [];
  readonly messages = new Map<string, Record<string, unknown>>();
  readonly sleeps: number[] = [];
  readonly fetch = fixtureFetch((url, init) => this.handle(url, init));

  /** Requests other than `$batch` envelopes, optionally filtered by path suffix. */
  gets(suffix = ""): SeenRequest[] {
    return this.seen.filter(
      (r) => !r.url.pathname.endsWith("/$batch") && r.url.pathname.endsWith(suffix),
    );
  }

  async connect(options: ProviderOptions & { reader?: GraphReaderOptions } = {}) {
    const provider = new GraphMailProvider({
      fetch: this.fetch,
      sleep: async (ms) => {
        this.sleeps.push(ms);
      },
      now: () => new Date("2026-10-22T12:00:00Z"),
      ...options,
    });
    await provider.connect(account, { access_token: "token" });
    return provider.reader();
  }

  private handle(url: URL, init: RequestInit): Response {
    const request: SeenRequest = {
      method: init.method ?? "GET",
      url,
      headers: new Headers(init.headers),
      batch: false,
    };
    this.seen.push(request);
    if (url.pathname.endsWith("/$batch")) {
      const body = JSON.parse(String(init.body)) as {
        requests: Array<{ id: string; url: string; headers?: Record<string, string> }>;
      };
      const responses = body.requests.map((inner) => {
        const innerUrl = new URL(`https://graph.microsoft.com/v1.0${inner.url}`);
        const reply = this.reply(innerUrl, {
          method: "GET",
          url: innerUrl,
          headers: new Headers(inner.headers),
          batch: true,
        });
        return { id: inner.id, ...reply };
      });
      return response({ responses });
    }
    const reply = this.reply(url, request);
    if (reply.body instanceof Uint8Array) {
      // Binary bodies (attachment `$value`) are sent as-is.
      return new Response(reply.body, { status: reply.status, headers: reply.headers });
    }
    return response(reply.body ?? {}, reply.status, reply.headers);
  }

  private reply(url: URL, request: SeenRequest): FakeReply {
    if (request.batch) {
      this.seen.push(request);
    }
    for (const route of this.routes) {
      const reply = route(url, request);
      if (reply) {
        return reply;
      }
    }
    const path = url.pathname.replace(/^\/v1\.0/, "");
    const known = /^\/me\/mailFolders\/([a-z]+)$/.exec(path)?.[1];
    if (known) {
      const id = wellKnown[known];
      return id ? { status: 200, body: { id } } : { status: 404, body: { error: {} } };
    }
    if (path === "/me/mailFolders") {
      return { status: 200, body: { value: folders } };
    }
    if (path === "/me/mailFolders/id-inbox/childFolders") {
      return { status: 200, body: { value: children } };
    }
    if (path === "/me/outlook/masterCategories") {
      return { status: 200, body: { value: [{ displayName: "Work" }, { displayName: "Travel" }] } };
    }
    const id = /^\/me\/messages\/([^/]+)$/.exec(path)?.[1];
    const found = id ? this.messages.get(decodeURIComponent(id)) : undefined;
    return found ? { status: 200, body: found } : { status: 404, body: { error: {} } };
  }
}
