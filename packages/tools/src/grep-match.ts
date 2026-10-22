/** One `mail_grep` matching job, run in the worker thread with a wall-clock limit. */
export interface GrepJob {
  grep: { pattern: string; flags: string; texts: string[]; maxMatches: number };
}

/** `[textIndex, lineIndex]` of each matching line, in order. */
export interface GrepHits {
  hits: Array<[number, number]>;
  truncated: boolean;
}

/** Lines are matched on their first 2,000 characters. */
export const GREP_LINE_SCAN = 2000;

export const linesOf = (text: string) => text.replace(/\r\n?/g, "\n").split("\n");

export function matchLines({ pattern, flags, texts, maxMatches }: GrepJob["grep"]): GrepHits {
  const regex = new RegExp(pattern, flags);
  const hits: Array<[number, number]> = [];
  for (const [item, text] of texts.entries()) {
    const lines = linesOf(text);
    for (let line = 0; line < lines.length; line++) {
      if (!regex.test((lines[line] ?? "").slice(0, GREP_LINE_SCAN))) {
        continue;
      }
      if (hits.length >= maxMatches) {
        return { hits, truncated: true };
      }
      hits.push([item, line]);
    }
  }
  return { hits, truncated: false };
}
