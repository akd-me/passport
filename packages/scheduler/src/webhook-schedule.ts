import type { WebhookFilter, WebhookSchedule } from "@passport/types";
import { SchedulerError } from "./schedule.js";

function invalid(message: string): never {
  throw new SchedulerError("INVALID_SCHEDULE", message);
}
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  ) {
    return invalid("Invalid webhook configuration fields");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    return invalid("Expected nonempty webhook configuration text");
  }
  return value;
}
const scalar = (value: unknown) =>
  value === null ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= 2000);

/** Reject prototype access and unbounded paths; [] explicitly fans out over arrays. */
export function webhookPath(path: string): boolean {
  return (
    /^(body|headers|query)(?:\.[a-zA-Z0-9_-]+(?:\[\])?)+$/.test(path) &&
    path.length <= 512 &&
    !path
      .split(".")
      .some((part) => ["__proto__", "constructor", "prototype"].includes(part.replace("[]", "")))
  );
}
export function validateWebhookSchedule(value: unknown): WebhookSchedule {
  const input = record(value, ["type", "signature", "maxDeliveryAgeMinutes", "dedupe", "filters"]);
  const result: WebhookSchedule = { type: "webhook" };
  if (input.signature !== undefined) {
    const sig = record(input.signature, ["header", "encoding", "prefix", "secretRef"]);
    const header = text(sig.header, 200).toLowerCase();
    if (
      !/^[a-z0-9!#$%&'*+.^_~|-]+$/.test(header) ||
      !["hex", "base64"].includes(sig.encoding as string) ||
      (sig.prefix !== undefined && (typeof sig.prefix !== "string" || sig.prefix.length > 200))
    ) {
      return invalid("Invalid signature header, encoding or prefix");
    }
    result.signature = {
      header,
      encoding: sig.encoding as "hex" | "base64",
      secretRef: text(sig.secretRef),
      ...(sig.prefix === undefined ? {} : { prefix: sig.prefix as string }),
    };
  }
  if (input.maxDeliveryAgeMinutes !== undefined) {
    const age = input.maxDeliveryAgeMinutes;
    if (typeof age !== "number" || !Number.isInteger(age) || age < 1 || age > 1440) {
      return invalid("maxDeliveryAgeMinutes must be 1–1440");
    }
    result.maxDeliveryAgeMinutes = age;
  }
  if (input.dedupe !== undefined) {
    const d = record(input.dedupe, ["replayKey", "coalesceKey", "coalesceWindowSeconds"]);
    const window = d.coalesceWindowSeconds;
    if (
      window !== undefined &&
      (typeof window !== "number" || !Number.isInteger(window) || window < 10 || window > 3600)
    ) {
      return invalid("coalesceWindowSeconds must be 10–3600");
    }
    if (window !== undefined && d.coalesceKey === undefined) {
      return invalid("A coalesce window requires coalesceKey");
    }
    result.dedupe = {
      ...(d.replayKey === undefined ? {} : { replayKey: text(d.replayKey, 2000) }),
      ...(d.coalesceKey === undefined
        ? {}
        : {
            coalesceKey: text(d.coalesceKey, 2000),
            coalesceWindowSeconds: (window as number | undefined) ?? 120,
          }),
    };
    for (const template of [result.dedupe.replayKey, result.dedupe.coalesceKey]) {
      if (template === undefined) {
        continue;
      }
      const pattern = /\{\{\s*([^{}]+?)\s*\}\}/g;
      const matches = [...template.matchAll(pattern)];
      if (
        !matches.length ||
        matches.some(
          (match) => !["body", "request"].includes(match[1]!) && !webhookPath(match[1]!),
        ) ||
        /[{}]/.test(template.replace(pattern, ""))
      ) {
        return invalid("Dedupe keys must contain valid request placeholders");
      }
    }
  }
  if (input.filters !== undefined) {
    if (!Array.isArray(input.filters) || input.filters.length > 16) {
      return invalid("At most 16 webhook filters are allowed");
    }
    result.filters = input.filters.map((value) => {
      const f = record(value, ["path", "op", "value"]);
      if (
        !webhookPath(text(f.path)) ||
        !["equals", "notEquals", "startsWith", "in", "exists"].includes(f.op as string)
      ) {
        return invalid("Invalid webhook filter path or operator");
      }
      if (
        f.op === "in"
          ? !Array.isArray(f.value) ||
            !f.value.length ||
            f.value.length > 100 ||
            !f.value.every(scalar)
          : f.op === "exists"
            ? f.value !== undefined && typeof f.value !== "boolean"
            : f.op === "startsWith"
              ? typeof f.value !== "string" || f.value.length > 2000
              : !scalar(f.value)
      ) {
        return invalid("Invalid webhook filter value");
      }
      return structuredClone(f) as unknown as WebhookFilter;
    });
  }
  return result;
}
