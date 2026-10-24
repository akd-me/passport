import type { ActionCategory, ActionType, Counterparty, Email, Person } from "@passport/types";

export interface CategorizeInput {
  type: ActionType;
  emails?: readonly Email[];
  people?: readonly Person[];
  /** Outgoing recipients, including CC/BCC. Omit for operations on incoming mail. */
  recipientEmails?: readonly string[];
  selfEmails?: readonly string[];
  matterId?: string;
}

const normalize = (email: string) => email.trim().toLowerCase();
const priority: ActionCategory[] = [
  "legal",
  "money",
  "replies_stranger",
  "replies_known",
  "unsubscribe",
  "scheduling",
  "other",
  "newsletters",
  "receipts",
  "notifications",
  "triage",
  "matters",
];
const riskOrder: Counterparty["class"][] = ["self", "blue", "green_known", "service", "stranger"];

/** Pure, conservative inference. Unknown recipients and mixed batches inherit the highest risk. */
export function categorize(input: CategorizeInput): {
  category: ActionCategory;
  counterparty: Counterparty | null;
} {
  const emails = input.emails ?? [];
  const people = input.people ?? [];
  const self = new Set((input.selfEmails ?? []).map(normalize));
  const addresses = [
    ...new Set(
      (
        input.recipientEmails ??
        (emails.length
          ? emails.flatMap((email) => email.from.map((address) => address.email))
          : people.map((person) => person.primaryEmail))
      ).map(normalize),
    ),
  ];
  const parties = addresses.map((email) => {
    const person = people.find(
      (candidate) =>
        candidate.emails.some((address) => normalize(address) === email) ||
        normalize(candidate.primaryEmail) === email,
    );
    const senderMessages = emails.filter((message) =>
      message.from.some((address) => normalize(address.email) === email),
    );
    const downgraded =
      senderMessages.some((message) => message.verification.passport === "downgraded") ||
      Boolean(
        person?.lastSeenBlueAt &&
          person.verification !== "blue" &&
          (!person.downgradeAcknowledgedAt ||
            person.downgradeAcknowledgedAt < person.lastSeenBlueAt),
      );
    const failedSelf = senderMessages.some(
      (message) => message.verification.dmarc === "fail" || message.verification.dkim === "fail",
    );
    const blue = senderMessages.length
      ? senderMessages.every((message) => message.verification.passport === "blue")
      : person?.verification === "blue";
    let kind: Counterparty["class"] = "stranger";
    if (
      (self.has(email) || (person?.relationship === "self" && person.verifiedSelf)) &&
      failedSelf
    ) {
      kind = "stranger";
    } else if (self.has(email) || (person?.relationship === "self" && person.verifiedSelf)) {
      kind = "self";
    } else if (downgraded) {
      kind = "stranger";
    } else if (person?.relationship === "service") {
      kind = "service";
    } else if (blue) {
      kind = "blue";
    } else if (person?.relationship === "known") {
      kind = "green_known";
    }
    return { email, person, kind };
  });
  const riskiest = [...parties].sort(
    (a, b) => riskOrder.indexOf(b.kind) - riskOrder.indexOf(a.kind),
  )[0];
  const counterparty: Counterparty | null = riskiest
    ? {
        emails: addresses,
        class: riskiest.kind,
        ...(parties.length === 1 && riskiest.person ? { personId: riskiest.person.id } : {}),
      }
    : null;

  let category: ActionCategory;
  if (input.type === "profile_update") {
    category = "profile_update";
  } else if (
    ["matter_create", "matter_update", "matter_attach", "person_update", "profile_update"].includes(
      input.type,
    ) ||
    (input.type === "snooze" && input.matterId && emails.length === 0)
  ) {
    category = "matters";
  } else if (input.type === "unsubscribe") {
    category = "unsubscribe";
  } else if (input.type.startsWith("calendar_")) {
    category = "scheduling";
  } else {
    const sensitive = emails
      .map((email) => email.category)
      .filter((value): value is "money" | "legal" => value === "money" || value === "legal");
    if (sensitive.length) {
      category = sensitive.includes("legal") ? "legal" : "money";
    } else if (["draft_create", "draft_update", "send"].includes(input.type)) {
      category =
        parties.length &&
        parties.every(
          ({ person, kind }) =>
            kind !== "stranger" && (kind === "self" || person?.relationship === "known"),
        )
          ? "replies_known"
          : "replies_stranger";
    } else {
      const categories = emails.map((email) =>
        email.headers.listUnsubscribe?.trim()
          ? ("newsletters" as const)
          : (email.category ?? "triage"),
      );
      category = priority.find((candidate) => categories.includes(candidate)) ?? "triage";
    }
  }
  return { category, counterparty };
}
