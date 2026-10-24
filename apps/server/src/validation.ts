import type { ActionCategory, ActionRequest, GlobalPolicyConfig } from "@passport/types";
import { TRUST_LEVELS } from "@passport/types";
import { ApiError } from "./errors.js";
export const categories: ActionCategory[] = [
  "triage",
  "newsletters",
  "receipts",
  "notifications",
  "scheduling",
  "replies_known",
  "replies_stranger",
  "money",
  "legal",
  "unsubscribe",
  "matters",
  "other",
  "profile_update",
];
export const statuses = [
  "proposed",
  "approved",
  "rejected",
  "held",
  "executing",
  "executed",
  "undone",
  "failed",
  "expired",
] as const;
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_BODY", "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}
export function string(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new ApiError("INVALID_FIELD", `${name} must be a string`);
  }
  return value;
}
export function member<const T extends string>(
  value: unknown,
  choices: readonly T[],
  name: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new ApiError("INVALID_FIELD", `Invalid ${name}`);
  }
  return value as T;
}
export function integer(value: unknown, name: string, min = 0, max = 10000): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ApiError("INVALID_FIELD", `${name} must be an integer ${min}–${max}`);
  }
  return value;
}
export function policyPatch(value: unknown): Partial<GlobalPolicyConfig> {
  const body = object(value),
    patch: Partial<GlobalPolicyConfig> = {};
  for (const key of Object.keys(body)) {
    if (
      ![
        "globalMode",
        "outboxHoldMinutes",
        "decayAfterDays",
        "alwaysAsk",
        "externalAgentCeiling",
      ].includes(key)
    ) {
      throw new ApiError("INVALID_FIELD", `Unknown policy setting ${key}`);
    }
  }
  if (body.globalMode !== undefined) {
    patch.globalMode = member(body.globalMode, TRUST_LEVELS, "mode");
  }
  if (body.externalAgentCeiling !== undefined) {
    patch.externalAgentCeiling = member(
      body.externalAgentCeiling,
      TRUST_LEVELS,
      "external agent ceiling",
    );
  }
  if (body.outboxHoldMinutes !== undefined) {
    patch.outboxHoldMinutes = integer(body.outboxHoldMinutes, "outboxHoldMinutes", 0, 1440);
  }
  if (body.decayAfterDays !== undefined) {
    patch.decayAfterDays = integer(body.decayAfterDays, "decayAfterDays", 1, 3650);
  }
  if (body.alwaysAsk !== undefined) {
    if (!Array.isArray(body.alwaysAsk)) {
      throw new ApiError("INVALID_FIELD", "alwaysAsk must be an array");
    }
    patch.alwaysAsk = [...new Set(body.alwaysAsk.map((c) => member(c, categories, "category")))];
  }
  return patch;
}
export function editedRequest(value: unknown, original: ActionRequest): ActionRequest {
  const body = object(value);
  // Only draft content is editable through the human approval surface.
  if (body.type !== original.type || body.accountId !== original.accountId) {
    throw new ApiError("INVALID_EDIT", "Keep the original action type and account");
  }
  const params = object(body.params),
    old = original.params as { draft?: unknown };
  if (!old.draft) {
    throw new ApiError("INVALID_EDIT", "This action has no editable draft");
  }
  const draft = object(params.draft),
    oldDraft = object(old.draft);
  const textBody = string(draft.textBody, "draft.textBody");
  if (!textBody.trim() || textBody.length > 100000) {
    throw new ApiError("INVALID_EDIT", "Draft body must contain 1–100000 characters");
  }
  return {
    ...original,
    params: {
      ...original.params,
      draft: { ...oldDraft, textBody },
    } as ActionRequest["params"],
  };
}
