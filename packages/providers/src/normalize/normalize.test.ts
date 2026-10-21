import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { zonedToUtc } from "../calendar-common.js";
import gmail from "../fixtures/gmail.json" with { type: "json" };
import graph from "../fixtures/graph.json" with { type: "json" };
import jmap from "../fixtures/jmap.json" with { type: "json" };
import { normalizeGmail } from "../gmail.js";
import { normalizeGraph } from "../graph.js";
import { normalizeJmap } from "../jmap.js";
import { account, draft } from "../test/helpers.js";
import {
  composeMime,
  decodeMimeBlob,
  generatePreview,
  htmlToText,
  mimeAttachment,
  normalizeAddresses,
  normalizeHeaders,
  normalizeMime,
  parseListUnsubscribe,
  toIso,
} from "./index.js";

const mime = readFileSync(new URL("../fixtures/invite.eml", import.meta.url));
describe("shared normalization", () => {
  it("parses quoted address names, multiple recipients, and groups", () => {
    expect(
      normalizeAddresses('"Rivera, Sam" <SAM@example.com>, Friends: Alex <Alex@example.com>;'),
    ).toEqual([
      { name: "Rivera, Sam", email: "sam@example.com" },
      { name: "Alex", email: "alex@example.com" },
    ]);
  });
  it("normalizes structured addresses and omits invalid raw addresses", () => {
    expect(normalizeAddresses([{ name: " Sam ", email: " SAM@example.com " }])).toEqual([
      { name: "Sam", email: "sam@example.com" },
    ]);
    expect(normalizeAddresses("bad, sam@example.com")).toEqual([{ email: "sam@example.com" }]);
  });
  it("converts offsets and epoch timestamps to UTC", () => {
    expect(toIso("2026-01-20T09:00:00-05:00")).toBe("2026-01-20T14:00:00.000Z");
    expect(toIso(0)).toBe("1970-01-01T00:00:00.000Z");
  });
  it("rejects invalid dates", () => {
    expect(() => toIso("not-a-date")).toThrow(expect.objectContaining({ code: "INVALID_DATE" }));
  });
  it("converts wall times independently of the machine timezone", () => {
    expect(zonedToUtc("2026-01-20T09:00:00", "America/New_York")).toBe("2026-01-20T14:00:00.000Z");
    expect(zonedToUtc("2026-07-20T09:00:00", "Eastern Standard Time")).toBe(
      "2026-07-20T13:00:00.000Z",
    );
  });
  it("makes useful HTML text without active content", () => {
    expect(
      htmlToText("<style>hidden</style><p>A &amp; B<br>Hi &#x1F44B;</p><script>bad()</script>"),
    ).toBe("A & B\nHi 👋");
  });
  it("collapses preview whitespace and does not split Unicode code points", () => {
    expect(generatePreview("  Hello\n   world!  ", 8)).toBe("Hello wo");
    expect(generatePreview("👋👋!", 1)).toBe("👋");
  });
  it("parses header unsubscribe methods without inventing content links", () => {
    expect(
      parseListUnsubscribe(
        "<https://x.example/u>, <mailto:leave@x.example?subject=stop>",
        "List-Unsubscribe=One-Click",
      ),
    ).toEqual({
      urls: ["https://x.example/u"],
      emails: ["leave@x.example?subject=stop"],
      oneClick: true,
    });
    expect(parseListUnsubscribe()).toEqual({ urls: [], emails: [], oneClick: false });
  });
  it("retains duplicate authentication headers and lowercase extras", () => {
    const h = normalizeHeaders([
      { name: "Authentication-Results", value: "mx; dkim=pass" },
      { name: "Authentication-Results", value: "mx; spf=pass" },
      { name: "X-Test", value: "yes" },
    ]);
    expect(h.authenticationResults).toHaveLength(2);
    expect(h.extra?.["x-test"]).toBe("yes");
  });
  it("parses MIME encoded headers, HTML fallback, references, and calendar parts", async () => {
    const e = await normalizeMime(mime, {
      accountId: "a",
      providerId: "imap-1",
      mailboxIds: ["INBOX"],
    });
    expect(e.subject).toBe("Design review ✓");
    expect(e.from[0]).toEqual({ name: "Sam Rivera", email: "sam@example.com" });
    expect(e.textBody).toBe("Let's meet at 2pm.");
    expect(e.headers.references).toHaveLength(2);
    expect(e.headers.listUnsubscribePost).toBe("List-Unsubscribe=One-Click");
    expect(e.verification.dkim).toBe("pass");
    expect(e.attachments[0]?.type).toBe("text/calendar");
    const [id, index] = decodeMimeBlob(e.attachments[0]!.blobId);
    expect(id).toBe("imap-1");
    expect(Buffer.from((await mimeAttachment(mime, index)).data).toString()).toContain(
      "BEGIN:VCALENDAR",
    );
  });
  it("composes MIME with Bcc, replies, and attachments that round-trip", async () => {
    const raw = await composeMime(
      account,
      {
        ...draft,
        bcc: [{ email: "private@example.com" }],
        attachments: [{ name: "a.txt", type: "text/plain", blobId: "blob" }],
      },
      async () => ({ data: Buffer.from("hello attachment") }),
    );
    const parsed = await normalizeMime(raw, { accountId: account.id, providerId: "composed" });
    expect(parsed.to[0]?.email).toBe("sam@example.com");
    expect(parsed.bcc[0]?.email).toBe("private@example.com");
    expect(parsed.attachments[0]?.name).toBe("a.txt");
  });
});

