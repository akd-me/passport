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

/** Named references decoded for display: XML's five, plus common HTML punctuation, symbols and letters. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  trade: "\u2122",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  ldquo: "\u201c",
  rdquo: "\u201d",
  bdquo: "\u201e",
  laquo: "\u00ab",
  raquo: "\u00bb",
  bull: "\u2022",
  middot: "\u00b7",
  deg: "\u00b0",
  plusmn: "\u00b1",
  times: "\u00d7",
  divide: "\u00f7",
  minus: "\u2212",
  le: "\u2264",
  ge: "\u2265",
  ne: "\u2260",
  asymp: "\u2248",
  frac12: "\u00bd",
  frac14: "\u00bc",
  frac34: "\u00be",
  sup2: "\u00b2",
  sup3: "\u00b3",
  micro: "\u00b5",
  para: "\u00b6",
  sect: "\u00a7",
  euro: "\u20ac",
  pound: "\u00a3",
  yen: "\u00a5",
  cent: "\u00a2",
  curren: "\u00a4",
  larr: "\u2190",
  rarr: "\u2192",
  uarr: "\u2191",
  darr: "\u2193",
  harr: "\u2194",
  rArr: "\u21d2",
  lArr: "\u21d0",
  hearts: "\u2665",
  iexcl: "\u00a1",
  iquest: "\u00bf",
  shy: "\u00ad",
  ensp: "\u2002",
  emsp: "\u2003",
  thinsp: "\u2009",
  zwnj: "\u200c",
  zwj: "\u200d",
  dagger: "\u2020",
  Dagger: "\u2021",
  permil: "\u2030",
  prime: "\u2032",
  Prime: "\u2033",
  oline: "\u203e",
  szlig: "\u00df",
  ordf: "\u00aa",
  ordm: "\u00ba",
  not: "\u00ac",
  macr: "\u00af",
  acute: "\u00b4",
  cedil: "\u00b8",
  uml: "\u00a8",
  brvbar: "\u00a6",
  AElig: "\u00c6",
  aelig: "\u00e6",
  OElig: "\u0152",
  oelig: "\u0153",
  Oslash: "\u00d8",
  oslash: "\u00f8",
  Aring: "\u00c5",
  aring: "\u00e5",
  ETH: "\u00d0",
  eth: "\u00f0",
  THORN: "\u00de",
  thorn: "\u00fe",
  Ccedil: "\u00c7",
  ccedil: "\u00e7",
  Ntilde: "\u00d1",
  ntilde: "\u00f1",
  Scaron: "\u0160",
  scaron: "\u0161",
  Yuml: "\u0178",
  yuml: "\u00ff",
};
// Accented vowels: &Xacute; &Xgrave; &Xcirc; &Xuml; &Xtilde; for the vowels that have them.
for (const [mark, letters, base] of [
  [
    "acute",
    "aeiouyAEIOUY",
    [0xe1, 0xe9, 0xed, 0xf3, 0xfa, 0xfd, 0xc1, 0xc9, 0xcd, 0xd3, 0xda, 0xdd],
  ],
  ["grave", "aeiouAEIOU", [0xe0, 0xe8, 0xec, 0xf2, 0xf9, 0xc0, 0xc8, 0xcc, 0xd2, 0xd9]],
  ["circ", "aeiouAEIOU", [0xe2, 0xea, 0xee, 0xf4, 0xfb, 0xc2, 0xca, 0xce, 0xd4, 0xdb]],
  ["uml", "aeiouAEIOU", [0xe4, 0xeb, 0xef, 0xf6, 0xfc, 0xc4, 0xcb, 0xcf, 0xd6, 0xdc]],
  ["tilde", "aoAO", [0xe3, 0xf5, 0xc3, 0xd5]],
] as const) {
  [...letters].forEach((letter, index) => {
    NAMED[`${letter}${mark}`] = String.fromCodePoint(base[index]!);
  });
}

/** Decodes character references once. Unknown names stay as written (shown literally). */
function decode(text: string): string {
  return text.replace(
    /&(#x[\da-f]{1,8}|#\d{1,10}|[a-z][a-z\d]{1,31});/gi,
    (all, entity: string) => {
      if (entity[0] !== "#") {
        return NAMED[entity] ?? NAMED[entity.toLowerCase()] ?? all;
      }
      const hex = entity[1]?.toLowerCase() === "x";
      const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "\ufffd";
    },
  );
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

/** Open allowlisted elements beyond this depth are dropped (their text is kept). */
export const RENDER_MAX_DEPTH = 128;

/** Elements the parser knows but does not keep: the tag goes, its content stays. */
const KNOWN_DROPPED_TAG =
  /^(?:a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|big|body|br|button|canvas|caption|center|cite|col|colgroup|data|datalist|dd|del|details|dfn|dialog|dir|dl|dt|fieldset|figcaption|figure|font|footer|frame|frameset|head|header|hgroup|html|i|img|input|ins|kbd|label|legend|link|main|map|mark|menu|meta|meter|nav|optgroup|option|output|param|picture|progress|q|rp|rt|ruby|s|samp|search|section|select|slot|small|source|strike|sub|summary|sup|tfoot|time|track|tt|u|var|video|wbr)$/;

/** Attribute syntax a real tag has; prose with a stray `<` usually fails it ("a<b then c, d >"). */
const TAG_SHAPE =
  /^<\/?[a-z][a-z\d-]*(?:[\s/]+[a-z_:][-a-z\d_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[\s/]*>$/i;

/**
 * Where a tag that starts at `pos` ends (the index of its `>`), or -1 when there is none.
 * `quoted` honours quoted attribute values; otherwise the scan stops at the next `<`, so a
 * stray `<` costs at most the text up to the next one and the whole parse stays linear.
 */
function tagEnd(input: string, pos: number, quoted: boolean): number {
  let quote = "";
  for (let end = pos + 1; end < input.length; end++) {
    const char = input[end]!;
    if (quote) {
      if (char === quote) {
        quote = "";
      }
    } else if (quoted && (char === '"' || char === "'")) {
      quote = char;
    } else if (char === ">") {
      return end;
    } else if (!quoted && char === "<") {
      return -1;
    }
  }
  return -1;
}

/**
 * A deliberately small, dependency-free HTML parser. Only newly serialised allowlisted tags
 * and escaped text leave it. No browser repair, namespaces, CSS or URL attributes are trusted.
 * It runs in linear time: each closing tag is matched through per-name counts, and a `<` that
 * does not start a recognisable tag is kept as text instead of swallowing what follows.
 */
export function sanitizeRenderHtml(input: string): string {
  checkSize(input);
  const output: string[] = [];
  const open: Array<{ name: string; url?: string }> = [];
  const counts = new Map<string, number>();
  const dropped: string[] = [];
  const clean = (value: string) => escapeRenderText(neutralize(value.replace(/\0/g, "\ufffd")));
  const text = (value: string) => clean(decode(value));
  const emit = (value: string) => {
    if (!dropped.length) {
      output.push(value);
    }
  };
  const close = () => {
    const tag = open.pop()!;
    counts.set(tag.name, (counts.get(tag.name) ?? 1) - 1);
    // The URL was decoded once when the tag was parsed; decoding it again would turn
    // `&amp;lt;` into `<` (R1-51).
    output.push(tag.name === "a" ? (tag.url ? ` (${clean(tag.url)})` : "") : `</${tag.name}>`);
  };
  let pos = 0;
  while (pos < input.length) {
    if (input[pos] !== "<") {
      const end = input.indexOf("<", pos);
      const next = end < 0 ? input.length : end;
      emit(text(input.slice(pos, next)));
      pos = next;
      continue;
    }
    if (input.startsWith("<!--", pos)) {
      const end = input.indexOf("-->", pos + 4);
      pos = end < 0 ? input.length : end + 3;
      continue;
    }
    const name = /^<\s*\/?\s*([a-z][a-z\d-]*)/i
      .exec(input.slice(pos, pos + 72))?.[1]
      ?.toLowerCase();
    const kept = !!name && (TAGS.has(name) || DROP_CONTENT.has(name) || name === "a");
    const known = kept || (!!name && KNOWN_DROPPED_TAG.test(name));
    const end = name ? tagEnd(input, pos, kept) : -1;
    if (end < 0 && kept) {
      // An allowlisted tag that never ends: the rest is text.
      emit(text(input.slice(pos)));
      break;
    }
    const token = end < 0 ? "" : input.slice(pos, end + 1);
    const tag = token && (kept || (known && TAG_SHAPE.test(token))) ? parseTag(token) : null;
    if (!tag) {
      // A stray `<` in prose ("a<b then c, total > 5"): keep it as text (R1-50).
      emit("&lt;");
      pos++;
      continue;
    }
    pos = end + 1;
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
      if (counts.get(tag.name)) {
        while (open.length && open.at(-1)!.name !== tag.name) {
          close();
        }
        close();
      }
    } else if (open.length >= RENDER_MAX_DEPTH) {
      // Too deep: drop the tag, keep its text.
    } else if (tag.name === "a") {
      // All URLs, including javascript:, are visible text; no anchor survives.
      open.push({ name: "a", url: tag.attrs.get("href") });
      counts.set("a", (counts.get("a") ?? 0) + 1);
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
        counts.set(tag.name, (counts.get(tag.name) ?? 0) + 1);
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
