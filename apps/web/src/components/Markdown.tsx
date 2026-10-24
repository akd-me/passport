import type { ReactNode } from "react";

/**
 * A small markdown renderer for Passport's own messages. It builds React elements, never HTML
 * strings, so model text cannot inject markup. Links and images are shown as text with their
 * URL visible, never as anchors or `<img>` that could auto-load or lead somewhere unseen: the
 * timeline's untrusted-data rule (docs/tasks.md) applies to assistant text, which quotes mail.
 *
 * Supported: paragraphs (single newlines are line breaks), `#` headings, `-` / `*` / `+` and
 * numbered lists with indentation nesting, fenced and inline code, `>` quotes, pipe tables,
 * `---` rules, **bold**, *italic*, ~~strike~~.
 */
export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`md ${className}`}>{renderBlocks(parseBlocks(text.split("\n")))}</div>;
}

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" };

interface ListItem {
  lines: string[];
  children: Block[];
}

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
// Models sometimes write `-**Bold**` without the space; treat it as a bullet, since a line that
// starts with a dash glued to bold text is never prose.
const BULLET = /^(\s*)(?:[-*+]\s+|-(?=\*\*))(.*)$/;
const NUMBERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1]}\\s*$`);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !close.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: (heading[1] ?? "#").length, text: heading[2] ?? "" });
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "hr" });
      i += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? "")) {
        inner.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(inner) });
      continue;
    }
    if (isListStart(line)) {
      const [list, next] = parseList(lines, i);
      blocks.push(list);
      i = next;
      continue;
    }
    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const head = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(splitRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && isParagraphLine(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    if (para.length === 0) {
      // Defensive: a line no rule claims still has to advance.
      para.push(line);
      i += 1;
    }
    blocks.push({ kind: "p", lines: para });
  }
  return blocks;
}

const isListStart = (line: string) => BULLET.test(line) || NUMBERED.test(line);

function isParagraphLine(line: string): boolean {
  return (
    line.trim() !== "" &&
    !FENCE.test(line) &&
    !HEADING.test(line) &&
    !RULE.test(line) &&
    !/^\s*>/.test(line) &&
    !isListStart(line)
  );
}

/** One list, from `lines[start]`, with deeper-indented items nested under the previous one. */
function parseList(lines: string[], start: number): [Block, number] {
  const first = lines[start] ?? "";
  const ordered = !BULLET.test(first) && NUMBERED.test(first);
  const indent = leadingSpace(first);
  const startNumber = ordered ? Number(NUMBERED.exec(first)?.[2] ?? 1) : 1;
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const marker = ordered ? NUMBERED.exec(line) : BULLET.exec(line);
    const depth = leadingSpace(line);
    if (marker !== null && depth < indent) break; // Dedent: the parent list continues.
    const atThisLevel = marker !== null && depth < indent + 2;
    if (!atThisLevel) {
      if (items.length === 0) break;
      const current = items[items.length - 1] as ListItem;
      if (line.trim() === "") {
        // A blank line ends the list unless the next line is still part of it.
        const next = lines[i + 1] ?? "";
        const continues = next.trim() !== "" && (leadingSpace(next) > indent || isListStart(next));
        if (!continues) break;
        i += 1;
        continue;
      }
      if (leadingSpace(line) > indent) {
        // Deeper content: a nested list or a continuation line of this item.
        if (isListStart(line)) {
          const [nested, next] = parseList(lines, i);
          current.children.push(nested);
          i = next;
        } else {
          current.lines.push(line.trim());
          i += 1;
        }
        continue;
      }
      if (isListStart(line)) break; // A sibling list of the other type (bullets vs numbers).
      // Lazy continuation: unindented prose directly under an item belongs to it.
      current.lines.push(line.trim());
      i += 1;
      continue;
    }
    items.push({ lines: [(marker[marker.length - 1] ?? "").trim()], children: [] });
    i += 1;
  }
  return [{ kind: "list", ordered, start: startNumber, items }, i];
}

const leadingSpace = (line: string) => line.length - line.trimStart().length;

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((block, index) => renderBlock(block, index));
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "p":
      return <p key={key}>{renderLines(block.lines)}</p>;
    case "h":
      return (
        <p key={key} className={`md-heading md-h${Math.min(block.level, 3)}`}>
          {renderInline(block.text)}
        </p>
      );
    case "code":
      return (
        <pre key={key} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case "quote":
      return <blockquote key={key}>{renderBlocks(block.blocks)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "table":
      return (
        <table key={key}>
          <thead>
            <tr>
              {block.head.map((cell, c) => (
                <th key={c}>{renderInline(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r}>
                {block.head.map((_, c) => (
                  <td key={c}>{renderInline(row[c] ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "list": {
      const items = block.items.map((item, n) => (
        <li key={n}>
          {renderLines(item.lines)}
          {renderBlocks(item.children)}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
  }
}

/** Lines of one paragraph or list item: a newline inside is a line break, as in chat. */
function renderLines(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) out.push(<br key={`br${index}`} />);
    out.push(...renderInline(line, index * 1000));
  });
  return out;
}

interface InlineRule {
  pattern: RegExp;
  render: (match: RegExpExecArray, key: number) => ReactNode;
  /** The same span as plain text, for one-line rows (`markdownToText`). */
  text: (match: RegExpExecArray) => string;
}

// Order is precedence when two rules match at the same offset.
const INLINE_RULES: InlineRule[] = [
  {
    pattern: /`([^`\n]+)`/,
    render: (m, key) => <code key={key}>{m[1]}</code>,
    text: (m) => m[1] ?? "",
  },
  {
    // An image is never loaded: its alt text and the URL are shown, so the reader sees both.
    pattern: /!\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"[^"\n]*")?\s*\)/,
    render: (m, key) => <LinkText key={key} label={m[1] ?? ""} url={m[2] ?? ""} />,
    text: (m) => linkText(m[1] ?? "", m[2] ?? ""),
  },
  {
    pattern: /\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"\n]*")?\s*\)/,
    render: (m, key) => <LinkText key={key} label={m[1] ?? ""} url={m[2] ?? ""} />,
    text: (m) => linkText(m[1] ?? "", m[2] ?? ""),
  },
  {
    pattern: /\*\*(?=\S)([\s\S]+?\S)\*\*/,
    render: (m, key) => <strong key={key}>{renderInline(m[1] ?? "")}</strong>,
    text: (m) => inlineText(m[1] ?? ""),
  },
  {
    pattern: /(?<![\w\\])__(?=\S)([\s\S]+?\S)__(?!\w)/,
    render: (m, key) => <strong key={key}>{renderInline(m[1] ?? "")}</strong>,
    text: (m) => inlineText(m[1] ?? ""),
  },
  {
    pattern: /~~(?=\S)([\s\S]+?\S)~~/,
    render: (m, key) => <del key={key}>{renderInline(m[1] ?? "")}</del>,
    text: (m) => inlineText(m[1] ?? ""),
  },
  {
    pattern: /(?<!\*)\*(?=[^\s*])([^*\n]+?[^\s*])\*(?!\*)/,
    render: (m, key) => <em key={key}>{renderInline(m[1] ?? "")}</em>,
    text: (m) => inlineText(m[1] ?? ""),
  },
  {
    pattern: /(?<![\w\\])_(?=[^\s_])([^_\n]+?[^\s_])_(?!\w)/,
    render: (m, key) => <em key={key}>{renderInline(m[1] ?? "")}</em>,
    text: (m) => inlineText(m[1] ?? ""),
  },
];

