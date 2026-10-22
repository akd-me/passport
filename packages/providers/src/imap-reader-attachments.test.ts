import { MAIL_ATTACHMENT_MAX_BYTES } from "@passport/types";
import { describe, expect, it } from "vitest";
import { ImapMailProvider } from "./imap.js";
import type { ImapMailReader } from "./imap-reader.js";
import { decodeQuotedPrintable } from "./imap-reader-attachments.js";
import { FakeImapServer } from "./imap-reader-fake.js";
import { imapIdentity } from "./imap-reader-shared.js";
import { account } from "./test/helpers.js";

const configured = { ...account, kind: "imap" as const, settings: { host: "imap.example" } };

async function setup() {
  const server = new FakeImapServer();
  server.add("INBOX", {
    from: "Sam <sam@example.com>",
    subject: "Plan",
    messageId: "<plan@x>",
    date: "2026-01-10T09:00:00Z",
    attachment: "plan.pdf",
    inline: { name: "logo.png", cid: "logo@x" },
  });
  server.add("INBOX", {
    from: "Sam <sam@example.com>",
    subject: "Big",
    messageId: "<big@x>",
    date: "2026-01-11T09:00:00Z",
    attachment: "huge.pdf",
    attachmentSize: Math.ceil((MAIL_ATTACHMENT_MAX_BYTES * 4) / 3) + 8,
  });
  const provider = new ImapMailProvider({ imapFactory: () => server.client });
  await provider.connect(configured, { password: "secret" });
  return { server, reader: provider.reader() as ImapMailReader };
}

const plan = imapIdentity("INBOX", "7", 1);
const big = imapIdentity("INBOX", "7", 2);

describe("ImapMailReader.attachment", () => {
  it("fetches BODYSTRUCTURE, then only the named part, decoding base64", async () => {
    const { server, reader } = await setup();
    server.log.length = 0;
    const { value, cost } = await reader.attachment(plan, { index: 0 });
    expect(value).toMatchObject({ name: "plan.pdf", type: "application/pdf", inline: false });
    expect(Buffer.from(value.data).toString()).toBe("%PDF-");
    expect(value.size).toBe(5);
    expect(server.log).toEqual(["SELECT INBOX", "UID FETCH", "UID FETCH"]);
    expect(cost.imapCommands).toBe(3);
  });

  it("addresses parts by number, name, or the handles body() returns", async () => {
    const { reader } = await setup();
    const body = await reader.body(plan);
    const [pdf, logo] = body.value.attachments;
    expect(body.value.attachments.map((a) => a.name)).toEqual(["plan.pdf", "logo.png"]);
    for (const attachmentId of ["2", pdf?.id, pdf?.blobId]) {
      expect((await reader.attachment(plan, { attachmentId })).value.name).toBe("plan.pdf");
    }
    const inline = await reader.attachment(plan, { attachmentId: logo?.blobId });
    expect(inline.value.name).toBe("logo.png");
    expect((await reader.attachment(plan, { name: "LOGO.PNG" })).value.name).toBe("logo.png");
  });

  it("flags inline parts and strips the Content-ID brackets", async () => {
    const { reader } = await setup();
    const { value } = await reader.attachment(plan, { attachmentId: "3" });
    expect(value).toMatchObject({ type: "image/png", inline: true, contentId: "logo@x" });
    expect([...value.data]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // index skips inline parts: there is only one non-inline attachment.
    await expect(reader.attachment(plan, { index: 1 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses parts whose decoded size exceeds the limit before fetching them", async () => {
    const { server, reader } = await setup();
    server.log.length = 0;
    await expect(reader.attachment(big, { name: "huge.pdf" })).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
    });
    expect(server.log).toEqual(["SELECT INBOX", "UID FETCH"]);
  });

  it("reports STALE_ID after UIDVALIDITY changes and NOT_FOUND for missing messages", async () => {
    const { server, reader } = await setup();
    await expect(
      reader.attachment(imapIdentity("INBOX", "7", 99), { index: 0 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    server.resetValidity("INBOX");
    await expect(reader.attachment(plan, { index: 0 })).rejects.toMatchObject({
      code: "STALE_ID",
    });
  });

  it("has no rawGet", async () => {
    const { reader } = await setup();
    expect("rawGet" in reader).toBe(false);
  });

  it("decodes quoted-printable", () => {
    const decoded = decodeQuotedPrintable(Buffer.from("caf=C3=A9 =\r\nau lait=3D"));
    expect(Buffer.from(decoded).toString()).toBe("café au lait=");
  });
});
