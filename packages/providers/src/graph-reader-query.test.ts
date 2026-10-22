import { describe, expect, it } from "vitest";
import { planRawGraphQuery } from "./graph-reader-query.js";
import { parsePortableQuery } from "./query.js";
import { listFilterToAst, renderGraphQuery } from "./query-render.js";

const now = new Date("2026-10-22T12:00:00Z");
const plan = (query: string) => renderGraphQuery(parsePortableQuery(query), now);

describe("renderGraphQuery", () => {
  it("uses $filter when every predicate is structured, with receivedDateTime first", () => {
    expect(plan("is:unread label:Work after:2026-01-01")).toEqual({
      strategy: "filter",
      filter:
        "receivedDateTime ge 2026-01-01T00:00:00.000Z and isRead eq false and categories/any(c:c eq 'Work')",
      clientFilter: [],
      translation: "graph:$filter",
    });
    expect(plan("from:Sam@Example.com has:attachment -is:flagged").filter).toBe(
      "from/emailAddress/address eq 'sam@example.com' and hasAttachments eq true and flag/flagStatus ne 'flagged'",
    );
    expect(plan("rfc822msgid:abc@host").filter).toBe("internetMessageId eq '<abc@host>'");
    expect(plan("newer_than:7d").filter).toBe("receivedDateTime ge 2026-10-15T12:00:00.000Z");
    expect(plan("is:unread OR is:starred").filter).toBe(
      "(isRead eq false or flag/flagStatus eq 'flagged')",
    );
    expect(plan(`label:"O'Brien"`).filter).toBe("categories/any(c:c eq 'O''Brien')");
    expect(plan("")).toEqual({
      strategy: "filter",
      clientFilter: [],
      translation: "graph:$filter",
    });
  });

  it("uses $search for free text and participants", () => {
    expect(plan('budget "design review" from:sam with:lee filename:pdf larger:5M')).toEqual({
      strategy: "search",
      search:
        'budget AND "design review" AND from:sam AND participants:lee AND attachment:pdf AND size>5000000',
      clientFilter: [],
      translation: "graph:$search",
    });
    // Structured predicates that KQL can express stay server-side.
    expect(plan("budget has:attachment after:2026-03-01").search).toBe(
      "budget AND hasAttachments:true AND received>=2026-03-01",
    );
    expect(plan("budget -lunch").search).toBe("budget AND NOT lunch");
    expect(plan("(budget OR invoice)").search).toBe("(budget OR invoice)");
  });

  it("moves structured-only predicates client-side when mixed with free text", () => {
    const mixed = plan("budget is:unread in:inbox label:Work");
    expect(mixed).toMatchObject({
      strategy: "search+clientFilter",
      search: "budget",
      folder: "inbox",
      translation: "graph:$search+clientFilter",
    });
    expect(mixed.clientFilter).toEqual([
      { kind: "is", value: "unread" },
      { kind: "label", value: "Work" },
    ]);
  });

  it("scopes in: to a folder and keeps unsupported predicates client-side", () => {
    expect(plan("in:spam is:unread")).toMatchObject({ folder: "junkemail", strategy: "filter" });
    // The parser lower-cases in:; the reader resolves folder names case-insensitively.
    expect(plan("in:Projects").folder).toBe("projects");
    expect(plan("in:anywhere budget").folder).toBeUndefined();
    expect(plan("list:news is:unread")).toMatchObject({
      strategy: "filter",
      filter: "isRead eq false",
      clientFilter: [{ kind: "field", field: "list", value: "news", phrase: false }],
      translation: "graph:$filter+clientFilter",
    });
  });

  it("plans mail_list filters", () => {
    const domain = renderGraphQuery(listFilterToAst({ fromDomain: "example.com", unread: true }));
    expect(domain).toMatchObject({
      strategy: "search+clientFilter",
      search: "from:example.com",
    });
    expect(domain.clientFilter).toEqual([{ kind: "is", value: "unread" }]);
    const structured = renderGraphQuery(listFilterToAst({ flagged: true, hasAttachment: false }));
    expect(structured.filter).toBe("flag/flagStatus eq 'flagged' and hasAttachments eq false");
  });

  it("passes raw queries through", () => {
    expect(planRawGraphQuery("$filter=isRead eq false")).toMatchObject({
      strategy: "filter",
      filter: "isRead eq false",
    });
    expect(planRawGraphQuery("subject:hello")).toMatchObject({
      strategy: "search",
      search: "subject:hello",
    });
  });
});
