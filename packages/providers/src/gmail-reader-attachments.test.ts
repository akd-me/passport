import { MAIL_ATTACHMENT_MAX_BYTES, RAW_GET_MAX_BYTES } from "@passport/types";
import { describe, expect, it } from "vitest";
import type { GmailMessage } from "./gmail-reader-normalize.js";
import { connectedReader, mailbox, response } from "./gmail-reader-testkit.js";
import { gmailRawGetUnits } from "./reader-raw-get.js";

const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
const PDF = "%PDF-1.4";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function full(): GmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    internalDate: String(Date.parse("2026-10-20T10:00:00Z")),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Sam <sam@example.com>" },
        { name: "Subject", value: "Plan" },
      ],
      parts: [
        { partId: "0", mimeType: "text/plain", body: { size: 5, data: b64("Hello") } },
        {
          partId: "1",
          mimeType: "application/pdf",
          filename: "plan.pdf",
          headers: [{ name: "Content-Disposition", value: 'attachment; filename="plan.pdf"' }],
          body: { size: PDF.length, attachmentId: "ANG-pdf" },
        },
        {
          partId: "2",
          mimeType: "image/png",
          filename: "logo.png",
          headers: [
            { name: "Content-Disposition", value: 'inline; filename="logo.png"' },
            { name: "Content-ID", value: "<logo@example.com>" },
          ],
          body: { size: PNG.length, data: b64(PNG) },
        },
        {
          partId: "3",
          mimeType: "application/zip",
          filename: "huge.zip",
          body: { size: MAIL_ATTACHMENT_MAX_BYTES + 1, attachmentId: "ANG-big" },
        },
      ],
    },
  };
}

function attachments(extra: Parameters<typeof mailbox>[2] = () => response({}, 404)) {
  return mailbox({ m1: full() }, [], (url, init) => {
    const path = url.pathname.replace("/gmail/v1/users/me/", "");
    if (path === "messages/m1/attachments/ANG-pdf") {
      return response({ size: PDF.length, data: b64(PDF) });
    }
    if (path === "messages/m1/attachments/ANG-big") {
      return response({ size: 1, data: b64("x") });
    }
    return extra(url, init);
  });
}

