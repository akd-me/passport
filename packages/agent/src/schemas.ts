import type { ActionCategory } from "@passport/types";
import type { JsonSchema } from "./llm/types.js";

export const CATEGORIES: ActionCategory[] = ["triage", "newsletters", "receipts", "notifications", "scheduling", "replies_known", "replies_stranger", "money", "legal", "unsubscribe", "matters", "other"];
export const string: JsonSchema = { type: "string", minLength: 1 };
export const strings: JsonSchema = { type: "array", items: string };
export const categorySchema: JsonSchema = { type: "string", enum: CATEGORIES };
export function objectSchema(properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
export const classificationSchema = objectSchema({ category: categorySchema });
export const matterSchema = objectSchema({ matterId: { type: ["string", "null"] }, title: string, kind: string, summary: string, nextStep: { type: "string" } });
export const replySchema = objectSchema({ textBody: string });
export const slotSchema = objectSchema({ start: string, end: string });
export const scheduleSchema = objectSchema({ status: { type: "string", enum: ["accepted", "tentative", "declined"] }, textBody: string, slots: { type: "array", items: slotSchema, maxItems: 3 } });
export const reviewSchema = objectSchema({ summary: string, nextStep: { type: "string" }, status: { type: "string", enum: ["active", "waiting", "done"] } });
