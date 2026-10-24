import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookFilter, WebhookSchedule } from "@passport/types";
import { webhookPath } from "./webhook-schedule.js";

export interface WebhookRequest {
  bodyText?: string;
  method?: string;
  /** Redacted route name, never the capability token. */
  path?: string;
  body: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
}
/** Own properties only; absent values differ from JSON null. */
export function webhookValues(request: WebhookRequest, path: string): unknown[] {
  if (path === "body" && request.bodyText !== undefined) {
    return [request.bodyText];
  }
  if (path === "request") {
    return [
      [
        (request.method ?? "POST") + " " + (request.path ?? "/api/hooks/[redacted]"),
        ...Object.entries(request.headers).map(([key, value]) => key + ": " + value),
        "query: " + new URLSearchParams(request.query).toString(),
        "",
        request.bodyText ?? webhookText(request.body),
      ].join("\n"),
    ];
  }
  if (["body", "headers", "query"].includes(path)) {
    return [request[path as keyof WebhookRequest]];
  }
  if (!webhookPath(path)) {
    return [];
  }
  if (path.startsWith("headers.") || path.startsWith("query.")) {
    const [root, ...parts] = path.split(".");
    const key = root === "headers" ? parts.join(".").toLowerCase() : parts.join(".");
    const values = request[root as "headers" | "query"];
    return Object.hasOwn(values, key) ? [values[key]] : [];
  }
  let values: unknown[] = [request];
  for (const segment of path.split(".")) {
    const fan = segment.endsWith("[]");
    const key = fan ? segment.slice(0, -2) : segment;
    values = values.flatMap((value) => {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) {
        return [];
      }
      const next = (value as Record<string, unknown>)[key];
      return fan ? (Array.isArray(next) ? next : []) : [next];
    });
  }
  return values;
}

export function matchesWebhookFilters(
  request: WebhookRequest,
  filters: WebhookFilter[] = [],
): boolean {
  return filters.every((filter) => {
    const values = webhookValues(request, filter.path);
    const texts = values
      .filter((value) => ["string", "number", "boolean"].includes(typeof value))
      .map(String);
    const wanted = String(filter.value);
    switch (filter.op) {
      case "exists":
        return (
          values.some((value) => value !== undefined && value !== null) === (filter.value ?? true)
        );
      case "equals":
        return texts.includes(wanted);
      case "notEquals":
        return (texts.length > 0 || filter.path.includes("[]")) && !texts.includes(wanted);
      case "startsWith":
        return texts.some((value) => value.startsWith(wanted));
      case "in":
        return texts.some((value) => (filter.value as unknown[]).map(String).includes(value));
    }
  });
}
export const webhookText = (value: unknown): string =>
  value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value);

/** Replacement callback keeps payload '$&' literal. A frame is supplied by the host for every value. */
export function renderWebhookTemplate(
  template: string,
  request: WebhookRequest,
  frame: (source: string, text: string) => string,
): string {
  let remaining = 256 * 1024;
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (literal, path: string) => {
    if (!["body", "request"].includes(path) && !webhookPath(path)) {
      return literal;
    }
    const values = webhookValues(request, path);
    const text = webhookText(values.length > 1 ? values : values[0]);
    const bounded = text.slice(0, Math.max(0, Math.min(64000, remaining)));
    remaining -= bounded.length;
    return frame("webhook:" + path, bounded);
  });
}
/** Replay/coalesce keys use the raw data, never random prompt frame suffixes. */
export function webhookKey(template: string | undefined, request: WebhookRequest): string | null {
  if (!template) {
    return null;
  }
  let missing = false;
  const value = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_literal, path: string) => {
    const values = webhookValues(request, path);
    if (!values.length || values[0] === null || values[0] === "") {
      missing = true;
    }
    return webhookText(values.length > 1 ? values : values[0]);
  });
  return missing || !value.trim() ? null : createHash("sha256").update(value).digest("hex");
}
export function verifyWebhookSignature(
  raw: Uint8Array,
  headers: Record<string, string>,
  signature: NonNullable<WebhookSchedule["signature"]>,
  secret: string,
): boolean {
  const header = headers[signature.header.toLowerCase()];
  const prefix = signature.prefix ?? "";
  if (!header?.startsWith(prefix)) {
    return false;
  }
  const encoded = header.slice(prefix.length);
  // Buffer decoding is permissive; reject malformed and noncanonical input first.
  if (
    signature.encoding === "hex"
      ? !/^[a-fA-F0-9]{64}$/.test(encoded)
      : !/^[A-Za-z0-9+/]{43}=$/.test(encoded)
  ) {
    return false;
  }
  const supplied = Buffer.from(encoded, signature.encoding);
  const expected = createHmac("sha256", secret).update(raw).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