describe("recorded-style JSON normalization", () => {
  it("normalizes Gmail full multipart payloads", async () => {
    const e = await normalizeGmail(gmail, "a");
    expect(e.subject).toBe("Design review");
    expect(e.textBody).toBe("Let's meet at 2pm.");
    expect(e.keywords).toMatchObject({ $flagged: true, "label:Label_work": true });
    expect(e.keywords.$seen).toBeUndefined();
    expect(e.attachments[0]?.blobId).toMatch(/^gmail:/);
    expect(e.verification.signer).toBe("example.com");
    expect(e.sentAt).toBe("2026-01-20T14:00:00.000Z");
  });
  it("normalizes Gmail raw messages through the same MIME parser", async () => {
    const e = await normalizeGmail(
      { id: "raw", raw: mime.toString("base64url"), internalDate: "1768917600000" },
      "a",
    );
    expect(e.subject).toBe("Design review ✓");
    expect(e.attachments).toHaveLength(1);
  });
  it("decodes RFC 2047 envelope fields in Gmail full-format headers", async () => {
    const e = await normalizeGmail(
      {
        id: "encoded",
        payload: {
          headers: [
            { name: "From", value: "=?UTF-8?Q?Sam_Rivera?= <sam@example.com>" },
            { name: "Subject", value: "=?UTF-8?Q?Review_=E2=9C=93?=" },
          ],
        },
      },
      "a",
    );
    expect(e.from[0]?.name).toBe("Sam Rivera");
    expect(e.subject).toBe("Review ✓");
  });
  it("normalizes Graph recipients, flags, HTML, categories, and failed authentication", async () => {
    const e = await normalizeGraph(graph, "a");
    expect(e.from[0]?.email).toBe("sam@example.com");
    expect(e.textBody).toBe("Let's meet at 2pm.");
    expect(e.keywords).toMatchObject({ $seen: true, $flagged: true, "label:Work": true });
    expect(e.verification).toMatchObject({ dkim: "fail", passport: "green" });
    expect(e.attachments[0]?.type).toBe("application/pdf");
  });
  it("normalizes JMAP bodyValues and native blob handles", async () => {
    const e = await normalizeJmap(jmap, "a");
    expect(e.headers.messageId).toBe("<review@example.com>");
    expect(e.headers.inReplyTo).toBe("<root@example.com>");
    expect(e.textBody).toBe("Let's meet at 2pm.");
    expect(e.attachments[0]?.blobId).toBe("blob-1");
  });
  it("uses the injected Passport verifier without inferring trust from content", async () => {
    const e = await normalizeGmail(gmail, "a", {
      async verify(_headers, state) {
        return { ...state, passport: "blue", signer: "passport:sam" };
      },
    });
    expect(e.verification.passport).toBe("blue");
  });
});
