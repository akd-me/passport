import { htmlToText, stripQuoteMarkers } from "../quoted.js";
import { decodeText } from "./text.js";

/**
 * Minimal MIME reader for `message/rfc822` attachments: headers, the best text part and the
 * names of nested attachments. Deliberately small (tools depend only on `@passport/types`);
 * anything it cannot parse degrades to less text, never to an exception.
 */

const MAX_DEPTH = 8;
const MAX_PARTS = 200;

interface Part {
  headers: Map<string, string>;
  body: Uint8Array;
}

const latin1 = (data: Uint8Array) => new TextDecoder("latin1").decode(data);

function headerEnd(data: Uint8Array): { end: number; skip: number } {
  for (let index = 0; index < data.length - 1; index++) {
    if (data[index] === 0x0a && data[index + 1] === 0x0a) {
      return { end: index, skip: 2 };
    }
    if (data[index] === 0x0a && data[index + 1] === 0x0d && data[index + 2] === 0x0a) {
      return { end: index, skip: 3 };
    }
  }
  return { end: data.length, skip: 0 };
}

function parsePart(data: Uint8Array): Part {
  const { end, skip } = headerEnd(data);
  const headers = new Map<string, string>();
  const unfolded = latin1(data.subarray(0, end)).replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      if (!headers.has(name)) {
        headers.set(name, line.slice(colon + 1).trim());
      }
    }
  }
  return { headers, body: data.subarray(Math.min(data.length, end + skip)) };
}

/** `type/subtype` and parameters of a structured header such as Content-Type. */
function structured(value: string | undefined): { value: string; params: Map<string, string> } {
  const [head = "", ...rest] = (value ?? "").split(";");
  const params = new Map<string, string>();
  for (const param of rest) {
    const match = /^\s*([^=\s]+)\s*=\s*"?([^"]*)"?\s*$/.exec(param);
    if (match?.[1]) {
      params.set(match[1].toLowerCase().replace(/\*$/, ""), match[2] ?? "");
    }
  }
  return { value: head.trim().toLowerCase(), params };
}

/** RFC 2047 encoded words (B and Q), decoded from their raw bytes. */
export function decodeWords(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, encoding: string, text) => {
      const bytes =
        encoding.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text
                .replace(/_/g, " ")
                .replace(/=([0-9A-Fa-f]{2})/g, (_m: string, hex: string) =>
                  String.fromCharCode(Number.parseInt(hex, 16)),
                ),
              "latin1",
            );
      return decodeText(new Uint8Array(bytes), charset.split("*")[0]);
    });
}

function decodeBody(part: Part): Uint8Array {
  const encoding = (part.headers.get("content-transfer-encoding") ?? "").trim().toLowerCase();
  if (encoding === "base64") {
    return new Uint8Array(Buffer.from(latin1(part.body).replace(/[^A-Za-z0-9+/=]/g, ""), "base64"));
  }
  if (encoding === "quoted-printable") {
    const text = latin1(part.body)
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      );
    return new Uint8Array(Buffer.from(text, "latin1"));
  }
  return part.body;
}

function splitMultipart(body: Uint8Array, boundary: string): Uint8Array[] {
  const text = latin1(body);
  const delimiter = `--${boundary}`;
  const parts: Uint8Array[] = [];
  let index = text.indexOf(delimiter);
  while (index !== -1 && parts.length < MAX_PARTS) {
    let start = index + delimiter.length;
    if (text.startsWith("--", start)) {
      break;
    }
    start = text.indexOf("\n", start) + 1;
    if (start === 0) {
      break;
    }
    const next = text.indexOf(`\n${delimiter}`, start);
    const end = next === -1 ? text.length : next;
    parts.push(body.subarray(start, text[end - 1] === "\r" ? end - 1 : end));
    index = next === -1 ? -1 : next + 1;
  }
  return parts;
}

export interface NestedMessage {
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  rfc822Id: string | null;
  attachments: Array<{ name: string; type: string; size: number }>;
}

interface Walk {
  plain: string | null;
  html: string | null;
  attachments: NestedMessage["attachments"];
}

function walk(part: Part, state: Walk, depth: number): void {
  const type = structured(part.headers.get("content-type") ?? "text/plain");
  const disposition = structured(part.headers.get("content-disposition"));
  const filename = disposition.params.get("filename") ?? type.params.get("name");
  if (type.value.startsWith("multipart/") && depth < MAX_DEPTH) {
    const boundary = type.params.get("boundary");
    for (const child of boundary ? splitMultipart(part.body, boundary) : []) {
      walk(parsePart(child), state, depth + 1);
    }
    return;
  }
  if (disposition.value === "attachment" || filename) {
    if (state.attachments.length < 100) {
      state.attachments.push({
        name: decodeWords(filename ?? "(unnamed)"),
        type: type.value,
        size: decodeBody(part).byteLength,
      });
    }
    return;
  }
  if (type.value === "text/plain" && state.plain === null) {
    state.plain = decodeText(decodeBody(part), type.params.get("charset"));
  } else if (type.value === "text/html" && state.html === null) {
    state.html = decodeText(decodeBody(part), type.params.get("charset"));
  }
}

/** Headers, body text and nested attachment names of an RFC 822 message. */
export function parseMessage(data: Uint8Array): { message: NestedMessage; text: string } {
  const root = parsePart(data);
  const state: Walk = { plain: null, html: null, attachments: [] };
  walk(root, state, 0);
  const header = (name: string) => decodeWords(root.headers.get(name) ?? "");
  return {
    message: {
      from: header("from"),
      to: header("to"),
      cc: header("cc"),
      subject: header("subject"),
      date: header("date"),
      rfc822Id: root.headers.get("message-id") ?? null,
      attachments: state.attachments,
    },
    text: state.plain ?? (state.html ? stripQuoteMarkers(htmlToText(state.html)) : ""),
  };
}
