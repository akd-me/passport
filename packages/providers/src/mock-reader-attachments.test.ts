import { MAIL_ATTACHMENT_MAX_BYTES } from "@passport/types";
import { describe, expect, it } from "vitest";
import { MockMailProvider } from "./mock-mail.js";
import { account } from "./test/helpers.js";

async function connected() {
  const provider = new MockMailProvider();
  await provider.connect(account, {});
  return { provider, reader: provider.reader() };
}

describe("MockMailReader.attachment", () => {
  it("serves the fixture-11 receipt PDF by index, priced like attachments.get", async () => {
    const { reader } = await connected();
    const { value, cost } = await reader.attachment("fixture-11", { index: 0 });
    expect(value).toMatchObject({
      name: "receipt-2400.pdf",
      type: "application/pdf",
      inline: false,
    });
    expect(Buffer.from(value.data).subarray(0, 5).toString()).toBe("%PDF-");
    expect(value.size).toBe(value.data.byteLength);
    expect(cost).toEqual({ gmailUnits: 20 });
    expect(reader.costLog.at(-1)).toMatchObject({ method: "attachment", gmailUnits: 20 });
  });

  it("serves the inline logo with its Content-ID, by name or body() handle", async () => {
    const { reader } = await connected();
    const body = await reader.body("fixture-11");
    expect(body.value.attachments.map((a) => [a.name, a.disposition])).toEqual([
      ["receipt-2400.pdf", "attachment"],
      ["logo.png", "inline"],
    ]);
    const logo = body.value.attachments[1];
    for (const ref of [
      { name: "logo.png" },
      { attachmentId: logo?.id },
      { attachmentId: logo?.blobId },
    ]) {
      const { value } = await reader.attachment("fixture-11", ref);
      expect(value).toMatchObject({
        type: "image/png",
        inline: true,
        contentId: "logo@shop.example",
      });
      expect([...value.data.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    }
    expect((await reader.attachment("fixture-36", { index: 0 })).value.type).toBe("text/calendar");
  });

  it("enforces the size limit and reports missing attachments", async () => {
    const { provider, reader } = await connected();
    const blobId = provider.injectBlob(new Uint8Array([1, 2, 3]), "application/zip");
    provider.injectEmail({
      providerId: "big",
      attachments: [
        {
          id: "a",
          name: "huge.zip",
          type: "application/zip",
          size: MAIL_ATTACHMENT_MAX_BYTES + 1,
          blobId,
        },
      ],
    });
    await expect(reader.attachment("big", { index: 0 })).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
    });
    expect(reader.costLog).toHaveLength(0);
    await expect(reader.attachment("fixture-11", { index: 5 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(reader.attachment("missing", { index: 0 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(reader.attachment("fixture-11", {})).rejects.toMatchObject({
      code: "INVALID_ATTACHMENT_REF",
    });
  });

  it("getBlob serves the new fixture files too", async () => {
    const { provider } = await connected();
    const blob = await provider.getBlob("mock-file:fixture-11:receipt-2400.pdf");
    expect(blob.type).toBe("application/pdf");
    await expect(provider.getBlob("mock-file:fixture-12:receipt-2400.pdf")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
