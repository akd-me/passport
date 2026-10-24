import type { DraftInput } from "@passport/types";
import type { RunContext } from "./context.js";
import { isObject } from "./llm/json.js";
import { formatDraft } from "./profile.js";

/** Drafts get the person's signature and the assistant sign-off before they reach a tool. */
export function prepareToolInput(ctx: RunContext, name: string, input: unknown): unknown {
  if (!isObject(input)) {
    return input;
  }
  if (ctx.arrival && name === "create_matter" && isObject(input.matter)) {
    return { ...input, matter: { ...input.matter, personIds: ctx.arrival.personIds } };
  }
  if (ctx.arrival && name === "attach_to_matter") {
    return { ...input, personIds: ctx.arrival.personIds };
  }
  if (isObject(input.draft)) {
    const draft = input.draft as unknown as DraftInput;
    return {
      ...input,
      draft: { ...draft, textBody: formatDraft(draft.textBody, ctx.profile, ctx.drafts) },
    };
  }
  if (name === "reply_draft" && typeof input.textBody === "string") {
    return { ...input, textBody: formatDraft(input.textBody, ctx.profile, ctx.drafts) };
  }
  return input;
}
