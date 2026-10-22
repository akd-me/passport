/**
 * Test-only fake of the Gmail REST and batch endpoints for `gmail-reader*.test.ts`. The batch
 * handler parses the multipart request the reader sends, routes every inner GET through the same
 * handler and answers in Google's format (parts reversed, `Content-ID: <response-…>`).
 */
import { GmailMailProvider } from "./gmail.js";
import type { GmailMessage } from "./gmail-reader-normalize.js";
import type { ProviderOptions } from "./http.js";
import { account, fixtureFetch, response } from "./test/helpers.js";

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** `GET /messages?…` style log lines (path relative to `users/me`, with the query). */
function line(method: string, url: URL): string {
  return `${method} ${url.pathname.replace("/gmail/v1/users/me/", "")}${url.search}`;
}

export function fakeGmail(route: Route) {
  const calls: string[] = [];
  const batches: number[] = [];
  const fetcher = fixtureFetch(async (url, init) => {
    if (url.pathname !== "/batch/gmail/v1") {
      calls.push(line(init.method ?? "GET", url));
      return route(url, init);
    }
    const boundary = /boundary=(\S+)/.exec(
      new Headers(init.headers).get("content-type") ?? "",
    )?.[1];
    const parts = String(init.body).split(`--${boundary}`).slice(1, -1);
    batches.push(parts.length);
    const answers: string[] = [];
    for (const part of parts) {
      const id = /Content-ID: <([^>]+)>/.exec(part)?.[1];
      const inner = new URL(/GET (\S+)/.exec(part)?.[1] ?? "/", "https://gmail.googleapis.com");
      calls.push(line("GET", inner));
      const r = await route(inner, {});
      const retry = r.headers.get("retry-after");
      answers.push(
        `Content-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\n` +
          `HTTP/1.1 ${r.status} X\r\nContent-Type: application/json; charset=UTF-8\r\n` +
          `${retry ? `Retry-After: ${retry}\r\n` : ""}\r\n${await r.text()}\r\n`,
      );
    }
    const body = `${answers
      .reverse()
      .map((a) => `--batch_resp\r\n${a}`)
      .join("")}--batch_resp--\r\n`;
    return new Response(body, {
      status: 200,
      headers: { "content-type": "multipart/mixed; boundary=batch_resp" },
    });
  });
  return { fetcher, calls, batches };
}

export async function connectedReader(route: Route, options: ProviderOptions = {}) {
  const fake = fakeGmail(route);
  const provider = new GmailMailProvider({ fetch: fake.fetcher, ...options });
  await provider.connect(account, { access_token: "token" });
  return { ...fake, provider, reader: provider.reader() };
}

interface MetaInput {
  threadId?: string;
  labels?: string[];
  from?: string;
  to?: string;
  subject?: string;
  date?: number;
  mime?: string;
  messageId?: string;
  auth?: string;
}

/** A `format=metadata` message. */
export function meta(id: string, input: MetaInput = {}): GmailMessage {
  const headers = [
    { name: "From", value: input.from ?? '"Rivera, Sam" <SAM@example.com>' },
    { name: "To", value: input.to ?? "Alex <alex@example.com>" },
    { name: "Subject", value: input.subject ?? `Subject ${id}` },
    { name: "Message-ID", value: input.messageId ?? `<${id}@example.com>` },
  ];
  if (input.auth) {
    headers.push({ name: "Authentication-Results", value: input.auth });
  }
  return {
    id,
    threadId: input.threadId ?? `t-${id}`,
    labelIds: input.labels ?? ["INBOX", "UNREAD"],
    snippet: `Snippet of ${id}`,
    internalDate: String(input.date ?? Date.parse("2026-10-20T10:00:00Z")),
    sizeEstimate: 1000,
    payload: { mimeType: input.mime ?? "text/plain", headers },
  };
}

/** Routes `messages/<id>` to `messages[id]` (404 when absent) and `labels` to `labels`. */
export function mailbox(
  messages: Record<string, GmailMessage>,
  labels: Array<{ id: string; name: string }> = [],
  extra: Route = () => response({}, 404),
): Route {
  return (url, init) => {
    const path = url.pathname.replace("/gmail/v1/users/me/", "");
    const single = /^messages\/([^/]+)$/.exec(path);
    if (single) {
      const message = messages[decodeURIComponent(single[1] ?? "")];
      return message ? response(message) : response({ error: { code: 404 } }, 404);
    }
    if (path === "labels") {
      return response({ labels });
    }
    return extra(url, init);
  };
}

export { account, response };
