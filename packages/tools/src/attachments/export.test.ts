import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAIL_ATTACHMENT_MAX_BYTES } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import { onDemandHarness } from "../testing/ondemand.js";
import { exportLimits, safeFileName } from "./export.js";

const LIMIT = exportLimits.totalBytes;
afterEach(() => {
  exportLimits.totalBytes = LIMIT;
});

async function exportHarness(
  files: Array<{ name: string; data: Uint8Array; size?: number; inline?: boolean }>,
) {
  const scratchDir = await mkdtemp(join(tmpdir(), "passport-export-att-"));
  const harness = await onDemandHarness({ scratchDir, scratchSession: "s1" });
  const provider = harness.provider();
  provider.injectEmail({
    providerId: "exp",
    attachments: files.map((file, index) => ({
      id: `account-1:attachment:exp-${index}`,
      name: file.name,
      type: "application/octet-stream",
      size: file.size ?? file.data.byteLength,
      blobId: provider.injectBlob(file.data),
      disposition: file.inline ? "inline" : "attachment",
    })),
  });
  const run = () =>
    harness.call("mail_export", { ids: ["account-1:email:exp"], includeAttachments: true });
  return { ...harness, scratchDir, run };
}

describe("safeFileName", () => {
  it("keeps names inside their directory", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("..\\..\\boot.ini")).toBe("boot.ini");
    expect(safeFileName("..")).toBe("attachment");
    expect(safeFileName(".bashrc")).toBe("bashrc");
    expect(safeFileName("a\u0000b‮:c.txt")).toBe("a_b__c.txt");
    const long = safeFileName(`${"x".repeat(300)}.pdf`);
    expect(long).toHaveLength(120);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("mail_export includeAttachments", () => {
  it("writes raw bytes with safe names, skips inline parts and never escapes the directory", async () => {
    const pdf = new Uint8Array(Buffer.from("%PDF-1.4 bytes"));
    const { run, scratchDir } = await exportHarness([
      { name: "lease.pdf", data: pdf },
      { name: "../../../escape.sh", data: new Uint8Array(Buffer.from("#!/bin/sh")) },
      { name: "logo.png", data: new Uint8Array([1, 2]), inline: true },
    ]);
    const result = await run();
    const dir = join(scratchDir, "s1", "attachments");
    expect(result).toMatchObject({
      attachmentsDir: dir,
      attachments: [
        { messageId: "account-1:email:exp", name: "lease.pdf", size: pdf.byteLength },
        { name: "../../../escape.sh" },
      ],
    });
    expect(result).not.toHaveProperty("skippedAttachments");
    const written = result.attachments as Array<{ path: string }>;
    expect(written.every((file) => file.path.startsWith(`${dir}/`))).toBe(true);
    expect(await readdir(dir)).toEqual(["exp-exp-0-lease.pdf", "exp-exp-1-escape.sh"]);
    expect(await readdir(join(scratchDir, "s1"))).toEqual(
      expect.not.arrayContaining(["escape.sh"]),
    );
    expect(new Uint8Array(await readFile(written[0]?.path ?? ""))).toEqual(pdf);
    expect((await stat(written[0]?.path ?? "")).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    // Re-exporting in the same session replaces the files.
    expect(await run()).toMatchObject({ attachments: [{}, {}] });
  });

  it("skips attachments over 25 MB and stops at the per-call total", async () => {
    const one = new Uint8Array(600);
    const { run } = await exportHarness([
      { name: "huge.bin", data: new Uint8Array(1), size: MAIL_ATTACHMENT_MAX_BYTES + 1 },
      { name: "a.bin", data: one },
      { name: "b.bin", data: one },
    ]);
    exportLimits.totalBytes = 1000;
    expect(await run()).toMatchObject({
      attachments: [{ name: "a.bin", size: 600 }],
      skippedAttachments: [
        { name: "huge.bin", reason: "ATTACHMENT_TOO_LARGE" },
        { name: "b.bin", reason: "TOTAL_LIMIT" },
      ],
    });
  });

  it("leaves attachments out unless asked", async () => {
    const { call } = await exportHarness([{ name: "a.bin", data: new Uint8Array(3) }]);
    const result = await call("mail_export", { ids: ["account-1:email:exp"] });
    expect(result).not.toHaveProperty("attachments");
  });
});
