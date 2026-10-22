import { Worker } from "node:worker_threads";
import { StoreError } from "./errors.js";

/** Longest `notes.search` pattern accepted; the same bound as `mail_grep` (R4-6). */
export const NOTES_REGEX_MAX_LENGTH = 200;

/** Wall-clock limit of one pattern search; tests lower it. */
export const notesRegexLimits = { timeoutMs: 2000 };

interface Group {
  quantified: boolean;
  alternation: boolean;
}

/** Length of the quantifier at `index` (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`), and whether it repeats. */
function quantifierAt(pattern: string, index: number): { length: number; repeats: boolean } | null {
  const char = pattern[index];
  if (char === "*" || char === "+") {
    return { length: pattern[index + 1] === "?" ? 2 : 1, repeats: true };
  }
  if (char === "?") {
    return { length: pattern[index + 1] === "?" ? 2 : 1, repeats: false };
  }
  const brace = /^\{(\d+)(,(\d*))?\}\??/.exec(pattern.slice(index));
  if (!brace) {
    return null;
  }
  const max = brace[2] === undefined ? Number(brace[1]) : brace[3] ? Number(brace[3]) : Infinity;
  return { length: brace[0].length, repeats: max > 1 };
}

/**
 * Why a pattern could backtrack catastrophically, or null. The same lint as `regexRisk` in
 * `@passport/tools` (`mail_grep`; the store does not depend on that package): it rejects
 * overlong patterns, backreferences and any repeated group that itself contains a quantifier or
 * an alternation (`(a+)+`, `(\w+\s?)*`, `(a|aa)*`). Polynomial patterns such as `\w*\w*x`
 * still pass, so matching also runs in a worker with a time limit.
 */
export function notesRegexRisk(pattern: string): string | null {
  if (pattern.length > NOTES_REGEX_MAX_LENGTH) {
    return `pattern is longer than ${NOTES_REGEX_MAX_LENGTH} characters`;
  }
  const stack: Group[] = [{ quantified: false, alternation: false }];
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const group = stack[stack.length - 1] as Group;
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      if (/[1-9]/.test(next) || (next === "k" && pattern[index + 2] === "<")) {
        return "backreferences are not supported";
      }
      if (/[pPu]/.test(next) && pattern[index + 2] === "{") {
        index = Math.max(index + 1, pattern.indexOf("}", index));
      } else {
        index++;
      }
    } else if (char === "[") {
      for (index++; index < pattern.length && pattern[index] !== "]"; index++) {
        if (pattern[index] === "\\") {
          index++;
        }
      }
    } else if (char === "(") {
      stack.push({ quantified: false, alternation: false });
      const look = /^\?(:|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(pattern.slice(index + 1));
      index += look ? look[0].length : 0;
    } else if (char === ")") {
      const closed = stack.length > 1 ? (stack.pop() as Group) : group;
      const parent = stack[stack.length - 1] as Group;
      const quantifier = quantifierAt(pattern, index + 1);
      if (quantifier?.repeats && (closed.quantified || closed.alternation)) {
        return "a repeated group contains a quantifier or alternation (nested quantifiers)";
      }
      parent.quantified ||= closed.quantified || quantifier !== null;
      index += quantifier?.length ?? 0;
    } else if (char === "|") {
      group.alternation = true;
    } else {
      const quantifier = quantifierAt(pattern, index);
      if (quantifier) {
        group.quantified = true;
        index += quantifier.length - 1;
      }
    }
  }
  return null;
}

/** Lints and compiles a pattern (compiling is linear; only matching can backtrack). */
export function checkNotesPattern(pattern: string, flags: string): void {
  const risk = notesRegexRisk(pattern);
  if (risk) {
    throw new StoreError("INVALID_QUERY", `pattern is too complex: ${risk}`);
  }
  try {
    new RegExp(pattern, flags);
  } catch {
    // The caller's own pattern is invalid; report it without echoing engine internals.
    throw new StoreError("INVALID_QUERY", "pattern is not a valid regular expression");
  }
}

/** Per record, the first field that matches and the match index; null when none does. */
export type FieldMatch = [field: number, index: number] | null;

// Inline (eval) source: no separate file to locate in `dist/` or in the published CLI bundle.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.pattern, workerData.flags);
parentPort.postMessage(workerData.records.map((fields) => {
  for (let field = 0; field < fields.length; field++) {
    const index = fields[field] ? fields[field].search(regex) : -1;
    if (index >= 0) return [field, index];
  }
  return null;
}));
`;

/**
 * Matches `pattern` against each record's fields in a worker thread, so a slow pattern over
 * attacker-influenced text (display names from From headers, notes quoting subjects) cannot
 * stall the server's event loop. Past `notesRegexLimits.timeoutMs` the worker is terminated and
 * `PATTERN_TIMEOUT` is thrown (R4-6).
 */
export function matchInWorker(
  pattern: string,
  flags: string,
  records: string[][],
): Promise<FieldMatch[]> {
  checkNotesPattern(pattern, flags);
  const seconds = notesRegexLimits.timeoutMs / 1000;
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { pattern, flags, records },
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error: StoreError | null, value?: FieldMatch[]) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) {
        reject(error);
      } else {
        resolve(value ?? []);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new StoreError(
            "PATTERN_TIMEOUT",
            `The pattern took longer than ${seconds} s and was stopped. Use a simpler pattern.`,
          ),
        ),
      notesRegexLimits.timeoutMs,
    );
    const failed = () => finish(new StoreError("PATTERN_FAILED", "Matching failed"));
    worker.once("message", (value: FieldMatch[]) => finish(null, value));
    worker.once("error", failed);
    worker.once("exit", failed);
  });
}
