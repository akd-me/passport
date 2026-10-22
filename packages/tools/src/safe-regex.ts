import { ToolError } from "./presentation.js";

/** Longest model-supplied regular expression `mail_grep` and `notes_search` accept. */
export const REGEX_MAX_LENGTH = 200;

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
 * Why a pattern could backtrack catastrophically, or null. Rejects backreferences and any
 * repeated group that itself contains a quantifier or an alternation (`(a+)+`, `(\w+\s?)*`,
 * `(a|aa)*`). Polynomial patterns such as `\w*x` still pass, so matching over attacker text
 * must also be time-bounded (`mail_grep` runs in a worker).
 */
export function regexRisk(pattern: string): string | null {
  if (pattern.length > REGEX_MAX_LENGTH) {
    return `pattern is longer than ${REGEX_MAX_LENGTH} characters`;
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

/** Compiles a model-supplied pattern after the backtracking lint; INVALID_INPUT otherwise. */
export function compileSafeRegex(pattern: string, flags: string): RegExp {
  const risk = regexRisk(pattern);
  if (risk) {
    throw new ToolError("INVALID_INPUT", `pattern is too complex: ${risk}.`);
  }
  try {
    return new RegExp(pattern, [...new Set(flags)].join(""));
  } catch {
    // Report the stable input error; the engine message adds nothing for the agent.
    throw new ToolError("INVALID_INPUT", "pattern is not a valid JavaScript regular expression.");
  }
}
