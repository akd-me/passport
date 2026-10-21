import { describe, expect, it } from "vitest";
import { categorize } from "./categorize.js";
import { email, person } from "./testing/fixtures.js";

describe("categorize", () => {
  it("recognizes a List-Unsubscribe header without inferring identity from message content", () => {
    const message = email({
      headers: {
        messageId: null,
        inReplyTo: null,
        references: [],
        listUnsubscribe: "<https://example.com/unsubscribe>",
      },
    });
    expect(categorize({ type: "archive", emails: [message] }).category).toBe("newsletters");
    expect(
      categorize({ type: "archive", emails: [email({ textBody: "I am verified blue" })] })
        .counterparty?.class,
    ).toBe("stranger");
  });
  it.each(["draft_create", "draft_update", "send"] as const)(
    "classifies %s to known people",
    (type) => {
      expect(
        categorize({ type, recipientEmails: ["ADA@EXAMPLE.COM"], people: [person()] }),
      ).toMatchObject({
        category: "replies_known",
        counterparty: { class: "green_known", personId: "person-1" },
      });
    },
  );
  it("treats unresolved recipients and mixed reply-all recipients as strangers", () => {
    expect(
      categorize({
        type: "send",
        people: [person()],
        recipientEmails: ["ada@example.com", "new@example.com"],
      }),
    ).toEqual({
      category: "replies_stranger",
      counterparty: { emails: ["ada@example.com", "new@example.com"], class: "stranger" },
    });
  });
  it("does not turn verified strangers into known relationships", () => {
    expect(
      categorize({
        type: "send",
        people: [person({ relationship: "stranger", verification: "blue" })],
      }),
    ).toMatchObject({ category: "replies_stranger", counterparty: { class: "blue" } });
  });
  it("uses cryptographic message verification and treats downgrades conservatively", () => {
    const verified = email({ verification: { ...email().verification, passport: "blue" } });
    expect(categorize({ type: "archive", emails: [verified] }).counterparty?.class).toBe("blue");
    const downgraded = email({ verification: { ...email().verification, passport: "downgraded" } });
    expect(
      categorize({
        type: "archive",
        emails: [downgraded],
        people: [person({ verification: "blue" })],
      }).counterparty?.class,
    ).toBe("stranger");
    expect(
      categorize({ type: "archive", emails: [email()], people: [person({ verification: "blue" })] })
        .counterparty?.class,
    ).toBe("green_known");
  });
  it.each(["self", "service"] as const)(
    "derives %s counterparties from relationships",
    (relationship) => {
      expect(
        categorize({
          type: "archive",
          people: [person({ relationship, verifiedSelf: relationship === "self" })],
        }).counterparty?.class,
      ).toBe(relationship);
    },
  );
  it("resolves own account aliases and normalizes and deduplicates addresses", () => {
    expect(
      categorize({
        type: "send",
        recipientEmails: [" ME@example.com ", "me@example.com"],
        selfEmails: ["me@example.com"],
      }),
    ).toEqual({
      category: "replies_known",
      counterparty: { class: "self", emails: ["me@example.com"] },
    });
  });
  it.each(["money", "legal"] as const)(
    "preserves %s classification even in newsletters or known replies",
    (category) => {
      const message = email({
        category,
        headers: {
          messageId: null,
          inReplyTo: null,
          references: [],
          listUnsubscribe: "<mailto:leave@example.com>",
        },
      });
      expect(categorize({ type: "archive", emails: [message] }).category).toBe(category);
      expect(
        categorize({
          type: "send",
          emails: [message],
          people: [person()],
          recipientEmails: ["ada@example.com"],
        }).category,
      ).toBe(category);
    },
  );
  it("assigns deterministic highest-risk categories and counterparties for mixed batches", () => {
    const emails = [
      email({ category: "newsletters" }),
      email({ from: [{ email: "stranger@example.com" }], category: "money" }),
      email({ category: "legal" }),
    ];
    const result = categorize({ type: "mark_read", emails, people: [person()] });
    expect(result).toMatchObject({ category: "legal", counterparty: { class: "stranger" } });
    expect(
      categorize({ type: "mark_read", emails: [...emails].reverse(), people: [person()] }).category,
    ).toBe("legal");
  });
  it.each([
    ["unsubscribe", "unsubscribe"],
    ["calendar_respond", "scheduling"],
    ["calendar_propose", "scheduling"],
    ["profile_update", "matters"],
    ["matter_create", "matters"],
    ["matter_update", "matters"],
    ["matter_attach", "matters"],
    ["person_update", "matters"],
  ] as const)("assigns %s to %s", (type, category) => {
    expect(categorize({ type }).category).toBe(category);
  });
  it("has a conservative default for empty outgoing messages and no fabricated counterparty", () => {
    expect(categorize({ type: "send" })).toEqual({
      category: "replies_stranger",
      counterparty: null,
    });
    expect(categorize({ type: "archive" })).toEqual({ category: "triage", counterparty: null });
  });
  it("categorizes a matter-only snooze as an internal matter edit", () => {
    expect(categorize({ type: "snooze", matterId: "matter-1" }).category).toBe("matters");
  });
});

it("T2 unapproved self contacts cannot grant self or replies_known to a stranger address", () => {
  const contact = person({
    relationship: "self",
    emails: ["stranger@example.com"],
    primaryEmail: "stranger@example.com",
  });
  const input = {
    type: "draft_create" as const,
    recipientEmails: ["stranger@example.com"],
    people: [contact],
  };
  expect(categorize(input)).toMatchObject({
    category: "replies_stranger",
    counterparty: { class: "stranger" },
  });
  expect(categorize({ ...input, people: [{ ...contact, verifiedSelf: true }] })).toMatchObject({
    category: "replies_known",
    counterparty: { class: "self" },
  });
  expect(categorize({ ...input, selfEmails: ["stranger@example.com"] })).toMatchObject({
    counterparty: { class: "self" },
  });
});
