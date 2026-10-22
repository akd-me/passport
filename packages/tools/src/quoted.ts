/**
 * Quoted-history handling for `mail_read` (research 03 §2.5). Tools depend only on
 * `@passport/types`, so this is a small self-contained port of the heuristics: reply
 * attributions in common locales, Outlook `Original Message` / `From: … Sent:` blocks, runs of
 * `>` lines and, in HTML, Gmail / Outlook / Apple quote containers. Forwarded messages are kept.
 */

/** Marker `htmlToText` leaves where an HTML quote container starts. */
const CUT = "\u0000quote-start\u0000";
const QUOTE_OPEN = "\u0000bq-open\u0000";
const QUOTE_CLOSE = "\u0000bq-close\u0000";

const ATTRIBUTIONS = [
  /^On .{4,300} wrote:\s*$/i,
  /^Le .{4,300} a écrit\s?:\s*$/i,
  /^Am .{4,300} schrieb .{0,200}:\s*$/i,
  /^El .{4,300} escribió:\s*$/i,
  /^Il .{4,300} ha scritto:\s*$/i,
  /^Op .{4,300} schreef .{0,200}:\s*$/i,
  /^Em .{4,300} escreveu:\s*$/i,
  /^Den .{4,300} skrev .{0,200}:\s*$/i,
  /^W dniu .{4,300} pisze:\s*$/i,
  /^.{4,300} написал\(а\):\s*$/,
  /^.{4,300}写道[:：]\s*$/,
];
const ORIGINAL =
  /^\s*-{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Message d'origine|Mensaje original|Messaggio originale)\s*-{2,}\s*$/i;
const HEADER_FROM = /^\s*\*?(?:From|De|Von|Da|Van)\s*:\*?\s+\S/i;
const HEADER_NEXT = /^\s*\*?(?:Sent|Date|Envoyé|Gesendet|Enviado|Inviato|Verzonden)\s*:\*?\s/i;

function quoteStart(lines: string[]): number {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line === CUT || ORIGINAL.test(line)) {
      return index;
    }
    if (ATTRIBUTIONS.some((pattern) => pattern.test(line.trim()))) {
      return index;
    }
    // Gmail wraps long attributions: "On Tue, … <a@b.c>" / "wrote:".
    const joined = `${line.trim()} ${lines[index + 1]?.trim() ?? ""}`;
    if (/^On .{4,300} wrote:$/i.test(joined) && !/wrote:\s*$/i.test(line)) {
      return index;
    }
    if (
      HEADER_FROM.test(line) &&
      lines.slice(index + 1, index + 4).some((next) => HEADER_NEXT.test(next))
    ) {
      return index;
    }
  }
  return -1;
}

const note = (count: number) =>
  `[quoted ${count} line${count === 1 ? "" : "s"} collapsed; quoted:"full" to expand]`;

/** Collapses quoted history. Returns the text and how many lines were hidden. */
export function collapseQuoted(text: string): { text: string; collapsedLines: number } {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  let collapsed = 0;
  const start = quoteStart(lines);
  let tail: string | null = null;
  if (start >= 0) {
    const hidden = lines.slice(start).filter((line) => line.trim() && line !== CUT).length;
    lines = lines.slice(0, start);
    while (lines.length && !lines.at(-1)?.trim()) {
      lines.pop();
    }
    if (hidden) {
      collapsed += hidden;
      tail = note(hidden);
    }
  }
  const out: string[] = [];
  for (let index = 0; index < lines.length; ) {
    if (/^\s*>/.test(lines[index] ?? "")) {
      let end = index;
      while (end < lines.length && /^\s*>/.test(lines[end] ?? "")) {
        end++;
      }
      collapsed += end - index;
      out.push(note(end - index));
      index = end;
    } else {
      out.push(lines[index] ?? "");
      index++;
    }
  }
  if (tail) {
    out.push("", tail);
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n"), collapsedLines: collapsed };
}

/** Removes the internal markers `htmlToText` inserts when quotes are kept in full. */
export function stripQuoteMarkers(text: string): string {
  return text
    .split("\n")
    .filter((line) => line !== CUT)
    .join("\n");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1]?.toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Plain text from HTML: block elements become line breaks, links become `text (host)` (never the
 * token-bearing URL), blockquotes become `>` lines and Gmail/Outlook quote containers are marked
 * so `collapseQuoted` can hide them. Images are dropped.
 */
export function htmlToText(html: string): string {
  const marked = html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<div\b[^>]*(?:class\s*=\s*["'][^"']*gmail_quote[^"']*["']|id\s*=\s*["'](?:divRplyFwdMsg|appendonsend)["'])[^>]*>/gi,
      `\n${CUT}\n`,
    )
    .replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_OPEN}\n`)
    .replace(/<\/blockquote\s*>/gi, `\n${QUOTE_CLOSE}\n`)
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, label) => {
      const text = String(label)
        .replace(/<[^>]*>/g, "")
        .trim();
      try {
        const host = new URL(decodeEntities(String(href))).host;
        return host && !text.includes(host) ? `${text} (${host})` : text;
      } catch {
        // Relative or malformed links carry no useful host.
        return text;
      }
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  let depth = 0;
  const lines: string[] = [];
  for (const raw of decodeEntities(marked).split("\n")) {
    if (raw === QUOTE_OPEN) {
      depth++;
    } else if (raw === QUOTE_CLOSE) {
      depth = Math.max(0, depth - 1);
    } else if (raw === CUT) {
      lines.push(CUT);
    } else {
      const line = raw.replace(/[ \t ]+/g, " ").trim();
      lines.push(depth && line ? `${"> ".repeat(depth)}${line}` : line);
    }
  }
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