function LinkText({ label, url }: { label: string; url: string }) {
  const shown = label.trim();
  if (!shown || shown === url) {
    return <span className="md-link-url">{url}</span>;
  }
  return (
    <>
      {renderInline(shown)}
      <span className="md-link-url">{` (${url})`}</span>
    </>
  );
}

/** The earliest inline rule match in `text`, by precedence at equal offsets. */
function firstInline(text: string) {
  let best: { rule: InlineRule; match: RegExpExecArray } | null = null;
  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(text);
    if (match && (best === null || match.index < best.match.index)) {
      best = { rule, match };
      if (match.index === 0) break;
    }
  }
  return best;
}

/** Inline markdown as React nodes. Anything not matched stays a text node. */
export function renderInline(text: string, keyBase = 0): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = keyBase;
  while (rest.length > 0) {
    const best = firstInline(rest);
    if (best === null) {
      out.push(rest);
      break;
    }
    if (best.match.index > 0) out.push(rest.slice(0, best.match.index));
    out.push(best.rule.render(best.match, key));
    key += 1;
    rest = rest.slice(best.match.index + best.match[0].length);
  }
  return out;
}

const linkText = (label: string, url: string) => {
  const shown = inlineText(label.trim());
  return !shown || shown === url ? url : `${shown} (${url})`;
};

function inlineText(text: string): string {
  let out = "";
  let rest = text;
  while (rest.length > 0) {
    const best = firstInline(rest);
    if (best === null) {
      return out + rest;
    }
    out += rest.slice(0, best.match.index) + best.rule.text(best.match);
    rest = rest.slice(best.match.index + best.match[0].length);
  }
  return out;
}

function blockText(block: Block): string[] {
  switch (block.kind) {
    case "p":
      return block.lines.map(inlineText);
    case "h":
      return [inlineText(block.text)];
    case "code":
      return [block.text];
    case "quote":
      return block.blocks.flatMap(blockText);
    case "hr":
      return [];
    case "table":
      return [block.head, ...block.rows].map((row) => row.map(inlineText).join(" "));
    case "list":
      return block.items.flatMap((item) => [
        ...item.lines.map(inlineText),
        ...item.children.flatMap(blockText),
      ]);
  }
}

/**
 * Markdown as one line of plain text, for rows that show a question or message in a single
 * line (Needs you, Home, the palette): markers dropped, link URLs kept visible, whitespace
 * collapsed.
 */
export function markdownToText(text: string): string {
  return parseBlocks(text.split("\n")).flatMap(blockText).join(" ").replace(/\s+/g, " ").trim();
}
