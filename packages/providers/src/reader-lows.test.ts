import { describe, expect, it } from "vitest";
import { encodeChangeCursor } from "./gmail-reader-support.js";
import { account, connectedReader } from "./gmail-reader-testkit.js";
import { parsePortableQuery } from "./query.js";
import { renderGraphQuery } from "./query-render.js";
import { clampCap, MAX_COUNT_CAP } from "./reader-limits.js";
import { response } from "./test/helpers.js";

const now = new Date("2026-10-22T12:00:00Z");
const graph = (q: string) => renderGraphQuery(parsePortableQuery(q), now);

describe("low-severity review fixes", () => {
  it("R1-12: Gmail drafts, sends and chats are not reported as arrivals", async () => {
    const { reader } = await connectedReader((url) =>
      url.pathname.endsWith("/history")
        ? response({
            historyId: "12",
            history: [
              {
                id: "11",
                messagesAdded: [
                  { message: { id: "in", labelIds: ["INBOX", "UNREAD"] } },
                  { message: { id: "draft", labelIds: ["DRAFT"] } },
                  { message: { id: "sent", labelIds: ["SENT"] } },
                ],
              },
            ],
          })
        : response({}, 404),
    );
    const { value } = await reader.changes(encodeChangeCursor(account.id, "10"), 50);
    expect(value.added).toEqual(["in"]);
    expect(value.labelChanged).toEqual(["draft", "sent"]);
  });

  it("R1-17: bare KQL keywords are quoted", () => {
    expect(graph("budget NOT").search).toBe('budget AND "NOT"');
    expect(graph("q3 near plan").search).toBe('q3 AND "near" AND plan');
  });

  it("R1-18: $search date bounds with a time of day are re-checked client-side", () => {
    const relative = graph("newer_than:1d invoice");
    expect(relative.search).toBe("received>=2026-10-21 AND invoice");
    expect(relative.clientFilter).toHaveLength(1);
    const before = graph(`before:${Date.parse("2026-10-20T08:00:00Z") / 1000} invoice`);
    // KQL `<` is widened to the next day so nothing in range is lost.
    expect(before.search).toBe("received<2026-10-21 AND invoice");
    expect(before.clientFilter).toHaveLength(1);
    expect(graph("after:2026-10-20 invoice").clientFilter).toHaveLength(0);
  });

  it("R1-19: count caps are clamped to [0, 10,000]", () => {
    expect(clampCap(Number.POSITIVE_INFINITY)).toBe(MAX_COUNT_CAP);
    expect(clampCap(1e6)).toBe(MAX_COUNT_CAP);
    expect(clampCap(-5)).toBe(0);
    expect(clampCap(Number.NaN)).toBe(0);
    expect(clampCap(25.9)).toBe(25);
  });

  it("R1-19: Gmail countIds with an unlimited cap counts instead of returning 0", async () => {
    const { reader } = await connectedReader(() =>
      response({ messages: [{ id: "a" }, { id: "b" }] }),
    );
    const { value } = await reader.countIds("from:sam", Number.POSITIVE_INFINITY);
    expect(value).toEqual({ count: 2, capped: false });
  });
});
