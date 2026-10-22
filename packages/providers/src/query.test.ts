import type { MailEnvelope } from "@passport/types";
import { describe, expect, it } from "vitest";
import { createMockEmails } from "./mock-fixtures.js";
import { parsePortableQuery, queryScopesSpamTrash, relativeCutoff } from "./query.js";
import { matchesQuery } from "./query-match.js";
import {
  listFilterToAst,
  renderGmailQuery,
  renderGraphQuery,
  renderImapQuery,
} from "./query-render.js";

const gmail = (query: string) => renderGmailQuery(parsePortableQuery(query));

describe("parsePortableQuery", () => {
  it("parses operators, phrases and bare words into an AND of nodes", () => {
    expect(
      parsePortableQuery('from:sam subject:"garden plan" is:unread has:attachment invoice'),
    ).toEqual({
      kind: "and",
      nodes: [
        { kind: "field", field: "from", value: "sam", phrase: false },
        { kind: "field", field: "subject", value: "garden plan", phrase: true },
        { kind: "is", value: "unread" },
        { kind: "has", value: "attachment" },
        { kind: "text", value: "invoice", phrase: false },
      ],
    });
    expect(parsePortableQuery("")).toEqual({ kind: "and", nodes: [] });
    expect(parsePortableQuery('"exact words"').nodes).toEqual([
      { kind: "text", value: "exact words", phrase: true },
    ]);
  });

  it("normalizes dates, relative windows, sizes and containers", () => {
    expect(parsePortableQuery("after:2026-01-15 before:2026/2/1 after:1768435200").nodes).toEqual([
      { kind: "date", op: "after", at: "2026-01-15T00:00:00.000Z", epochSeconds: 1768435200 },
      { kind: "date", op: "before", at: "2026-02-01T00:00:00.000Z", epochSeconds: 1769904000 },
      { kind: "date", op: "after", at: "2026-01-15T00:00:00.000Z", epochSeconds: 1768435200 },
    ]);
    expect(parsePortableQuery("newer_than:7d older_than:2Y larger:5M smaller:500k").nodes).toEqual([
      { kind: "relative", op: "newer_than", amount: 7, unit: "d" },
      { kind: "relative", op: "older_than", amount: 2, unit: "y" },
      { kind: "size", op: "larger", bytes: 5_000_000 },
      { kind: "size", op: "smaller", bytes: 500_000 },
    ]);
    expect(parsePortableQuery("in:Junk in:INBOX label:Receipts is:starred").nodes).toEqual([
      { kind: "in", value: "spam" },
      { kind: "in", value: "inbox" },
      { kind: "label", value: "Receipts" },
      { kind: "is", value: "flagged" },
    ]);
  });

  it("supports OR, negation and parentheses", () => {
    expect(parsePortableQuery("from:a OR from:b -is:read (x y) -(z OR w)").nodes).toEqual([
      {
        kind: "or",
        nodes: [
          { kind: "field", field: "from", value: "a", phrase: false },
          { kind: "field", field: "from", value: "b", phrase: false },
        ],
      },
      { kind: "not", node: { kind: "is", value: "read" } },
      {
        kind: "and",
        nodes: [
          { kind: "text", value: "x", phrase: false },
          { kind: "text", value: "y", phrase: false },
        ],
      },
      {
        kind: "not",
        node: {
          kind: "or",
          nodes: [
            { kind: "text", value: "z", phrase: false },
            { kind: "text", value: "w", phrase: false },
          ],
        },
      },
    ]);
  });

  it("treats non-operator colons as text and rejects unportable Gmail operators", () => {
    expect(parsePortableQuery("Re: https://example.com/x").nodes).toEqual([
      { kind: "text", value: "Re:", phrase: false },
      { kind: "text", value: "https://example.com/x", phrase: false },
    ]);
    for (const query of [
      "category:promotions",
      "has:drive",
      "is:important",
      "after:yesterday",
      "after:2026-02-30",
      "newer_than:7w",
      "larger:big",
      "(unclosed",
      "closed)",
      "OR x",
      "x OR",
    ]) {
      expect(() => parsePortableQuery(query), query).toThrow(
        expect.objectContaining({ code: "INVALID_QUERY" }),
      );
    }
  });

  it("detects explicit Spam/Trash scoping", () => {
    expect(queryScopesSpamTrash(parsePortableQuery("in:trash x"))).toBe(true);
    expect(queryScopesSpamTrash(parsePortableQuery("in:anywhere"))).toBe(true);
    expect(queryScopesSpamTrash(parsePortableQuery("-in:spam"))).toBe(false);
    expect(queryScopesSpamTrash(parsePortableQuery("in:inbox"))).toBe(false);
  });

  it("computes relative cutoffs in UTC calendar units", () => {
    const now = new Date("2026-03-31T12:00:00Z");
    const cutoff = (amount: number, unit: "d" | "m" | "y") =>
      relativeCutoff({ kind: "relative", op: "newer_than", amount, unit }, now).toISOString();
    expect(cutoff(7, "d")).toBe("2026-03-24T12:00:00.000Z");
    expect(cutoff(1, "y")).toBe("2025-03-31T12:00:00.000Z");
    expect(cutoff(12, "m")).toBe("2025-03-31T12:00:00.000Z");
  });
});

