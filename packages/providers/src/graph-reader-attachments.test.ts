import { MAIL_ATTACHMENT_MAX_BYTES, RAW_GET_MAX_BYTES } from "@passport/types";
import { describe, expect, it } from "vitest";
import { encodeCursor } from "./errors.js";
import { NotDownloadableError } from "./reader-attachments.js";
import { FakeGraph } from "./test/graph-reader-fake.js";
import { account } from "./test/helpers.js";

const FILE = "#microsoft.graph.fileAttachment";
const PDF = new Uint8Array(Buffer.from("%PDF-1.4"));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function mailboxWithAttachments() {
  const graph = new FakeGraph();
  graph.routes.push((url) => {
    const path = url.pathname.replace(/^\/v1\.0/, "");
    switch (path) {
      case "/me/messages/g1/attachments":
        return {
          status: 200,
          body: {
            value: [
              {
                "@odata.type": FILE,
                id: "a1",
                name: "plan.pdf",
                contentType: "application/pdf",
                size: 8,
                isInline: false,
              },
              {
                "@odata.type": FILE,
                id: "a2",
                name: "logo.png",
                contentType: "image/png",
                size: 4,
                isInline: true,
              },
              {
                "@odata.type": "#microsoft.graph.referenceAttachment",
                id: "a3",
                name: "Budget.xlsx",
                contentType: null,
                size: 0,
                isInline: false,
              },
              {
                "@odata.type": FILE,
                id: "a4",
                name: "huge.zip",
                contentType: "application/zip",
                size: MAIL_ATTACHMENT_MAX_BYTES + 1,
                isInline: false,
              },
            ],
          },
        };
      case "/me/messages/g1/attachments/a1/$value":
        return { status: 200, body: PDF, headers: { "content-type": "application/pdf" } };
      case "/me/messages/g1/attachments/a2/$value":
        return { status: 200, body: PNG, headers: { "content-type": "image/png" } };
      case "/me/messages/g1/attachments/a3":
        return {
          status: 200,
          body: {
            id: "a3",
            sourceUrl: "https://contoso.sharepoint.com/sites/x/Budget.xlsx?token=s3cret",
          },
        };
      default:
        return undefined;
    }
  });
  return graph;
}

describe("GraphMailReader.attachment", () => {
  it("lists the manifest, then downloads $value; the manifest is cached per message", async () => {
    const graph = mailboxWithAttachments();
    const reader = await graph.connect();
    const first = await reader.attachment("g1", { index: 0 });
    expect(first.value).toMatchObject({
      name: "plan.pdf",
      type: "application/pdf",
      inline: false,
      size: 8,
    });
    expect(Buffer.from(first.value.data).toString()).toBe("%PDF-1.4");
    expect(first.cost.graphRequests).toBe(2);
    const manifest = graph.gets("/me/messages/g1/attachments")[0];
    expect(manifest?.url.searchParams.get("$select")).toBe("id,name,contentType,size,isInline");
    expect(manifest?.headers.get("Prefer")).toBe('IdType="ImmutableId"');
    const handles = [
      "a1",
      `${account.id}:attachment:${encodeURIComponent("g1:a1")}`,
      `graph:${encodeCursor(["g1", "a1"])}`,
    ];
    for (const attachmentId of handles) {
      const again = await reader.attachment("g1", { attachmentId });
      expect(again.value.name).toBe("plan.pdf");
      expect(again.cost.graphRequests).toBe(1);
    }
    expect(graph.gets("/me/messages/g1/attachments")).toHaveLength(1);
    expect(graph.gets("/a1/$value")).toHaveLength(4);
  });

  it("returns inline images flagged inline", async () => {
    const reader = await mailboxWithAttachments().connect();
    const { value } = await reader.attachment("g1", { name: "logo.png" });
    expect(value).toMatchObject({ type: "image/png", inline: true });
    expect([...value.data]).toEqual([...PNG]);
    // Graph's manifest has no contentId.
    expect(value).not.toHaveProperty("contentId");
  });

  it("throws NOT_DOWNLOADABLE with only the cloud link host for reference attachments", async () => {
    const graph = mailboxWithAttachments();
    const reader = await graph.connect();
    const error = await reader.attachment("g1", { index: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotDownloadableError);
    expect(error).toMatchObject({
      code: "NOT_DOWNLOADABLE",
      cloudLink: "contoso.sharepoint.com",
      detail: { cloudLink: "contoso.sharepoint.com" },
    });
    expect(String((error as Error).message)).not.toContain("s3cret");
    expect(graph.gets("/$value")).toHaveLength(0);
  });

  it("refuses attachments over the limit before the download", async () => {
    const graph = mailboxWithAttachments();
    const reader = await graph.connect();
    await expect(reader.attachment("g1", { name: "huge.zip" })).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
    });
    expect(graph.gets("/$value")).toHaveLength(0);
  });

  it("maps a missing message or attachment to NOT_FOUND", async () => {
    const reader = await mailboxWithAttachments().connect();
    await expect(reader.attachment("missing", { index: 0 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(reader.attachment("g1", { name: "nope.txt" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("GraphMailReader.rawGet", () => {
  it("GETs allowlisted paths with the query, for one request", async () => {
    const graph = new FakeGraph();
    const reader = await graph.connect();
    const result = await reader.rawGet("me/mailFolders", { $top: "5", $select: "id,displayName" });
    expect(result.value.status).toBe(200);
    expect((result.value.body as { value: unknown[] }).value).toHaveLength(5);
    expect(result.cost.graphRequests).toBe(1);
    const request = graph.gets("/me/mailFolders")[0];
    expect(request?.method).toBe("GET");
    expect(request?.url.searchParams.get("$top")).toBe("5");
    expect(request?.url.searchParams.get("$select")).toBe("id,displayName");
    expect(request?.headers.get("Prefer")).toBe('IdType="ImmutableId"');
    expect(reader.costLog.at(-1)).toMatchObject({ method: "rawGet", graphRequests: 1 });
  });

  it("denies other paths and absolute URLs without a request", async () => {
    const graph = new FakeGraph();
    const reader = await graph.connect();
    for (const path of [
      "me/sendMail",
      "users/someone/messages",
      "$batch",
      "me/messages/$batch",
      "https://graph.microsoft.com/v1.0/me/messages",
      "users/me/messages",
    ]) {
      await expect(reader.rawGet(path, {})).rejects.toMatchObject({ code: "PATH_NOT_ALLOWED" });
    }
    expect(graph.seen).toHaveLength(0);
  });

  it("clips large responses to 256 KiB", async () => {
    const graph = new FakeGraph();
    const value = Array.from({ length: 4_000 }, (_, i) => ({
      id: `c${i}`,
      displayName: `Contact number ${i} with a long padded display name`,
    }));
    graph.routes.push((url) =>
      url.pathname.endsWith("/me/contacts") ? { status: 200, body: { value } } : undefined,
    );
    const reader = await graph.connect();
    const result = await reader.rawGet("me/contacts", {});
    const body = result.value.body as { value: unknown[] };
    expect(result.value.truncated).toBe(true);
    expect(body.value.length).toBeLessThan(4_000);
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(RAW_GET_MAX_BYTES);
  });
});
