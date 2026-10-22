import type { FetchMessageObject, FetchQueryObject, ImapFlow, SearchObject } from "imapflow";
import { searchCompiler } from "imapflow/lib/search-compiler.js";
import { ProviderError } from "./errors.js";

/** Extensions the reader adapts to (research 03 §5.6). */
export const IMAP_EXTENSIONS = [
  "ESEARCH",
  "SORT",
  "THREAD=REFERENCES",
  "CONDSTORE",
  "QRESYNC",
  "OBJECTID",
  "X-GM-EXT-1",
  "MOVE",
  "IDLE",
] as const;
export type ImapExtension = (typeof IMAP_EXTENSIONS)[number];

/** Reads the CAPABILITY list imapflow collected on connect. IMAP4rev2 implies ESEARCH and MOVE. */
export function probeImapExtensions(client: ImapFlow): Set<ImapExtension> {
  const caps = (client as Partial<ImapFlow>).capabilities ?? new Map<string, boolean | number>();
  const has = (name: string) => caps.has(name);
  const found = new Set<ImapExtension>(IMAP_EXTENSIONS.filter(has));
  if (has("IMAP4rev2")) {
    found.add("ESEARCH");
    found.add("MOVE");
  }
  return found;
}

/** Server-side criteria: an imapflow query, or provider-native SEARCH text (`rawQuery`). */
export type ImapCriteria = { query: SearchObject } | { raw: string };

/** The selected mailbox while a session holds its lock. */
export interface SelectedBox {
  path: string;
  validity: string;
  uidNext: number;
  modseq: bigint | undefined;
}

type Attribute = { type: "ATOM" | "STRING"; value: string } | Attribute[];
interface Untagged {
  attributes?: Array<{ value?: unknown }>;
  numbers?: number[];
}
/** imapflow's internal command runner (stable since 1.0, absent from its type declarations). */
interface ExecClient {
  exec(
    command: string,
    attributes: unknown[],
    options?: { untagged?: Record<string, (untagged: Untagged) => Promise<void>> },
  ): Promise<{ next(): void }>;
}

/** Tokenizes provider-native SEARCH text into atoms, quoted strings and lists. */
export function rawCriteria(raw: string): Attribute[] {
  if (/[\r\n{}]/.test(raw)) {
    throw new ProviderError("INVALID_QUERY", "IMAP rawQuery must be one line without literals");
  }
  const stack: Attribute[][] = [[]];
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"|\(|\)|[^\s()"]+/g)) {
    const top = stack[stack.length - 1] as Attribute[];
    if (match[0] === "(") {
      const list: Attribute[] = [];
      top.push(list);
      stack.push(list);
    } else if (match[0] === ")") {
      if (stack.length === 1) {
        throw new ProviderError("INVALID_QUERY", "Unbalanced parenthesis in IMAP rawQuery");
      }
      stack.pop();
    } else if (match[1] !== undefined) {
      top.push({ type: "STRING", value: match[1].replace(/\\(.)/g, "$1") });
    } else {
      top.push({ type: "ATOM", value: match[0] });
    }
  }
  const root = stack[0] as Attribute[];
  if (stack.length !== 1 || root.length === 0) {
    throw new ProviderError("INVALID_QUERY", "IMAP rawQuery is empty or unbalanced");
  }
  return root;
}

function numbersOf(untagged: Untagged): number[] {
  const values = untagged.numbers ?? (untagged.attributes ?? []).map((a) => Number(a.value));
  return values.filter((n) => Number.isInteger(n) && n > 0);
}

/** Sorts UIDs newest (highest) first, without duplicates. */
export function newestFirst(uids: Iterable<number>): number[] {
  return [...new Set(uids)].sort((a, b) => b - a);
}

/**
 * One reader call's view of the IMAP connection. Counts the commands it issues (`commands`) so
 * results can report `cost.imapCommands`. Not reentrant: hold one mailbox at a time.
 */
export class ImapSession {
  commands = 0;
  constructor(
    readonly client: ImapFlow,
    readonly ext: ReadonlySet<ImapExtension>,
  ) {}

  /** SELECTs `path` (counted only when it is not already selected) and runs `fn` under the lock. */
  async select<T>(path: string, fn: (box: SelectedBox) => Promise<T>): Promise<T> {
    const current = this.client.mailbox;
    if (!current || current.path !== path) {
      this.commands++;
    }
    const lock = await this.client.getMailboxLock(path);
    try {
      const box = this.client.mailbox;
      if (!box) {
        throw new ProviderError("IMAP_ERROR", "IMAP mailbox selection failed");
      }
      return await fn({
        path,
        validity: String(box.uidValidity),
        uidNext: box.uidNext,
        modseq: box.highestModseq ?? undefined,
      });
    } finally {
      lock.release();
    }
  }

