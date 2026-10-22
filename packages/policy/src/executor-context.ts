import type {
  ActionParams,
  ActionRecord,
  ActionRequest,
  CalendarEvent,
  DraftInput,
  Email,
  EmailGetOptions,
  Matter,
} from "@passport/types";
import { PolicyError } from "./errors.js";
import {
  type ActionExecutorOptions,
  draftOf,
  FRESH_PRE_IMAGE,
  isCompletePerson,
  marker,
  normalizedDraft,
  patchOf,
  preImageOf,
  type Request,
  type Snapshot,
} from "./executor-shared.js";
import { newId } from "./id.js";

export function createExecutorContext(options: ActionExecutorOptions) {
  const { store, now = () => new Date().toISOString() } = options;
  const requireAction = async (
    id: string,
    statuses: ActionRecord["status"][],
  ): Promise<ActionRecord> => {
    const action = await store.actions.get(id);
    if (!action) {
      throw new PolicyError("ACTION_NOT_FOUND", `Action ${id} does not exist`);
    }
    if (!statuses.includes(action.status)) {
      throw new PolicyError(
        "INVALID_ACTION_STATE",
        `Cannot perform this operation on a ${action.status} action`,
      );
    }
    return action;
  };
  const claim = async (
    action: ActionRecord,
    to: ActionRecord["status"] = "executing",
  ): Promise<ActionRecord | null> => {
    if (!store.actions.claim) {
      throw new PolicyError(
        "ACTION_CLAIM_UNSUPPORTED",
        "Store.actions.claim is required for shared action transitions",
      );
    }
    return store.actions.claim(action.id, action.status, to, now());
  };
  const requireClaim = async (action: ActionRecord): Promise<ActionRecord> => {
    const claimed = await claim(action);
    if (!claimed) {
      throw new PolicyError("INVALID_ACTION_STATE", "Another executor already claimed this action");
    }
    return claimed;
  };
  const emailFor = async (
    id: string,
    accountId: string,
    opts: EmailGetOptions = { includeBodies: true },
  ): Promise<Email> => {
    const email = await store.emails.get(id, opts);
    if (!email) {
      throw new PolicyError("EMAIL_NOT_FOUND", `Email ${id} does not exist`);
    }
    if (email.accountId !== accountId) {
      throw new PolicyError("ACCOUNT_MISMATCH", "Email belongs to another account");
    }
    return email;
  };
  const eventFor = async (id: string, accountId: string): Promise<CalendarEvent> => {
    const event = await store.events.get(id);
    if (!event) {
      throw new PolicyError("EVENT_NOT_FOUND", `Event ${id} does not exist`);
    }
    if (event.accountId !== accountId) {
      throw new PolicyError("ACCOUNT_MISMATCH", "Event belongs to another account");
    }
    return event;
  };
  const matterFor = async (id: string): Promise<Matter> => {
    const matter = await store.matters.get(id);
    if (!matter) {
      throw new PolicyError("MATTER_NOT_FOUND", `Matter ${id} does not exist`);
    }
    return matter;
  };
  const allEmails = (ids: string[], accountId: string, opts?: EmailGetOptions) =>
    Promise.all([...new Set(ids)].map((id) => emailFor(id, accountId, opts)));
  const resolvedDraft = async (request: ActionRequest): Promise<DraftInput> => {
    const { draft, draftEmailId } = request.params as ActionParams["send"];
    if (!!draft === !!draftEmailId) {
      throw new PolicyError("INVALID_PARAMS", "Send requires exactly one draft or draftEmailId");
    }
    if (draft) {
      return normalizedDraft(draft);
    }
    const email = await emailFor(draftEmailId!, request.accountId);
    if (!email.keywords.$draft) {
      throw new PolicyError("NOT_A_DRAFT", "Only draft emails can be sent");
    }
    const resolved = draftOf(email);
    if (email.headers.inReplyTo) {
      let cursor: string | null | undefined;
      do {
        const page = await store.emails.query({
          accountId: email.accountId,
          threadId: email.threadId,
          includeDeleted: true,
          limit: 100,
          cursor,
        });
        const source = page.items.find(
          (source) =>
            source.id !== email.id && source.headers.messageId === email.headers.inReplyTo,
        );
        if (source) {
          resolved.inReplyToEmailId = source.id;
          break;
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (!resolved.inReplyToEmailId) {
        throw new PolicyError(
          "REPLY_NOT_FOUND",
          "The saved draft reply source is unavailable; sync before approving this send",
        );
      }
    }
    return normalizedDraft(resolved);
  };
  const assertPublic = async (request: ActionRequest) => {
    if (
      !request.params ||
      typeof request.params !== "object" ||
      Object.hasOwn(request.params, marker)
    ) {
      throw new PolicyError("INVALID_PARAMS", "Private inverse data cannot be submitted");
    }
    if (!["human", "agent", "external-agent"].includes(request.actor?.kind)) {
      throw new PolicyError("INVALID_ACTOR", "Unknown actor kind");
    }
    const params = request.params as unknown as {
      draft?: DraftInput;
      event?: CalendarEvent;
      patch?: {
        accountId?: string;
        id?: string;
        providerId?: string;
        verification?: unknown;
        relationship?: unknown;
      };
    };
    if (
      request.type === "profile_update" &&
      (request.category !== "matters" ||
        typeof (request.params as ActionParams["profile_update"]).markdown !== "string")
    ) {
      throw new PolicyError(
        "INVALID_PARAMS",
        "Profile updates require matters category and markdown",
      );
    }
    const personParams =
      request.type === "person_update" ? (request.params as ActionParams["person_update"]) : null;
    const completePerson = personParams && isCompletePerson(personParams.patch);
    const personSnapshot = completePerson && request.actor.kind !== "external-agent";
    if (
      (params.draft && params.draft.accountId !== request.accountId) ||
      (params.event && params.event.accountId !== request.accountId) ||
      (params.patch?.accountId && params.patch.accountId !== request.accountId) ||
      (params.patch?.id !== undefined &&
        !(completePerson && params.patch.id === personParams.personId)) ||
      params.patch?.providerId !== undefined
    ) {
      throw new PolicyError("ACCOUNT_MISMATCH", "Action edits cannot change identity or account");
    }
    const target = personParams ? await store.people.get(personParams.personId) : null;
    if (
      request.type === "person_update" &&
      params.patch &&
      !personSnapshot &&
      ("verification" in params.patch ||
        (request.actor.kind !== "human" &&
          "relationship" in params.patch &&
          params.patch.relationship !== "self" &&
          target?.relationship !== "self"))
    ) {
      throw new PolicyError(
        "PROTECTED_IDENTITY",
        "Verification must come from trusted identity data; only humans can change relationships",
      );
    }
  };
  const capture = async (request: Request): Promise<Snapshot | null> => {
    switch (request.type) {
      case "label":
      case "unlabel":
      case "archive":
      case "unarchive":
      case "mark_read":
      case "mark_unread":
      case "flag":
      case "unflag":
      case "move":
      case "delete":
        return {
          kind: "mail",
          emails: (
            await allEmails(request.params.emailIds, request.accountId, FRESH_PRE_IMAGE)
          ).map(preImageOf),
        };
      case "draft_create":
        return { kind: "draft", email: null };
      case "draft_update":
      case "draft_delete": {
        const email = await emailFor(request.params.draftEmailId, request.accountId);
        if (!email.keywords.$draft) {
          throw new PolicyError("NOT_A_DRAFT", "Draft operations require a draft email");
        }
        return { kind: "draft", email };
      }
      case "calendar_create":
        return { kind: "event", event: null };
      case "calendar_update":
        return { kind: "event", event: await eventFor(request.params.eventId, request.accountId) };
      case "matter_create": {
        const emails = await allEmails(request.params.matter.emailIds, request.accountId);
        const events = await Promise.all(
          request.params.matter.eventIds.map((id) => eventFor(id, request.accountId)),
        );
        return {
          kind: "matter",
          matter: null,
          id: newId(now()),
          emails: emails.map(patchOf),
          events,
        };
      }
      case "matter_update":
      case "matter_attach": {
        const matter = await matterFor(request.params.matterId);
        const emails =
          request.type === "matter_attach"
            ? await allEmails(request.params.emailIds ?? [], request.accountId)
            : [];
        const events =
          request.type === "matter_attach"
            ? await Promise.all(
                (request.params.eventIds ?? []).map((id) => eventFor(id, request.accountId)),
              )
            : [];
        if (request.type === "matter_attach") {
          for (const id of request.params.personIds ?? []) {
            if (!(await store.people.get(id))) {
              throw new PolicyError("PERSON_NOT_FOUND", `Person ${id} does not exist`);
            }
          }
        }
        return { kind: "matter", matter, id: matter.id, emails: emails.map(patchOf), events };
      }
      case "person_update": {
        const person = await store.people.get(request.params.personId);
        if (!person) {
          if (!isCompletePerson(request.params.patch)) {
            throw new PolicyError(
              "PERSON_NOT_FOUND",
              `Person ${request.params.personId} does not exist; creation requires a complete Person patch`,
            );
          }
          if (!store.people.delete) {
            throw new PolicyError(
              "PERSON_DELETE_UNSUPPORTED",
              "Creating a person requires Store.people.delete so it can be undone",
            );
          }
        }
        return {
          kind: "person",
          person,
          ...(!person ? { createdId: request.params.personId } : {}),
        };
      }
      case "snooze": {
        if (!Number.isFinite(Date.parse(request.params.until))) {
          throw new PolicyError("INVALID_TIME", "Snooze time must be an ISO timestamp");
        }
        const emails = await allEmails(request.params.emailIds ?? [], request.accountId);
        const kv = await Promise.all(
          emails.map(async (email) => {
            const key = `policy:snooze:${email.id}`;
            return { key, value: await store.kv.get(key) };
          }),
        );
        return {
          kind: "snooze",
          matter: request.params.matterId ? await matterFor(request.params.matterId) : null,
          kv,
        };
      }
      default:
        return null;
    }
  };
  return {
    requireAction,
    claim,
    requireClaim,
    emailFor,
    eventFor,
    matterFor,
    allEmails,
    resolvedDraft,
    assertPublic,
    capture,
  };
}
export type ExecutorContext = ReturnType<typeof createExecutorContext>;
