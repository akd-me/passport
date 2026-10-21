import type { CounterpartyClass, Person, PolicyDecision } from "@passport/types";

/** Classify only known identity/relationship data; message content never grants trust. */
export function classifyCounterparty(
  person: Person | null,
  emails: string[],
  selfAddresses: string[],
): CounterpartyClass {
  const normalize = (value: string) => value.trim().toLowerCase();
  const self = new Set(selfAddresses.map(normalize));
  if (emails.length > 0 && emails.every((email) => self.has(normalize(email)))) {
    return "self";
  }
  if (
    !person ||
    !emails.every((email) => person.emails.some((known) => normalize(known) === normalize(email)))
  ) {
    return "stranger";
  }
  if (person.relationship === "self" && person.verifiedSelf) {
    return "self";
  }
  if (
    person.lastSeenBlueAt &&
    person.verification !== "blue" &&
    (!person.downgradeAcknowledgedAt || person.downgradeAcknowledgedAt < person.lastSeenBlueAt)
  ) {
    return "stranger";
  }
  if (person.relationship === "service") {
    return "service";
  }
  if (person.verification === "blue") {
    return "blue";
  }
  return person.relationship === "known" ? "green_known" : "stranger";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function textDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const left = Array.from(a),
    right = Array.from(b);
  if (!left.length || !right.length) {
    return 1;
  }
  let row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(
        next[j - 1]! + 1,
        row[j]! + 1,
        row[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[right.length]! / Math.max(left.length, right.length);
}

function leaves(
  value: unknown,
  path = "",
  output = new Map<string, string>(),
): Map<string, string> {
  if (value && typeof value === "object" && Object.keys(value).length) {
    for (const [key, item] of Object.entries(value)) {
      leaves(item, `${path}/${key}`, output);
    }
  } else {
    output.set(path, JSON.stringify(canonical(value)) ?? "undefined");
  }
  return output;
}

/** Normalized Levenshtein distance for strings; changed JSON leaves / union of leaves otherwise. */
export function editDistanceRatio(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    return textDistance(a, b);
  }
  const left = leaves(a),
    right = leaves(b);
  const keys = new Set([...left.keys(), ...right.keys()]);
  return (
    [...keys].filter((key) => left.get(key) !== right.get(key)).length / Math.max(1, keys.size)
  );
}

/** A short explanation suitable for the decisions feed or CLI. */
export function describeDecision(decision: PolicyDecision): string {
  return `${decision.outcome}: ${decision.reason} (${decision.risk} risk, ${decision.reversibility}, ${decision.trustLevel})`;
}
