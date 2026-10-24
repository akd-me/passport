import { createHmac } from "node:crypto";
import type { WebhookFilter, WebhookSchedule } from "@passport/types";
import { describe, expect, it } from "vitest";
import { nextOccurrence, validateSchedule } from "./schedule.js";
import {
  matchesWebhookFilters,
  renderWebhookTemplate,
  verifyWebhookSignature,
  webhookKey,
  webhookValues,
} from "./webhook.js";

const request = {
  body: {
    action: "opened",
    number: 42,
    active: true,
    nil: null,
    labels: [{ name: "bug" }, { name: "urgent" }],
    groups: [{ users: [{ id: 1 }] }],
  },
  headers: { "x-github-event": "issues" },
  query: { source: "github" },
};
describe("webhook semantics", () => {
  it("normalizes webhook configuration without arming a recurring tick", () => {
    const input = { type: "webhook", dedupe: { coalesceKey: "{{body.number}}" } };
    const schedule = validateSchedule(input);
    expect(schedule).toEqual({
      type: "webhook",
      dedupe: { coalesceKey: "{{body.number}}", coalesceWindowSeconds: 120 },
    });
    expect(nextOccurrence(schedule, Date.now())).toBeNull();
    expect(input.dedupe).not.toHaveProperty("coalesceWindowSeconds");
  });
  it.each([
    { maxDeliveryAgeMinutes: 0 },
    { maxDeliveryAgeMinutes: 1441 },
    { dedupe: { replayKey: "constant" } },
    { dedupe: { replayKey: "{{unknown.x}}" } },
    { dedupe: { coalesceKey: "{{body.id}}", coalesceWindowSeconds: 9 } },
    { dedupe: { coalesceKey: "{{body.id}}", coalesceWindowSeconds: 3601 } },
    { dedupe: { coalesceWindowSeconds: 120 } },
    { filters: Array.from({ length: 17 }, () => ({ path: "body.x", op: "exists" })) },
    { filters: [{ path: "body.__proto__.x", op: "exists" }] },
    { filters: [{ path: "body.action", op: "in", value: "opened" }] },
    { signature: { header: "x-test", encoding: "hex", secret: "plaintext" } },
    { unexpected: true },
  ])("rejects invalid configuration %j", (fields) => {
    expect(() => validateSchedule({ type: "webhook", ...fields })).toThrow(
      expect.objectContaining({ code: "INVALID_SCHEDULE" }),
    );
  });
  it.each([
    ["body.action", "equals", "opened", true],
    ["body.number", "equals", "42", true],
    ["body.active", "in", ["true", "false"], true],
    ["body.labels[].name", "equals", "urgent", true],
    ["body.labels[].name", "notEquals", "bug", false],
    ["body.labels[].name", "notEquals", "feature", true],
    ["body.action", "startsWith", "op", true],
    ["body.nil", "exists", undefined, false],
    ["body.missing", "notEquals", "other", false],
    ["body.missing", "exists", undefined, false],
    ["query.source", "equals", "github", true],
    ["headers.X-GitHub-Event", "equals", "issues", true],
  ] as const)("filters %s %s", (path, op, value, expected) => {
    expect(
      matchesWebhookFilters(request, [
        { path, op, value: value ? structuredClone(value) : undefined } as WebhookFilter,
      ]),
    ).toBe(expected);
  });
  it("fans out over nested arrays and requires every filter to match", () => {
    expect(webhookValues(request, "body.groups[].users[].id")).toEqual([1]);
    expect(
      matchesWebhookFilters(request, [
        { path: "body.action", op: "equals", value: "opened" },
        { path: "body.labels[].name", op: "equals", value: "missing" },
      ]),
    ).toBe(false);
  });
  it.each(["hex", "base64"] as const)(
    "checks HMAC-SHA256 %s over exact raw bytes with an optional prefix",
    (encoding) => {
      const raw = Buffer.from(' {"action": "opened"}\n');
      const sig: NonNullable<WebhookSchedule["signature"]> = {
        header: "x-signature",
        encoding,
        secretRef: "ref",
        prefix: "sha256=",
      };
      const digest = createHmac("sha256", "signing-secret").update(raw).digest(encoding);
      const headers = { "x-signature": "sha256=" + digest };
      expect(verifyWebhookSignature(raw, headers, sig, "signing-secret")).toBe(true);
      expect(
        verifyWebhookSignature(Buffer.from('{"action":"opened"}'), headers, sig, "signing-secret"),
      ).toBe(false);
      expect(verifyWebhookSignature(raw, headers, sig, "wrong")).toBe(false);
      expect(verifyWebhookSignature(raw, { "x-signature": digest }, sig, "signing-secret")).toBe(
        false,
      );
      expect(
        verifyWebhookSignature(
          raw,
          { "x-signature": digest },
          { ...sig, prefix: "" },
          "signing-secret",
        ),
      ).toBe(true);
      expect(
        verifyWebhookSignature(
          raw,
          { "x-signature": "sha256=" + digest + "!" },
          sig,
          "signing-secret",
        ),
      ).toBe(false);
    },
  );
  it("frames every prompt placeholder, preserves literal dollar replacements, and hashes raw dedupe values", () => {
    const calls: string[] = [];
    const body = { body: { text: "$& {{body.x}}" }, headers: { "x-id": "1" }, query: { x: "q" } };
    const result = renderWebhookTemplate(
      "Handle {{body.text}} {{headers.x-id}} {{query.x}} {{body}} {{request}}",
      body,
      (source, value) => {
        calls.push(source);
        return "<data>" + value + "</data>";
      },
    );
    expect(calls).toHaveLength(5);
    expect(result).toContain("<data>$& {{body.x}}</data>");
    expect(webhookKey("{{headers.x-id}}", body)).toBe(webhookKey("{{headers.x-id}}", body));
    expect(webhookKey("{{body.missing}}", body)).toBeNull();
  });
});
