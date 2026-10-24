import { neutralize } from "./ondemand-support.js";
import { ToolError } from "./presentation.js";

export const RENDER_MAX_BYTES = 64 * 1024;
const TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "strong",
  "em",
  "code",
  "pre",
  "blockquote",
  "hr",
  "span",
  "div",
]);
const DROP_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "svg",
  "math",
  "form",
  "textarea",
  "title",
  "xmp",
  "plaintext",
  "noscript",
  "noembed",
  "noframes",
]);

/** Escape text before constructing restricted markup, including attribute quotes. */
export function escapeRenderText(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

function decode(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: "\u00a0",
  };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity: string) => {
    if (entity[0] !== "#") {
      return named[entity.toLowerCase()] ?? all;
    }
    const hex = entity[1]?.toLowerCase() === "x";
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point)
      : "\ufffd";
  });
}

interface Tag {
  name: string;
  closing: boolean;
  attrs: Map<string, string>;
}

/** Tokenise attributes with quote state; never copy an input tag or attribute to output. */
function parseTag(token: string): Tag | null {
  const head = /^<\s*(\/?)\s*([a-z][a-z\d-]*)/i.exec(token);
  if (!head || !/[\s/>]/.test(token[head[0].length] ?? "")) {
    return null;
  }
  const attrs = new Map<string, string>();
  let pos = head[0].length;
  while (pos < token.length - 1) {
    while (/[\s/]/.test(token[pos] ?? "")) {
      pos++;
    }
    const start = pos;
    while (pos < token.length - 1 && !/[\s=/>]/.test(token[pos]!)) {
      pos++;
    }
    if (start === pos) {
      pos++;
      continue;
    }
    const name = token.slice(start, pos).toLowerCase();
    while (/\s/.test(token[pos] ?? "")) {
      pos++;
    }
    let value = "";
    if (token[pos] === "=") {
      pos++;
      while (/\s/.test(token[pos] ?? "")) {
        pos++;
      }
      const quote = token[pos] === '"' || token[pos] === "'" ? token[pos++] : null;
      const from = pos;
      while (
        pos < token.length - 1 &&
        (quote ? token[pos] !== quote : !/[\s>]/.test(token[pos]!))
      ) {
        pos++;
      }
      value = decode(token.slice(from, pos));
      if (quote && token[pos] === quote) {
        pos++;
      }
    }
    if (!attrs.has(name)) {
      attrs.set(name, value);
    }
  }
  return { name: head[2]!.toLowerCase(), closing: !!head[1], attrs };
}

function checkSize(html: string): void {
  if (Buffer.byteLength(html, "utf8") > RENDER_MAX_BYTES) {
    throw new ToolError("RENDER_TOO_LARGE", "Render HTML must fit within 64 KiB of UTF-8.");
  }
}

/**
 * A deliberately small, dependency-free HTML parser. Only newly serialised allowlisted tags
 * and escaped text leave it. No browser repair, namespaces, CSS or URL attributes are trusted.
 */
export function sanitizeRenderHtml(input: string): string {
  checkSize(input);
  const output: string[] = [];
  const open: Array<{ name: string; url?: string }> = [];
  const dropped: string[] = [];
  const text = (value: string) =>
    escapeRenderText(neutralize(decode(value.replace(/\0/g, "\ufffd"))));
  const close = () => {
    const tag = open.pop()!;
    output.push(tag.name === "a" ? (tag.url ? ` (${text(tag.url)})` : "") : `</${tag.name}>`);
  };
  let pos = 0;
  while (pos < input.length) {
    if (input[pos] !== "<") {
      const end = input.indexOf("<", pos);
      const next = end < 0 ? input.length : end;
      if (!dropped.length) {
        output.push(text(input.slice(pos, next)));
      }
      pos = next;
      continue;
    }
    if (input.startsWith("<!--", pos)) {
      const end = input.indexOf("-->", pos + 4);
      pos = end < 0 ? input.length : end + 3;
      continue;
    }
    // Find the next tag boundary, ignoring > inside either kind of quoted attribute.
    let end = pos + 1;
    let quote = "";
    for (; end < input.length; end++) {
      const char = input[end]!;
      if (quote) {
        if (char === quote) {
          quote = "";
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end === input.length) {
      if (!dropped.length) {
        output.push(text(input.slice(pos)));
      }
      break;
    }
    const token = input.slice(pos, end + 1);
    pos = end + 1;
    const tag = parseTag(token);
    if (!tag) {
      if (!dropped.length) {
        output.push(text(token));
      }
      continue;
    }
    if (dropped.length) {
      if (tag.closing && tag.name === dropped.at(-1)) {
        dropped.pop();
      } else if (!tag.closing && DROP_CONTENT.has(tag.name)) {
        dropped.push(tag.name);
      }
      continue;
    }
    if (DROP_CONTENT.has(tag.name)) {
      if (!tag.closing) {
        dropped.push(tag.name);
      }
      continue;
    }
    if (!TAGS.has(tag.name) && tag.name !== "a") {
      continue;
    }
    if (tag.closing) {
      const index = open.map((entry) => entry.name).lastIndexOf(tag.name);
      if (index >= 0) {
        while (open.length > index) {
          close();
        }
      }
    } else if (tag.name === "a") {
      // All URLs, including javascript:, are visible text; no anchor survives.
      open.push({ name: "a", url: tag.attrs.get("href") });
    } else {
      const classes = (tag.attrs.get("class") ?? "")
        .split(/\s+/)
        .filter((part) => /^[a-zA-Z_][a-zA-Z\d_-]{0,63}$/.test(part))
        .slice(0, 8)
        .join(" ");
      const attr =
        (tag.name === "span" || tag.name === "div") && classes ? ` class="${classes}"` : "";
      output.push(`<${tag.name}${attr}>`);
      if (tag.name !== "hr") {
        open.push({ name: tag.name });
      }
    }
  }
  while (open.length) {
    close();
  }
  const html = output.join("");
  checkSize(html);
  return html;
}

/** Opaque sandboxes cannot measure their contents; use a bounded content estimate by default. */
export function renderHeight(html: string, height?: number): number {
  if (height !== undefined) {
    if (!Number.isInteger(height) || height < 80 || height > 1200) {
      throw new ToolError("INVALID_INPUT", "Render height must be an integer from 80 to 1200.");
    }
    return height;
  }
  const lines =
    html.split("\n").length + (html.match(/<(?:h[1-6]|p|li|tr|pre|blockquote|hr)\b/g)?.length ?? 0);
  return Math.min(1200, Math.max(80, 32 + lines * 26 + Math.ceil(html.length / 90) * 18));
}
