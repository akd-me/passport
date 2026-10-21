import type { ActionParams, ActionRequest, DomainEvent, Email, Id } from "@passport/types";
import { isObject } from "./llm/json.js";

export type AgentEmailPatch = Partial<Pick<Email, "category" | "personIds">>;
/** Executor extension: apply this patch to the action's emails in the same logged transaction. */
export type AgentMatterAttachParams = ActionParams["matter_attach"] & {
  emailPatch: AgentEmailPatch;
};
export type AgentMatterCreateParams = ActionParams["matter_create"] & {
  emailPatch: AgentEmailPatch;
};

/** Read the package-local metadata extension without changing the frozen shared ActionParams. */
export function getAgentEmailPatch(request: ActionRequest): AgentEmailPatch | null {
  if (request.type !== "matter_create" && request.type !== "matter_attach") return null;
  const params: unknown = request.params;
  if (!isObject(params) || !isObject(params.emailPatch)) return null;
  const patch = params.emailPatch;
  const result: AgentEmailPatch = {};
  if (
    patch.category === null ||
    (typeof patch.category === "string" &&
      [
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
      ].includes(patch.category))
  )
    result.category = patch.category as Email["category"];
  if (Array.isArray(patch.personIds) && patch.personIds.every((id) => typeof id === "string"))
    result.personIds = patch.personIds;
  return result;
}

export interface AgentDecision {
  emailId: Id;
  matterId?: Id;
  summary: string;
}

export interface DailyDigest {
  date: string;
  markdown: string;
}

/** Existing event discriminant, with optional agent-owned payloads for server/UI consumers. */
export type AgentFinishedEvent = Extract<DomainEvent, { type: "agent.run.finished" }> & {
  decisions?: AgentDecision[];
  digest?: DailyDigest;
};
