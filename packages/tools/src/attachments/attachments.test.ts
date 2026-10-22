import type { MailReader } from "@passport/types";
import { MAIL_ATTACHMENT_MAX_BYTES } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import { UNTRUSTED_NOTICE } from "../ondemand-support.js";
import { onDemandHarness } from "../testing/ondemand.js";
import * as make from "./fixtures/make.js";
import { EXTRACTION_TIMEOUT_MS } from "./kinds.js";
import { extraction } from "./run-worker.js";
import { IMAGE_CONTENT } from "./tool.js";

const ZW = "​";
type File = { name: string; type: string; data: Uint8Array; inline?: boolean };

/** A harness whose message `account-1:email:att` carries `files` in order. */
async function withFiles(files: File[], options: Parameters<typeof onDemandHarness>[0] = {}) {
  const harness = await onDemandHarness(options);
  const provider = harness.provider();
  provider.injectEmail({
    providerId: "att",
    attachments: files.map((file, index) => ({
      id: `account-1:attachment:att-${index}`,
      name: file.name,
      type: file.type,
      size: file.data.byteLength,
      blobId: provider.injectBlob(file.data, file.type),
      disposition: file.inline ? "inline" : "attachment",
    })),
  });
  const read = (attachment: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    harness.call("mail_attachment_read", { id: "account-1:email:att", attachment, ...extra });
  return { ...harness, read };
}

afterEach(() => {
  extraction.timeoutMs = EXTRACTION_TIMEOUT_MS;
  delete extraction.worker;
});

describe("mail_attachment_read", () => {
  it("windows text attachments with maxChars/offset and frames them as untrusted", async () => {
    const csv = "name,amount\nrent,2400\n$HOME,/etc\n";
    const { read } = await withFiles([
      { name: "ledger.csv", type: "application/octet-stream", data: Buffer.from(csv) },
    ]);
    const first = await read({ index: 0 }, { maxChars: 12 });
    expect(first).toMatchObject({
      account: "account-1",
      message: "account-1:email:att",
      attachment: { name: "ledger.csv", size: csv.length, inline: false },
      kind: "text",
      offset: 0,
      text: "name,amount\n",
      truncated: true,
      continueFrom: 12,
      source: "provider",
      cost: { gmailUnits: 20 },
      untrusted: expect.stringContaining(UNTRUSTED_NOTICE),
    });
    const rest = await read({ name: "LEDGER.CSV" }, { offset: 12 });
    expect(rest).toMatchObject({ offset: 12, truncated: false, continueFrom: null });
    expect(rest.text).toBe(`rent,2400\n$${ZW}HOME,/etc\n`);
  });

  it("extracts PDF text per page with a pages range and flags scanned pages", async () => {
    const { read } = await withFiles([
      {
        name: "lease.pdf",
        type: "application/pdf",
        data: make.pdf(["Rent is 2400", "", "Sign here"]),
      },
    ]);
    const all = await read({ index: 0 });
    expect(all).toMatchObject({
      kind: "pdf",
      pages: { from: 1, to: 3, total: 3 },
      scanned: true,
      scannedPages: [2],
      truncated: false,
    });
    expect(all.text).toContain("--- page 1 ---\nRent is 2400");
    expect(all.text).toContain("--- page 2 ---\n[no text layer");
    const last = await read({ index: 0 }, { pages: "3-" });
    expect(last).toMatchObject({ pages: { from: 3, to: 3, total: 3 }, scanned: false });
    expect(last.text).toBe("--- page 3 ---\nSign here");
    expect(await read({ index: 0 }, { pages: "5-2" })).toMatchObject({ error: "INVALID_INPUT" });
  });

  it("reads .docx, .pptx (with notes) and spreadsheets by sheet and rows", async () => {
    const { read } = await withFiles([
      {
        name: "terms.docx",
        type: "application/octet-stream",
        data: make.docx(["Clause 1", "Clause 2"]),
      },
      {
        name: "deck.pptx",
        type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        data: make.pptx([{ text: ["Q3 plan", "Ship it"], notes: "Say thanks" }, { text: ["End"] }]),
      },
      {
        name: "budget.xlsx",
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        data: make.xlsx({
          Costs: [
            ["item", "eur"],
            ["rent", 2400],
            ["power", 90],
          ],
          Notes: [["ok"]],
        }),
      },
    ]);
    const docx = await read({ name: "terms.docx" });
    expect(docx).toMatchObject({ kind: "docx", text: "Clause 1\n\nClause 2" });
    const deck = await read({ index: 1 });
    expect(deck).toMatchObject({ kind: "pptx", slides: 2 });
    expect(deck.text).toBe(
      "--- slide 1 ---\nQ3 plan\nShip it\nNotes: Say thanks\n\n--- slide 2 ---\nEnd",
    );
    const book = await read({ index: 2 });
    expect(book).toMatchObject({
      kind: "sheet",
      sheets: [
        { name: "Costs", rows: 3 },
        { name: "Notes", rows: 1 },
      ],
      rows: { from: 1, to: 3, total: 3 },
    });
    expect(book.text).toBe("# Sheet: Costs\nitem,eur\nrent,2400\npower,90\n\n# Sheet: Notes\nok");
    const window = await read({ index: 2 }, { sheet: "costs", rows: "2-2" });
    expect(window).toMatchObject({ sheet: "Costs", rows: { from: 2, to: 2, total: 3 } });
    expect(window.text).toBe("rent,2400");
    expect(await read({ index: 2 }, { sheet: "Missing" })).toMatchObject({
      isError: true,
      error: "SHEET_NOT_FOUND",
    });
  });

  it("summarises calendar invites and attached emails, neutralising sigils", async () => {
    const { read } = await withFiles([
      { name: "invite.ics", type: "text/calendar", data: Buffer.from(make.ICS) },
      { name: "fwd.eml", type: "message/rfc822", data: Buffer.from(make.EML) },
    ]);
    const invite = await read({ index: 0 });
    expect(invite).toMatchObject({
      kind: "calendar",
      calendar: {
        method: "REQUEST",
        events: [
          {
            summary: "Lease signing, final",
            start: "2026-11-05T15:00:00Z",
            end: "2026-11-05T16:00:00Z",
            location: "Acme office",
            organizer: "Ruiz, Dana <dana@acme.example>",
            attendees: [{ address: "alex@example.com", status: "ACCEPTED" }],
          },
        ],
      },
    });
    expect(invite.text).toContain("Event: Lease signing, final");
    expect(invite.text).toContain(`$${ZW}(rm -rf /)`);
    expect(invite.text).not.toContain("alarm text");
    const message = await read({ name: "fwd.eml" });
    expect(message).toMatchObject({
      kind: "message",
      message: {
        from: "Dana Ruíz <dana@acme.example>",
        subject: "Lease rénewal",
        rfc822Id: "<inner-1@acme.example>",
        attachments: [{ name: "terms.pdf", type: "application/pdf", size: 13 }],
      },
    });
    expect(message.text).toBe(`The rénewal terms are attached. Call @${ZW}ops.`);
  });

  it("returns images as a note, or as image content with asImage or an image-capable host", async () => {
    const { read } = await withFiles([
      { name: "scan.png", type: "image/png", data: make.PNG },
      { name: "photo.tiff", type: "image/tiff", data: Buffer.from("II*\0tiff") },
    ]);
    const note = await read({ index: 0 });
    expect(note).toMatchObject({
      kind: "image",
      bytes: make.PNG.byteLength,
      mimeType: "image/png",
    });
    expect(note.note).toMatch(/asImage:true/);
    expect(IMAGE_CONTENT in note).toBe(false);
    const image = await read({ index: 0 }, { asImage: true });
    expect((image as Record<symbol, unknown>)[IMAGE_CONTENT]).toEqual({
      data: make.PNG.toString("base64"),
      mimeType: "image/png",
    });
    expect(JSON.stringify(image)).not.toContain(make.PNG.toString("base64"));
    expect(await read({ index: 1 }, { asImage: true })).toMatchObject({
      kind: "image",
      note: expect.stringContaining("only PNG"),
    });
    const host = await onDemandHarness({ imageContent: true });
    const logo = await host.call("mail_attachment_read", {
      id: "account-1:email:fixture-11",
      attachment: { name: "logo.png" },
    });
    expect(logo).toMatchObject({ attachment: { name: "logo.png", inline: true } });
    expect((logo as Record<symbol, unknown>)[IMAGE_CONTENT]).toMatchObject({
      mimeType: "image/png",
    });
  });

  it("reports unsupported types with metadata and a printable preview, never a hexdump", async () => {
    const zip = new Uint8Array([
      0x50,
      0x4b,
      0x03,
      0x04,
      ...Buffer.from("readme.txt payload"),
      0,
      1,
    ]);
    const { read } = await withFiles([{ name: "bundle.zip", type: "application/zip", data: zip }]);
    expect(await read({ index: 0 })).toMatchObject({
      isError: true,
      error: "UNSUPPORTED_TYPE",
      attachment: { name: "bundle.zip", type: "application/zip", size: zip.byteLength },
      head: { bytes: zip.byteLength, magic: "zip", preview: expect.stringContaining("readme.txt") },
    });
  });

  it("maps reference, size and cloud-link failures to typed errors", async () => {
    const { read, call } = await withFiles([
      { name: "a.txt", type: "text/plain", data: Buffer.from("a") },
    ]);
    expect(await read({})).toMatchObject({ isError: true, error: "INVALID_ATTACHMENT_REF" });
    expect(await read({ index: 4 })).toMatchObject({ error: "NOT_FOUND" });
    expect(
      await call("mail_attachment_read", { id: "account-1:thread:att", attachment: { index: 0 } }),
    ).toMatchObject({ error: "INVALID_INPUT" });
    const big = await withFiles([{ name: "big.bin", type: "text/plain", data: Buffer.from("x") }]);
    big.provider().injectEmail({
      providerId: "att",
      attachments: [
        {
          id: "big",
          name: "big.txt",
          type: "text/plain",
          size: MAIL_ATTACHMENT_MAX_BYTES + 1,
          blobId: big.provider().injectBlob(new Uint8Array(1)),
        },
      ],
    });
    expect(await big.read({ index: 0 })).toMatchObject({
      isError: true,
      error: "ATTACHMENT_TOO_LARGE",
      size: MAIL_ATTACHMENT_MAX_BYTES + 1,
      limit: MAIL_ATTACHMENT_MAX_BYTES,
    });
    const cloud = await withFiles([], {
      wrapReader: (_id, reader): MailReader => ({
        ...reader,
        envelopes: reader.envelopes.bind(reader),
        attachment: async () => {
          throw Object.assign(new Error("https://contoso.sharepoint.com/x?token=secret"), {
            code: "NOT_DOWNLOADABLE",
            cloudLink: "contoso.sharepoint.com",
          });
        },
      }),
    });
    const result = await cloud.read({ index: 0 });
    expect(result).toMatchObject({
      isError: true,
      error: "NOT_DOWNLOADABLE",
      cloudLink: "contoso.sharepoint.com",
    });
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("fails cleanly on corrupt documents and stops slow extraction at the timeout", async () => {
    const { call, read } = await withFiles([
      { name: "notes.txt", type: "text/plain", data: Buffer.from("hello") },
    ]);
    expect(
      await call("mail_attachment_read", {
        id: "account-1:email:fixture-11",
        attachment: { name: "receipt-2400.pdf" },
      }),
    ).toMatchObject({ isError: true, error: "EXTRACTION_FAILED" });
    extraction.worker = new URL("./fixtures/slow-worker.mjs", import.meta.url);
    extraction.timeoutMs = 300;
    const started = Date.now();
    expect(await read({ index: 0 })).toMatchObject({
      isError: true,
      error: "EXTRACTION_TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("mail_read lists the index, attachmentId and name the tool accepts", async () => {
    const { call } = await onDemandHarness();
    const read = await call("mail_read", { id: "account-1:email:fixture-11", view: "message" });
    const [message] = read.messages as Array<{ attachments: Array<Record<string, unknown>> }>;
    expect(message?.attachments).toEqual([
      expect.objectContaining({
        index: 0,
        name: "receipt-2400.pdf",
        attachmentId: expect.any(String),
      }),
      expect.objectContaining({ name: "logo.png", inline: true, attachmentId: expect.any(String) }),
    ]);
    expect(message?.attachments[1]).not.toHaveProperty("index");
    const byId = await call("mail_attachment_read", {
      id: "account-1:email:fixture-11",
      attachment: { attachmentId: message?.attachments[1]?.attachmentId },
    });
    expect(byId).toMatchObject({ kind: "image", attachment: { name: "logo.png" } });
  });
});