describe("renderGmailQuery", () => {
  it("passes most operators through", () => {
    expect(gmail('from:hetzner newer_than:1y has:attachment "net 30" subject:"a b"')).toBe(
      'from:hetzner newer_than:1y has:attachment "net 30" subject:"a b"',
    );
    expect(gmail("in:junk is:flagged is:unread label:My-Label larger:5M")).toBe(
      "in:spam is:starred is:unread label:My-Label larger:5000000",
    );
  });

  it("translates with:, dates, OR and negation", () => {
    expect(gmail("with:sam@example.com")).toBe(
      "{from:sam@example.com to:sam@example.com cc:sam@example.com bcc:sam@example.com}",
    );
    expect(gmail("after:2026-01-15 before:2026-02-01")).toBe("after:1768435200 before:1769904000");
    expect(gmail("from:a OR (from:b is:unread) -(x y) -is:read")).toBe(
      "(from:a OR (from:b is:unread)) -(x y) -is:read",
    );
    expect(gmail("rfc822msgid:<abc@x>")).toBe("rfc822msgid:<abc@x>");
    // Gmail has no quote escape inside phrases, so quotes are dropped.
    expect(renderGmailQuery(listFilterToAst({ from: 'Sam "the" Rivera' }))).toBe(
      'from:"Sam the Rivera"',
    );
  });

  it("renders structural list filters", () => {
    const ast = listFilterToAst({
      from: "sam",
      fromDomain: "example.com",
      unread: true,
      flagged: false,
      hasAttachment: true,
      after: "2026-01-01",
      before: "2026-02-01T00:00:00Z",
      largerThan: 1000,
    });
    expect(renderGmailQuery(ast)).toBe(
      "from:sam from:@example.com is:unread -is:starred has:attachment after:1767225600 before:1769904000 larger:1000",
    );
    expect(() => listFilterToAst({ after: "soon" })).toThrow(
      expect.objectContaining({ code: "INVALID_QUERY" }),
    );
  });

  it("leaves Graph and IMAP translation to their readers", () => {
    const ast = parsePortableQuery("x");
    expect(() => renderGraphQuery(ast)).toThrow(
      expect.objectContaining({ code: "NOT_IMPLEMENTED" }),
    );
    expect(() => renderImapQuery(ast)).toThrow(
      expect.objectContaining({ code: "NOT_IMPLEMENTED" }),
    );
  });
});

describe("matchesQuery", () => {
  const emails = createMockEmails("acc");
  const ctx = {
    now: new Date("2026-01-17T09:00:00Z"),
    labels: (email: MailEnvelope) =>
      email.mailboxIds.map((id) => {
        const name = decodeURIComponent(id.split(":").at(-1) ?? "");
        return { name, role: name === "Inbox" ? ("inbox" as const) : null };
      }),
  };
  const ids = (query: string) =>
    emails
      .filter((email) => matchesQuery(parsePortableQuery(query), email, ctx))
      .map((email) => email.providerId);

  it("matches participants, text, flags, attachments and containers", () => {
    expect(ids("from:sam subject:Garden")).toEqual([
      "fixture-19",
      "fixture-20",
      "fixture-21",
      "fixture-22",
    ]);
    expect(ids("from:@example.com is:unread has:attachment")).toEqual(["fixture-36", "fixture-38"]);
    expect(ids("from:@weekly.example list:weekly in:inbox")).toEqual([]);
    expect(ids("label:newsletters #105")).toEqual(["fixture-05"]);
    expect(ids('"usual room"')).toEqual(["fixture-33"]);
    expect(ids("filename:ics -from:sam")).toEqual([]);
    expect(ids("rfc822msgid:fixture-40@mock.passport")).toEqual(["fixture-40"]);
    expect(ids("with:alex@example.com").length).toBe(40);
  });

  it("matches dates, relative windows and sizes", () => {
    expect(ids("after:2026-01-16 before:2026-01-17").length).toBe(24);
    expect(ids("newer_than:1d").length).toBe(16);
    expect(ids("older_than:1d").length).toBe(24);
    expect(ids("larger:560 smaller:600")).toEqual(
      emails.filter((e) => e.size > 560 && e.size < 600).map((e) => e.providerId),
    );
  });
});
