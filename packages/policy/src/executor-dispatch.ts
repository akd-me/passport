import type { ActionRecord, ActionRequest, DraftInput, Matter } from "@passport/types";
import { PolicyError } from "./errors.js";
import type { ExecutorContext } from "./executor-context.js";
import type { MailActions } from "./executor-mail.js";
import type { Restoration } from "./executor-restoration.js";
import {
  type ActionExecutorOptions,
  isCompletePerson,
  type Request,
  type Snapshot,
  snapshotOf,
} from "./executor-shared.js";
import { parseListUnsubscribe, requestUnsubscribe } from "./unsubscribe.js";

export function createDispatch(
  options: ActionExecutorOptions,
  context: ExecutorContext,
  mail: MailActions,
  restoration: Restoration,
  lifecycle: {
    submitAction(
      request: ActionRequest,
      onCreated?: (action: ActionRecord) => Promise<void>,
    ): Promise<ActionRecord>;
    settleUnsubscribeParent(child: ActionRecord): Promise<void>;
  },
) {
  const {
    store,
    bus,
    mailProviderFor,
    calendarProviderFor,
    fetch: fetcher,
    resolveDns,
    log,
    now = () => new Date().toISOString(),
  } = options;
  const { emailFor, eventFor, matterFor, allEmails } = context;
  const { mirrorMatter, changeMail } = mail;
  const { restore, writeMatter } = restoration;
  const { submitAction, settleUnsubscribeParent } = lifecycle;
  const dispatch = async (
    request: Request,
    snapshot: Snapshot | null,
    action: ActionRecord,
  ): Promise<Record<string, unknown>> => {
    const inverse = snapshotOf(request);
    if (inverse) {
      return restore(request, inverse);
    }
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
      case "delete": {
        if (snapshot?.kind !== "mail") {
          throw new PolicyError("INVALID_INVERSE", "Mail snapshot is required");
        }
        return changeMail(request, snapshot);
      }
      case "draft_create":
      case "draft_update": {
        const provider = await mailProviderFor(request.accountId);
        const prior =
          request.type === "draft_update"
            ? await emailFor(request.params.draftEmailId, request.accountId)
            : null;
        const email = prior
          ? await provider.updateDraft(prior.providerId, request.params.draft)
          : await provider.createDraft(request.params.draft);
        const saved = { ...email, id: prior?.id ?? email.id, accountId: request.accountId };
        if (snapshot?.kind === "draft") {
          snapshot.createdId = saved.id;
        }
        await store.emails.upsertMany([saved]);
        bus.emit({ type: "email.updated", emailId: saved.id });
        return { emailId: saved.id, providerId: saved.providerId };
      }
      case "draft_delete": {
        const email = await emailFor(request.params.draftEmailId, request.accountId);
        await (await mailProviderFor(request.accountId)).deleteDraft(email.providerId);
        await store.emails.deleteMany([email.id]);
        bus.emit({ type: "email.updated", emailId: email.id });
        return { emailId: email.id };
      }
      case "send":
      case "calendar_propose": {
        const prior =
          request.type === "send" && request.params.draftEmailId
            ? await emailFor(request.params.draftEmailId, request.accountId)
            : null;
        if (prior && !prior.keywords.$draft) {
          throw new PolicyError("NOT_A_DRAFT", "Only draft emails can be sent");
        }
        const draft = request.params.draft;
        if (!prior && !draft) {
          throw new PolicyError("INVALID_PARAMS", "Send requires a draft or draftEmailId");
        }
        const provider = await mailProviderFor(request.accountId);
        // Submit the authorized content, so a draft edit racing the transport cannot change the send.
        const result = await provider.send({
          draft: prior ? (action.approvedSnapshot as DraftInput) : draft!,
        });
        try {
          if (prior) {
            await provider.deleteDraft(prior.providerId);
            await store.emails.deleteMany([prior.id]);
            bus.emit({ type: "email.updated", emailId: prior.id });
          }
          const sent = await provider.getEmail(result.providerId);
          if (sent) {
            await store.emails.upsertMany([{ ...sent, accountId: request.accountId }]);
            bus.emit({ type: "email.updated", emailId: sent.id });
          }
        } catch {
          // Message submitted; sent-copy or draft cleanup failed.
          log?.("Message submitted; sent-copy or draft cleanup failed");

          return {
            ...result,
            warning: "SUBMISSION_ACCEPTED: message submitted; sent-copy or draft cleanup failed",
          };
        }
        return { ...result };
      }
      case "unsubscribe": {
        const { emailId, method } = request.params;
        const email = await emailFor(emailId, request.accountId);
        const { https, mailto, oneClick } = parseListUnsubscribe(
          email.headers.listUnsubscribe,
          email.headers.listUnsubscribePost,
        );
        if (((method === "header" && oneClick) || method === "link") && https) {
          return {
            method,
            ...(await requestUnsubscribe(
              fetcher,
              https,
              method === "header" ? "POST" : "GET",
              resolveDns,
            )),
          };
        }
        let draft: DraftInput;
        if (method === "header" && mailto) {
          draft = {
            accountId: request.accountId,
            to: [{ email: mailto.address }],
            subject: mailto.subject,
            textBody: mailto.textBody,
          };
        } else if (method === "reply" && (email.replyTo.length || email.from.length)) {
          draft = {
            accountId: request.accountId,
            inReplyToEmailId: email.id,
            to: email.replyTo.length ? email.replyTo : email.from,
            subject: "unsubscribe",
            textBody: "unsubscribe",
          };
        } else {
          throw new PolicyError(
            "UNSUBSCRIBE_UNSUPPORTED",
            `No supported unsubscribe target for method ${method}`,
          );
        }
        const child = await submitAction(
          {
            type: "send",
            accountId: request.accountId,
            params: { draft },
            actor: request.actor,
            category: "unsubscribe",
            reason: `Unsubscribe email for action ${action.id}: ${request.reason}`,
            matterId: request.matterId,
            runId: request.runId,
            counterparty: request.counterparty,
          },
          async (child) => {
            await store.actions.update(action.id, {
              result: {
                method,
                target: draft.to[0]!.email,
                status: "pending",
                childActionId: child.id,
              },
            });
            await store.kv.set(`policy:unsubscribe-parent:${child.id}`, action.id);
          },
        );
        const latestChild = (await store.actions.get(child.id)) ?? child;
        await settleUnsubscribeParent(latestChild);
        return {
          method,
          target: draft.to[0]!.email,
          status: latestChild.status === "executed" ? "sent" : "pending",
          childActionId: child.id,
        };
      }
      case "calendar_create": {
        const event = await (await calendarProviderFor(request.accountId)).createEvent(
          request.params.event,
        );
        if (snapshot?.kind === "event") {
          snapshot.createdId = event.id;
        }
        await store.events.upsertMany([event]);
        return { eventId: event.id, providerId: event.providerId };
      }
      case "calendar_update": {
        const prior = await eventFor(request.params.eventId, request.accountId);
        const event = await (await calendarProviderFor(request.accountId)).updateEvent(
          prior.providerId,
          request.params.patch,
        );
        await store.events.upsertMany([{ ...event, id: prior.id, accountId: prior.accountId }]);
        return { eventId: prior.id };
      }
      case "calendar_respond": {
        const event = await eventFor(request.params.eventId, request.accountId);
        await (await calendarProviderFor(request.accountId)).respond(
          event.providerId,
          request.params.status,
          request.params.comment,
        );
        await store.events.upsertMany([
          { ...event, myStatus: request.params.status, updatedAt: now() },
        ]);
        return { eventId: event.id };
      }
      case "calendar_delete": {
        const event = await eventFor(request.params.eventId, request.accountId);
        await (await calendarProviderFor(request.accountId)).deleteEvent(event.providerId);
        await store.events.deleteMany([event.id]);
        return { eventId: event.id };
      }
      case "matter_create": {
        if (snapshot?.kind !== "matter") {
          throw new PolicyError("INVALID_INVERSE", "Matter snapshot is required");
        }
        const at = now(),
          matter: Matter = {
            ...request.params.matter,
            id: snapshot.id,
            createdAt: at,
            updatedAt: at,
          };
        const saved = await writeMatter(request, snapshot, matter);
        return { matterId: saved.id, matter: saved };
      }
      case "matter_update": {
        const prior = await matterFor(request.params.matterId);
        const matter = {
          ...prior,
          ...request.params.patch,
          id: prior.id,
          createdAt: prior.createdAt,
          updatedAt: now(),
        };
        await mirrorMatter(matter);
        return { matterId: matter.id };
      }
      case "matter_attach": {
        if (snapshot?.kind !== "matter") {
          throw new PolicyError("INVALID_INVERSE", "Matter snapshot is required");
        }
        const prior = await matterFor(request.params.matterId);
        const unique = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];
        const matter = {
          ...prior,
          emailIds: unique(prior.emailIds, request.params.emailIds),
          eventIds: unique(prior.eventIds, request.params.eventIds),
          personIds: unique(prior.personIds, request.params.personIds),
          updatedAt: now(),
        };
        await writeMatter(request, snapshot, matter);
        return { matterId: matter.id };
      }
      case "person_update": {
        if (snapshot?.kind !== "person") {
          throw new PolicyError("INVALID_INVERSE", "Person snapshot is required");
        }
        const prior = snapshot.person;
        const patch = { ...request.params.patch };
        // Neither model input nor complete inferred snapshots can mint an approved self identity.
        delete patch.verifiedSelf;
        if (prior?.verifiedSelf !== undefined) {
          patch.verifiedSelf = prior.verifiedSelf;
        }
        const approved =
          request.actor.kind === "human" ||
          Boolean(await store.kv.get(`policy:feedback:${action.id}`));
        if (
          (patch.relationship ?? prior?.relationship) === "self" &&
          approved &&
          (await store.kv.get(`policy:feedback:${action.id}`))
        ) {
          patch.verifiedSelf = true;
        }
        if (!approved) {
          delete patch.downgradeAcknowledgedAt;
          if (prior?.downgradeAcknowledgedAt !== undefined) {
            patch.downgradeAcknowledgedAt = prior.downgradeAcknowledgedAt;
          }
        }
        if (!prior) {
          if (!isCompletePerson(patch)) {
            throw new PolicyError("PERSON_NOT_FOUND", "Creation requires a complete Person patch");
          }
          await store.people.upsert(patch);
          return { personId: request.params.personId };
        }
        await store.people.upsert({
          ...prior,
          ...patch,
          id: prior.id,
          createdAt: prior.createdAt,
          updatedAt: now(),
        });
        return { personId: prior.id };
      }
      case "profile_update": {
        await store.kv.set("user_profile", request.params.markdown);
        return {};
      }
      case "snooze": {
        if (request.params.matterId) {
          const matter = await matterFor(request.params.matterId);
          await mirrorMatter({
            ...matter,
            status: "snoozed",
            snoozedUntil: request.params.until,
            updatedAt: now(),
          });
        }
        for (const email of await allEmails(request.params.emailIds ?? [], request.accountId)) {
          await store.kv.set(`policy:snooze:${email.id}`, request.params.until);
        }
        return { until: request.params.until };
      }
    }
  };
  return { dispatch };
}
export type Dispatch = ReturnType<typeof createDispatch>;