  /** Matching UIDs in the selected mailbox, newest first: `UID SORT (REVERSE ARRIVAL)` or SEARCH. */
  async uids(criteria: ImapCriteria): Promise<number[]> {
    this.commands++;
    if (this.ext.has("SORT")) {
      const sorted = await this.execNumbers("UID SORT", "SORT", [
        [
          { type: "ATOM", value: "REVERSE" },
          { type: "ATOM", value: "ARRIVAL" },
        ],
        { type: "ATOM", value: "UTF-8" },
        ...this.attributes(criteria),
      ]);
      if (sorted) {
        return [...new Set(sorted)];
      }
    }
    if ("raw" in criteria) {
      const found = await this.execNumbers("UID SEARCH", "SEARCH", this.attributes(criteria));
      if (!found) {
        throw new ProviderError("INVALID_QUERY", "The IMAP server rejected the rawQuery");
      }
      return newestFirst(found);
    }
    const found = await this.client.search(criteria.query, { uid: true });
    if (!Array.isArray(found)) {
      throw new ProviderError("IMAP_ERROR", "The IMAP server rejected the search");
    }
    return newestFirst(found);
  }

  /** Exact match count: `ESEARCH RETURN (COUNT)` when available, else the UID list length. */
  async count(criteria: ImapCriteria): Promise<number> {
    if (!this.ext.has("ESEARCH")) {
      return (await this.uids(criteria)).length;
    }
    this.commands++;
    if ("query" in criteria) {
      const result = await this.client.search(criteria.query, {
        uid: true,
        returnOptions: ["COUNT"],
      });
      if (result === false || result === undefined) {
        throw new ProviderError("IMAP_ERROR", "The IMAP server rejected the search");
      }
      return Array.isArray(result) ? result.length : (result.count ?? 0);
    }
    let count = 0;
    await this.exec(
      "UID SEARCH",
      [
        { type: "ATOM", value: "RETURN" },
        [{ type: "ATOM", value: "COUNT" }],
        ...this.attributes(criteria),
      ],
      {
        ESEARCH: async (untagged) => {
          const values = (untagged.attributes ?? []).map((a) => a.value);
          const at = values.findIndex((v) => typeof v === "string" && v.toUpperCase() === "COUNT");
          count = at >= 0 ? Number(values[at + 1]) || 0 : count;
        },
      },
    );
    return count;
  }

  /** One `UID FETCH` for `uids` (any order); returns the messages the server still has. */
  async fetch(uids: number[], query: FetchQueryObject): Promise<FetchMessageObject[]> {
    if (uids.length === 0) {
      return [];
    }
    this.commands++;
    const found: FetchMessageObject[] = [];
    for await (const message of this.client.fetch(
      uids.join(","),
      { uid: true, ...query },
      {
        uid: true,
      },
    )) {
      found.push(message);
    }
    return found;
  }

  private attributes(criteria: ImapCriteria): unknown[] {
    if ("raw" in criteria) {
      return rawCriteria(criteria.raw);
    }
    const query = criteria.query;
    return Object.keys(query).length === 0
      ? [{ type: "ATOM", value: "ALL" }]
      : searchCompiler(this.client, query);
  }

  /** Runs a command collecting numbers from one untagged response; null when the server refused. */
  private async execNumbers(
    command: string,
    untagged: string,
    attributes: unknown[],
  ): Promise<number[] | null> {
    const numbers: number[] = [];
    try {
      await this.exec(command, attributes, {
        [untagged]: async (response) => {
          numbers.push(...numbersOf(response));
        },
      });
    } catch {
      // A NO/BAD answer (unsupported key or charset): the caller falls back or reports it.
      return null;
    }
    return numbers;
  }

  private async exec(
    command: string,
    attributes: unknown[],
    untagged: Record<string, (untagged: Untagged) => Promise<void>>,
  ): Promise<void> {
    const response = await (this.client as unknown as ExecClient).exec(command, attributes, {
      untagged,
    });
    response.next();
  }
}

/** Compresses UIDs into an IMAP sequence set (`1:5,9`) for compact cursors. */
export function packUids(uids: Iterable<number>): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] as number) + 1) {
      j++;
    }
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(",");
}

/** Inverse of `packUids`. */
export function unpackUids(packed: string): number[] {
  if (!packed) {
    return [];
  }
  return packed.split(",").flatMap((part) => {
    const [from, to] = part.split(":").map(Number) as [number, number | undefined];
    if (!Number.isInteger(from) || (to !== undefined && !Number.isInteger(to))) {
      throw new ProviderError("INVALID_CURSOR", "Invalid IMAP change cursor");
    }
    return Array.from({ length: (to ?? from) - from + 1 }, (_, k) => from + k);
  });
}
