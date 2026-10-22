import type { ActionParams, ActionRequest, Email, MailRef, Matter, Store } from "@passport/types";
import {
  KNOWLEDGE_FIELDS,
  MATTER_REFS_MAX,
  MATTER_WATCH_MAX_LENGTH,
  mailRefOf,
  mergeMailRefs,
  NOTES_MAX_LENGTH,
} from "@passport/types";
import { PolicyError } from "./errors.js";

/**
 * Knowledge fields (research report 03 §4.3): `Person.notes`, `Matter.notes`, `Matter.refs` and
 * `Matter.watch`. They are agent-owned markdown and references, never policy state.
 */
type Knowledge = Pick<Matter, "notes" | "refs" | "watch">;

const invalid = (message: string) => new PolicyError("INVALID_PARAMS", message);

function assertRefs(refs: unknown): void {
  if (!Array.isArray(refs) || refs.length > MATTER_REFS_MAX) {
    throw invalid(`Matter refs must be an array of at most ${MATTER_REFS_MAX} references`);
  }
  for (const ref of refs as Partial<MailRef>[]) {
    const valid =
      ref !== null &&
      typeof ref === "object" &&
      typeof ref.account === "string" &&
      ref.account.length > 0 &&
      typeof ref.providerId === "string" &&
      ref.providerId.length > 0 &&
      typeof ref.date === "string" &&
      Number.isFinite(Date.parse(ref.date)) &&
      typeof ref.subject === "string" &&
      (ref.rfc822Id === undefined || ref.rfc822Id === null || typeof ref.rfc822Id === "string") &&
      (ref.threadPid === undefined || typeof ref.threadPid === "string");
    if (!valid) {
      throw invalid("Each matter ref needs account, providerId, date and subject");
    }
  }
}

function assertFields(fields: Partial<Knowledge> | undefined): void {
  if (!fields) {
    return;
  }
  if (
    "notes" in fields &&
    fields.notes !== null &&
    fields.notes !== undefined &&
    (typeof fields.notes !== "string" || fields.notes.length > NOTES_MAX_LENGTH)
  ) {
    throw invalid(`Notes must be a string of at most ${NOTES_MAX_LENGTH} characters`);
  }
  if (
    "watch" in fields &&
    fields.watch !== null &&
    fields.watch !== undefined &&
    (typeof fields.watch !== "string" || fields.watch.length > MATTER_WATCH_MAX_LENGTH)
  ) {
    throw invalid(
      `A matter watch must be a query of at most ${MATTER_WATCH_MAX_LENGTH} characters`,
    );
  }
  if ("refs" in fields && fields.refs !== undefined) {
    assertRefs(fields.refs);
  }
}

/** Shape checks for knowledge fields on `person_update`, `matter_update` and `matter_create`. */
export function assertKnowledge(request: ActionRequest): void {
  switch (request.type) {
    case "person_update":
      assertFields((request.params as ActionParams["person_update"]).patch as Partial<Knowledge>);
      return;
    case "matter_update":
      assertFields((request.params as ActionParams["matter_update"]).patch);
      return;
    case "matter_create":
      assertFields((request.params as ActionParams["matter_create"]).matter);
      return;
    default:
      return;
  }
}

function knowledgeOnly(patch: object | undefined, fields: readonly string[]): string[] | null {
  const keys = Object.keys(patch ?? {}).filter((key) => key !== "updatedAt");
  return keys.length && keys.every((key) => fields.includes(key)) ? keys : null;
}

/**
 * The inverse parameters of a knowledge-only update: the same action type with the prior
 * content of exactly the fields it changes (the `profile_update` pattern). Undo then restores
 * the notes without rolling back security state or matter status written in between.
 * Returns null for any other request, which keeps the full-snapshot inverse.
 */
export async function knowledgeInverseOf(
  store: Store,
  request: ActionRequest,
): Promise<ActionParams["person_update"] | ActionParams["matter_update"] | null> {
  if (request.type === "person_update") {
    const params = request.params as ActionParams["person_update"];
    if (!knowledgeOnly(params.patch, KNOWLEDGE_FIELDS.person)) {
      return null;
    }
    const prior = await store.people.get(params.personId);
    return prior ? { personId: prior.id, patch: { notes: prior.notes ?? null } } : null;
  }
  if (request.type === "matter_update") {
    const params = request.params as ActionParams["matter_update"];
    const keys = knowledgeOnly(params.patch, KNOWLEDGE_FIELDS.matter);
    if (!keys) {
      return null;
    }
    const prior = await store.matters.get(params.matterId);
    if (!prior) {
      return null;
    }
    const restore: Partial<Matter> = {};
    for (const key of keys) {
      if (key === "refs") {
        restore.refs = prior.refs ?? [];
      } else if (key === "notes") {
        restore.notes = prior.notes ?? null;
      } else if (key === "watch") {
        restore.watch = prior.watch ?? null;
      }
    }
    return { matterId: prior.id, patch: restore };
  }
  return null;
}

/** `refs` after attaching emails: provider references resolved from the cached envelopes. */
export function refsWithEmails(matter: Pick<Matter, "refs">, emails: Email[]): MailRef[] {
  return mergeMailRefs(matter.refs ?? [], emails.map(mailRefOf));
}
