import type { ActionExecutor, ActionRequest, DraftInput } from "@passport/types";
import { PolicyError } from "./errors.js";
import type { ExecutorContext } from "./executor-context.js";
import type { ActionExecutorOptions } from "./executor-shared.js";

/** Human draft saves share the executor's approval lock and leave the proposal pending. */
export interface DraftEditingExecutor extends ActionExecutor {
  editDraft(actionId: string, textBody: string): ReturnType<ActionExecutor["approve"]>;
}

export const draftOriginalKey = (actionId: string) => `policy:draft-original:${actionId}`;

/** Called only inside the executor's serial lock. Retain the first draft across saves/restarts. */
export function createDraftEditor(
  { store, bus }: ActionExecutorOptions,
  { requireAction, assertPublic }: ExecutorContext,
): DraftEditingExecutor["editDraft"] {
  return async (actionId, textBody) => {
    const original = await requireAction(actionId, ["proposed"], "ACTION_DECIDED");
    if (typeof textBody !== "string" || !textBody.trim() || textBody.length > 100_000) {
      throw new PolicyError("INVALID_EDIT", "Draft body must contain 1–100000 characters");
    }
    const draft = (original.request.params as { draft?: DraftInput }).draft;
    if (!draft) {
      throw new PolicyError("INVALID_EDIT", "This action has no editable draft");
    }
    if (await store.kv.get(`policy:undo:${actionId}`)) {
      throw new PolicyError("INVALID_EDIT", "Stored undo snapshots cannot be edited");
    }
    const request: ActionRequest = {
      ...structuredClone(original.request),
      params: {
        ...structuredClone(original.request.params),
        draft: { ...structuredClone(draft), textBody, htmlBody: null },
      } as ActionRequest["params"],
    };
    await assertPublic(request);
    const key = draftOriginalKey(actionId);
    if ((await store.kv.get(key)) === null) {
      await store.kv.set(key, JSON.stringify(original.request));
    }
    const action = await store.actions.update(actionId, { request });
    bus.emit({ type: "action.updated", action });
    return action;
  };
}