describe("GmailMailReader.attachment", () => {
  it("resolves an index from one format=full manifest fetch, then reuses it", async () => {
    const { reader, calls } = await connectedReader(attachments());
    const first = await reader.attachment("m1", { index: 0 });
    expect(first.value).toMatchObject({ name: "plan.pdf", type: "application/pdf", inline: false });
    expect(Buffer.from(first.value.data).toString()).toBe(PDF);
    expect(first.value.size).toBe(PDF.length);
    expect(first.cost.gmailUnits).toBe(60 + 20);
    expect(calls).toEqual(["GET messages/m1?format=full", "GET messages/m1/attachments/ANG-pdf"]);
    const second = await reader.attachment("m1", { name: "PLAN.PDF" });
    expect(second.value.name).toBe("plan.pdf");
    expect(second.cost.gmailUnits).toBe(20);
    expect(calls.slice(2)).toEqual(["GET messages/m1/attachments/ANG-pdf"]);
  });

  it("accepts the Gmail attachment id, part id and body() handles; body() warms the cache", async () => {
    const { reader, calls } = await connectedReader(attachments());
    const body = await reader.body("m1");
    const [pdf, logo] = body.value.attachments;
    calls.length = 0;
    for (const attachmentId of ["ANG-pdf", "1", pdf?.id, pdf?.blobId]) {
      const result = await reader.attachment("m1", { attachmentId });
      expect(result.value.name).toBe("plan.pdf");
      expect(result.cost.gmailUnits).toBe(20);
    }
    const inline = await reader.attachment("m1", { attachmentId: logo?.blobId });
    // Inline part bytes come with the manifest: no attachments.get.
    expect(inline.cost.gmailUnits).toBe(0);
    expect(calls).toEqual(Array(4).fill("GET messages/m1/attachments/ANG-pdf"));
  });

  it("returns inline images with their Content-ID", async () => {
    const { reader } = await connectedReader(attachments());
    const { value, cost } = await reader.attachment("m1", { name: "logo.png" });
    expect(value).toMatchObject({ type: "image/png", inline: true, contentId: "logo@example.com" });
    expect([...value.data]).toEqual([...PNG]);
    expect(cost.gmailUnits).toBe(60);
    // `index` counts non-inline attachments only, as mail_read lists them.
    await expect(reader.attachment("m1", { index: 1 })).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
    });
  });

  it("refuses attachments over the limit before downloading them", async () => {
    const { reader, calls } = await connectedReader(attachments());
    await expect(reader.attachment("m1", { name: "huge.zip" })).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
      detail: { size: MAIL_ATTACHMENT_MAX_BYTES + 1, limit: MAIL_ATTACHMENT_MAX_BYTES },
    });
    expect(calls).toEqual(["GET messages/m1?format=full"]);
  });

  it("reports unknown messages, attachments and empty references", async () => {
    const { reader } = await connectedReader(attachments());
    await expect(reader.attachment("nope", { index: 0 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(reader.attachment("m1", { index: 7 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(reader.attachment("m1", { attachmentId: "other" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(reader.attachment("m1", {})).rejects.toMatchObject({
      code: "INVALID_ATTACHMENT_REF",
    });
  });
});

describe("GmailMailReader.rawGet", () => {
  it("GETs allowlisted paths and prices them per method", async () => {
    const { reader, calls } = await connectedReader(
      attachments((url) =>
        url.pathname.endsWith("/settings/filters")
          ? response({ filter: [{ id: "f1" }] })
          : response({}, 404),
      ),
    );
    const filters = await reader.rawGet("users/me/settings/filters", {});
    expect(filters.value).toEqual({ status: 200, body: { filter: [{ id: "f1" }] } });
    expect(filters.cost.gmailUnits).toBe(1);
    const message = await reader.rawGet("/users/me/messages/m1", { format: "metadata" });
    expect((message.value.body as GmailMessage).id).toBe("m1");
    expect(message.cost.gmailUnits).toBe(20);
    expect(calls).toEqual(["GET settings/filters", "GET messages/m1?format=metadata"]);
    expect(reader.costLog.map((entry) => entry.method)).toEqual(["rawGet", "rawGet"]);
  });

  it("denies paths off the allowlist, absolute URLs and odd query keys without a request", async () => {
    const { reader, calls } = await connectedReader(attachments());
    for (const path of [
      "users/me/profile",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      "//evil.example/users/me/messages",
      "users/me/messages/../profile",
      "users/me/messages?q=x",
      "me/messages",
    ]) {
      await expect(reader.rawGet(path, {})).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    }
    await expect(reader.rawGet("users/me/labels", { "a b": "1" })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
    expect(calls).toEqual([]);
  });

  it("clips large responses to 256 KiB by dropping trailing array items", async () => {
    const labels = Array.from({ length: 5_000 }, (_, i) => ({
      id: `Label_${i}`,
      name: `A fairly long label name number ${i} for padding`,
    }));
    const { reader } = await connectedReader(mailbox({}, labels));
    const { value } = await reader.rawGet("users/me/labels", {});
    const body = value.body as { labels: unknown[] };
    expect(value.truncated).toBe(true);
    expect(value.totalBytes).toBeGreaterThan(RAW_GET_MAX_BYTES);
    expect(body.labels.length).toBeGreaterThan(0);
    expect(body.labels.length).toBeLessThan(5_000);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(RAW_GET_MAX_BYTES);
    expect(body.labels[0]).toEqual(labels[0]);
  });

  it("maps paths to GMAIL_UNIT_COSTS with a default of 5", () => {
    expect(gmailRawGetUnits("users/me/messages", {})).toBe(5);
    expect(gmailRawGetUnits("users/me/messages/x", {})).toBe(60);
    expect(gmailRawGetUnits("users/me/messages/x", { format: "minimal" })).toBe(20);
    expect(gmailRawGetUnits("users/me/messages/x/attachments/y", {})).toBe(20);
    expect(gmailRawGetUnits("users/me/threads", {})).toBe(10);
    expect(gmailRawGetUnits("users/me/threads/x", {})).toBe(120);
    expect(gmailRawGetUnits("users/me/threads/x", { format: "metadata" })).toBe(40);
    expect(gmailRawGetUnits("users/me/labels/INBOX", {})).toBe(1);
    expect(gmailRawGetUnits("users/me/history", {})).toBe(2);
    expect(gmailRawGetUnits("users/me/drafts", {})).toBe(5);
    expect(gmailRawGetUnits("users/me/settings/filters/f1", {})).toBe(1);
    expect(gmailRawGetUnits("users/me/settings/sendAs", {})).toBe(5);
  });
});
