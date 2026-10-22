/** MIME source and BODYSTRUCTURE builders for `imap-reader-fake.ts`. Test-only. */
import type { FakeMessageInput } from "./imap-reader-fake.js";

export function address(value: string): { name?: string; address: string } {
  const match = /^(.*)<([^>]+)>$/.exec(value.trim());
  return match?.[1]?.trim()
    ? { name: match[1].trim(), address: match[2] as string }
    : { address: (match?.[2] ?? value).trim() };
}

export function mime(m: FakeMessageInput): Buffer {
  const head = [
    `From: ${m.from}`,
    `To: ${m.to ?? "Alex <alex@example.com>"}`,
    `Subject: ${m.subject}`,
    `Message-ID: ${m.messageId}`,
    `Date: ${new Date(m.date).toUTCString()}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
    ...(m.listId ? [`List-Id: ${m.listId}`] : []),
    "MIME-Version: 1.0",
  ];
  const text = m.body ?? "Hello";
  if (!m.attachment && !m.inline) {
    return Buffer.from(
      [...head, "Content-Type: text/plain; charset=utf-8", "", text, ""].join("\r\n"),
    );
  }
  const parts = ["--b1", "Content-Type: text/plain; charset=utf-8", "", text];
  if (m.attachment) {
    parts.push(
      "--b1",
      `Content-Type: application/pdf; name="${m.attachment}"`,
      `Content-Disposition: attachment; filename="${m.attachment}"`,
      "Content-Transfer-Encoding: base64",
      "",
      PDF_BASE64,
    );
  }
  if (m.inline) {
    parts.push(
      "--b1",
      `Content-Type: image/png; name="${m.inline.name}"`,
      `Content-Disposition: inline; filename="${m.inline.name}"`,
      `Content-ID: <${m.inline.cid}>`,
      "Content-Transfer-Encoding: base64",
      "",
      PNG_BASE64,
    );
  }
  return Buffer.from(
    [...head, 'Content-Type: multipart/mixed; boundary="b1"', "", ...parts, "--b1--", ""].join(
      "\r\n",
    ),
  );
}

/** `%PDF-` and a PNG signature, base64 as they appear in the fake MIME. */
const PDF_BASE64 = "JVBERi0=";
const PNG_BASE64 = "iVBORw==";

/** BODYSTRUCTURE leaves of a fake message and the raw (encoded) bytes of each part. */
export function structure(m: Omit<FakeMessageInput, "flags">) {
  const nodes: Array<Record<string, unknown> & { part: string; raw: string }> = [
    { part: "1", type: "text/plain", size: 5, raw: m.body ?? "Hello" },
  ];
  if (m.attachment) {
    nodes.push({
      part: "2",
      type: "application/pdf",
      disposition: "attachment",
      dispositionParameters: { filename: m.attachment },
      encoding: "base64",
      size: m.attachmentSize ?? 5,
      raw: PDF_BASE64,
    });
  }
  if (m.inline) {
    nodes.push({
      part: String(nodes.length + 1),
      type: "image/png",
      disposition: "inline",
      dispositionParameters: { filename: m.inline.name },
      id: `<${m.inline.cid}>`,
      encoding: "base64",
      size: PNG_BASE64.length,
      raw: PNG_BASE64,
    });
  }
  return nodes;
}
