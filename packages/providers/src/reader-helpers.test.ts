import { MAIL_ATTACHMENT_MAX_BYTES, RAW_GET_MAX_BYTES } from "@passport/types";
import { describe, expect, it } from "vitest";
import { cloudLinkHost, pickAttachment, readLimited } from "./reader-attachments.js";
import { checkRawGet, clipJson, rawGetBody } from "./reader-raw-get.js";

const entry = (name: string, inline = false) => ({
  name,
  type: "application/pdf",
  size: 1,
  inline,
  keys: [name],
});

describe("attachment helpers", () => {
  it("rejects negative or fractional indexes", () => {
    for (const index of [-1, 0.5]) {
      expect(() => pickAttachment([entry("a")], { index })).toThrow(
        expect.objectContaining({ code: "INVALID_ATTACHMENT_REF" }),
      );
    }
    expect(pickAttachment([entry("logo", true), entry("a")], { index: 0 }).name).toBe("a");
  });

  it("keeps only the host of cloud links", () => {
    expect(cloudLinkHost("https://contoso-my.sharepoint.com/personal/a/b.docx?x=1")).toBe(
      "contoso-my.sharepoint.com",
    );
    expect(cloudLinkHost("javascript:alert(1)")).toBeNull();
    expect(cloudLinkHost("not a url")).toBeNull();
    expect(cloudLinkHost(undefined)).toBeNull();
  });

  it("stops reading a download past the limit", async () => {
    const declared = new Response("x", {
      headers: { "content-length": String(MAIL_ATTACHMENT_MAX_BYTES + 1) },
    });
    await expect(readLimited(declared)).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await expect(readLimited(new Response(stream))).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
    });
    expect(sent).toBeLessThanOrEqual(MAIL_ATTACHMENT_MAX_BYTES + 2 * chunk.byteLength);
    expect([...(await readLimited(new Response(new Uint8Array([1, 2]))))]).toEqual([1, 2]);
  });
});

describe("rawGet helpers", () => {
  it("re-checks the allowlist per provider kind", () => {
    expect(checkRawGet("graph", "/me/messages", {})).toBe("me/messages");
    expect(() => checkRawGet("imap", "me/messages", {})).toThrow(
      expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
    );
    expect(() => checkRawGet("gmail", "mailto:users/me/messages", {})).toThrow(
      expect.objectContaining({ code: "PATH_NOT_ALLOWED" }),
    );
  });

  it("clips arrays, returns undefined when that cannot help, and falls back to text", async () => {
    expect(clipJson([1, 2, 3, 4], 5)).toEqual([1, 2]);
    expect(clipJson({ big: "x".repeat(100) }, 10)).toBeUndefined();
    const huge = JSON.stringify({ note: "y".repeat(RAW_GET_MAX_BYTES * 2) });
    const result = await rawGetBody(
      new Response(huge, { headers: { "content-type": "application/json" } }),
    );
    expect(result.truncated).toBe(true);
    expect(typeof result.body).toBe("string");
    expect(Buffer.byteLength(result.body as string)).toBe(RAW_GET_MAX_BYTES);
    expect(await rawGetBody(new Response("plain", { status: 200 }))).toEqual({
      status: 200,
      body: "plain",
    });
  });
});
