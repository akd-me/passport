import { MAIL_ATTACHMENT_MAX_BYTES } from "@passport/types";
import { describe, expect, it } from "vitest";
import { JmapMailProvider } from "./jmap.js";
import type { JmapMailReader } from "./jmap-reader.js";
import { account, fixtureFetch, jsonBody, response } from "./test/helpers.js";

const mail = "urn:ietf:params:jmap:mail";
const core = "urn:ietf:params:jmap:core";
const session = {
  apiUrl: "https://jmap.example/api",
  uploadUrl: "https://jmap.example/upload/{accountId}",
  downloadUrl: "https://jmap.example/download/{accountId}/{blobId}/{name}?type={type}",
  capabilities: { [core]: {}, [mail]: {} },
  primaryAccounts: { [mail]: "remote" },
  accounts: { remote: { name: "Alex", accountCapabilities: { [mail]: {} } } },
};
const attachments = [
  { partId: "2", blobId: "blob-pdf", name: "plan.pdf", type: "application/pdf", size: 8 },
  {
    partId: "3",
    blobId: "blob-png",
    name: "logo.png",
    type: "image/png",
    size: 4,
    disposition: "inline",
    cid: "<logo@x>",
  },
  {
    partId: "4",
    blobId: "blob-big",
    name: "huge.zip",
    type: "application/zip",
    size: MAIL_ATTACHMENT_MAX_BYTES + 1,
  },
];
const blobs: Record<string, Uint8Array> = {
  "blob-pdf": new Uint8Array(Buffer.from("%PDF-1.4")),
  "blob-png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

async function setup() {
  const requests: Array<{ url: URL; calls?: unknown[] }> = [];
  const fetch = fixtureFetch((url, init) => {
    if (url.pathname === "/.well-known/jmap") {
      return response(session);
    }
    if (url.pathname.startsWith("/download/")) {
      requests.push({ url });
      const blob = blobs[decodeURIComponent(url.pathname.split("/")[3] ?? "")];
      return blob ? new Response(blob) : response({}, 404);
    }
    const calls = jsonBody(init).methodCalls as Array<[string, Record<string, unknown>, string]>;
    requests.push({ url, calls });
    return response({
      methodResponses: calls.map(([method, args, tag]) => {
        const ids = args.ids as string[];
        const list = ids.includes("m1") ? [{ id: "m1", attachments }] : [];
        return [method, { list, notFound: list.length ? [] : ids }, tag];
      }),
    });
  });
  const provider = new JmapMailProvider({ fetch });
  await provider.connect(
    { ...account, kind: "jmap", settings: { sessionUrl: "https://jmap.example/.well-known/jmap" } },
    { token: "token" },
  );
  return { requests, reader: provider.reader() as JmapMailReader };
}

describe("JmapMailReader.attachment", () => {
  it("reads the manifest with Email/get, then downloads the blob via downloadUrl", async () => {
    const { requests, reader } = await setup();
    const { value, cost } = await reader.attachment("m1", { index: 0 });
    expect(value).toMatchObject({
      name: "plan.pdf",
      type: "application/pdf",
      inline: false,
      size: 8,
    });
    expect(Buffer.from(value.data).toString()).toBe("%PDF-1.4");
    expect(cost.graphRequests).toBe(2);
    expect(requests[0]?.calls).toEqual([
      [
        "Email/get",
        expect.objectContaining({
          ids: ["m1"],
          properties: ["id", "attachments"],
          bodyProperties: ["partId", "blobId", "size", "name", "type", "disposition", "cid"],
        }),
        "0",
      ],
    ]);
    expect(requests[1]?.url.href).toBe(
      "https://jmap.example/download/remote/blob-pdf/plan.pdf?type=application%2Fpdf",
    );
  });

  it("addresses attachments by blobId, partId, Attachment.id or name, inline included", async () => {
    const { reader } = await setup();
    const [pdf] = (await reader.body("m1")).value.attachments;
    for (const attachmentId of ["blob-pdf", "2", pdf?.id, pdf?.blobId]) {
      expect((await reader.attachment("m1", { attachmentId })).value.name).toBe("plan.pdf");
    }
    const { value } = await reader.attachment("m1", { name: "logo.png" });
    expect(value).toMatchObject({ type: "image/png", inline: true, contentId: "logo@x" });
  });

  it("refuses oversized blobs before downloading and maps missing ones to NOT_FOUND", async () => {
    const { requests, reader } = await setup();
    await expect(reader.attachment("m1", { name: "huge.zip" })).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
    });
    expect(requests.filter((r) => r.url.pathname.startsWith("/download/"))).toHaveLength(0);
    await expect(reader.attachment("gone", { index: 0 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("has no rawGet", async () => {
    const { reader } = await setup();
    expect("rawGet" in reader).toBe(false);
  });
});
