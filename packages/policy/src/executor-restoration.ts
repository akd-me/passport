import type { ActionRequest, Email, MailChange, Matter } from "@passport/types";
import { PolicyError } from "./errors.js";
import type { ExecutorContext } from "./executor-context.js";
import type { MailActions } from "./executor-mail.js";
import {
  type ActionExecutorOptions,
  agentEmailPatchOf,
  draftOf,
  freshPreImage,
  type Snapshot,
} from "./executor-shared.js";

export function createRestoration(
  options: ActionExecutorOptions,
  context: ExecutorContext,
  mail: MailActions,
) {
  const {
    store,
    bus,
    mailProviderFor,
    calendarProviderFor,
    now = () => new Date().toISOString(),
  } = options;
  const { emailFor, eventFor, freshEmails } = context;
  const { mirrorEmail, mirrorMatter, mailboxFor, usesLabels, applyMailChanges } = mail;
  const restore = async (
    request: ActionRequest,
    snapshot: Snapshot,
  ): Promise<Record<string, unknown>> => {
    switch (snapshot.kind) {
      case "mail": {
        const labels = await usesLabels(request.accountId);
        const changes: MailChange[] = [];
        const currents: Email[] = [];
        const skipped: string[] = [];
        // Diff against provider state, not the cache, so the inverse undoes what is really there.
        // One batched read; messages that no longer exist are skipped, unverifiable ones fail.
        const found = await freshEmails(
          snapshot.emails.map((email) => email.id),
          request.accountId,
          freshPreImage(request),
        );
        for (const prior of snapshot.emails) {
          const current = found.get(prior.id);
          if (!current || current.keywords.$deleted) {
            skipped.push(prior.id);
            continue;
          }
          if (current.staleAsOf !== undefined) {
            throw new PolicyError(
              "PROVIDER_UNAVAILABLE",
              "Current provider state is unavailable; retry the undo when the account is reachable",
            );
          }
          currents.push(current);
          const add = Object.keys(prior.keywords).filter(
            (key) => prior.keywords[key] && !current.keywords[key],
          );
          const remove = Object.keys(current.keywords).filter(
            (key) => current.keywords[key] && !prior.keywords[key],
          );
          // Apply flags before a folder move, which may change the provider's message ID.
          if (add.length || remove.length) {
            changes.push({ op: "setKeywords", providerIds: [current.providerId], add, remove });
          }
          if (labels) {
            for (const id of prior.mailboxIds.filter((id) => !current.mailboxIds.includes(id))) {
              changes.push({
                op: "addToMailbox",
                providerIds: [current.providerId],
                mailboxProviderId: (await mailboxFor(request.accountId, id)).providerId,
              });
            }
            for (const id of current.mailboxIds.filter((id) => !prior.mailboxIds.includes(id))) {
              changes.push({
                op: "removeFromMailbox",
                providerIds: [current.providerId],
                mailboxProviderId: (await mailboxFor(request.accountId, id)).providerId,
              });
            }
          } else if (
            prior.mailboxIds.length !== current.mailboxIds.length ||
            prior.mailboxIds.some((id) => !current.mailboxIds.includes(id))
          ) {
            if (prior.mailboxIds.length !== 1) {
              throw new PolicyError(
                "INVALID_INVERSE",
                "Folder-based mail requires exactly one previous mailbox to restore",
              );
            }
            changes.push({
              op: "move",
              providerIds: [current.providerId],
              toMailboxProviderId: (await mailboxFor(request.accountId, prior.mailboxIds[0]!))
                .providerId,
            });
          }
        }
        await applyMailChanges(request.accountId, changes, currents);
        const restored = snapshot.emails.filter((prior) => !skipped.includes(prior.id));
        for (const prior of restored) {
          await mirrorEmail(prior.id, {
            mailboxIds: prior.mailboxIds,
            keywords: prior.keywords,
            providerId: currents.find((email) => email.id === prior.id)!.providerId,
          });
        }
        return {
          emailIds: restored.map((email) => email.id),
          ...(skipped.length ? { skippedEmailIds: skipped } : {}),
        };
      }
      case "draft": {
        const provider = await mailProviderFor(request.accountId);
        if (!snapshot.email) {
          if (!snapshot.createdId) {
            throw new PolicyError("INVALID_INVERSE", "Draft inverse is missing its created id");
          }
          const email = await emailFor(snapshot.createdId, request.accountId);
          await provider.deleteDraft(email.providerId);
          await store.emails.deleteMany([email.id]);
          bus.emit({ type: "email.updated", emailId: email.id });
          return { deletedEmailId: email.id };
        }
        const current = await store.emails.get(snapshot.email.id);
        const restored = current
          ? await provider.updateDraft(current.providerId, draftOf(snapshot.email))
          : await provider.createDraft(draftOf(snapshot.email));
        await store.emails.upsertMany([{ ...snapshot.email, providerId: restored.providerId }]);
        bus.emit({ type: "email.updated", emailId: snapshot.email.id });
        return { emailId: snapshot.email.id };
      }
      case "event": {
        const provider = await calendarProviderFor(request.accountId);
        if (!snapshot.event) {
          if (!snapshot.createdId) {
            throw new PolicyError("INVALID_INVERSE", "Event inverse is missing its created id");
          }
          const event = await eventFor(snapshot.createdId, request.accountId);
          await provider.deleteEvent(event.providerId);
          await store.events.deleteMany([event.id]);
          return { deletedEventId: event.id };
        }
        const current = await eventFor(snapshot.event.id, request.accountId);
        const restored = await provider.updateEvent(current.providerId, snapshot.event);
        await store.events.upsertMany([{ ...snapshot.event, providerId: restored.providerId }]);
        return { eventId: snapshot.event.id };
      }
      case "matter": {
        if (snapshot.matter) {
          await mirrorMatter(snapshot.matter);
        } else {
          await store.matters.delete(snapshot.id);
        }
        for (const email of snapshot.emails) {
          const { id, ...patch } = email;
          await mirrorEmail(id, patch);
        }
        if (snapshot.events.length) {
          await store.events.upsertMany(snapshot.events);
        }
        return { matterId: snapshot.id };
      }
      case "person": {
        if (snapshot.person) {
          await store.people.upsert(snapshot.person);
          return { personId: snapshot.person.id };
        }
        if (!snapshot.createdId) {
          throw new PolicyError("INVALID_INVERSE", "Person inverse is missing its created id");
        }
        if (!store.people.delete) {
          throw new PolicyError(
            "PERSON_DELETE_UNSUPPORTED",
            "Undoing person creation requires Store.people.delete",
          );
        }
        await store.people.delete(snapshot.createdId);
        return { deletedPersonId: snapshot.createdId };
      }
      case "snooze":
        if (snapshot.matter) {
          await mirrorMatter(snapshot.matter);
        }
        for (const { key, value } of snapshot.kv) {
          if (value === null) {
            await store.kv.delete(key);
          } else {
            await store.kv.set(key, value);
          }
        }
        return {};
    }
  };
  const writeMatter = async (
    request: ActionRequest,
    snapshot: Extract<Snapshot, { kind: "matter" }>,
    matter: Matter,
  ): Promise<Matter> => {
    let saved: Matter;
    try {
      saved = await store.matters.upsert(matter);
      if (snapshot.emails.length) {
        await store.emails.patchMany(
          snapshot.emails.map((email) => email.id),
          { matterId: matter.id, ...agentEmailPatchOf(request) },
        );
      }
      if (snapshot.events.length) {
        await store.events.upsertMany(
          snapshot.events.map((event) => ({ ...event, matterId: matter.id, updatedAt: now() })),
        );
      }
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      // Store has no cross-repository transaction API; compensate within this serialized action.
      try {
        await restore(request, snapshot);
      } catch (rollbackError) {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        throw new AggregateError(
          [error, rollbackError],
          "Matter action failed and snapshot restoration failed",
        );
      }
      throw error;
    }
    bus.emit({ type: "matter.updated", matter: saved });
    for (const email of snapshot.emails) {
      bus.emit({ type: "email.updated", emailId: email.id });
    }
    return saved;
  };
  return { restore, writeMatter };
}
export type Restoration = ReturnType<typeof createRestoration>;
