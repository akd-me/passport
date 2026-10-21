import { isDeepStrictEqual } from "node:util";
import type {
  ActionExecutor,
  ActionParams,
  ActionRecord,
  ActionRequest,
  DraftInput,
} from "@passport/types";
import { PolicyError } from "./errors.js";
import type { ExecutorContext } from "./executor-context.js";
import { type ActionExecutorOptions, snapshotOf } from "./executor-shared.js";
import { editDistanceRatio } from "./helpers.js";
import { newId } from "./id.js";

export function createExecutorCommands(
  options: ActionExecutorOptions,
  context: ExecutorContext,
  lifecycle: {
    serial<T>(operation: () => Promise<T>): Promise<T>;
    holdOrExecute(action: ActionRecord): Promise<ActionRecord>;
    executeUndo(
      action: ActionRecord,
      originalId: string,
      claimedOriginal?: ActionRecord,
    ): Promise<ActionRecord>;
    settleUnsubscribeParent(child: ActionRecord): Promise<void>;
  },
): Pick<ActionExecutor, "approve" | "reject" | "cancelHold" | "undo"> {
  const { store, bus, policy, now = () => new Date().toISOString() } = options;
  const { requireAction, requireClaim, assertPublic } = context;
  const { serial, holdOrExecute, executeUndo, settleUnsubscribeParent } = lifecycle;
  return {
    approve: (actionId, edited) =>
      serial(async () => {
        const original = await requireAction(actionId, ["proposed"]);
        let distance = 0;
        if (edited) {
          await assertPublic(edited);
          if (await store.kv.get(`policy:undo:${actionId}`)) {
            throw new PolicyError("INVALID_EDIT", "Stored undo snapshots cannot be edited");
          }
          if (
            edited.type !== original.request.type ||
            edited.accountId !== original.request.accountId ||
            edited.category !== original.request.category ||
            edited.actor.kind !== original.request.actor.kind ||
            edited.actor.id !== original.request.actor.id
          ) {
            throw new PolicyError(
              "INVALID_EDIT",
              "Approval edits must preserve action type, account, actor, and category",
            );
          }
          const text = (request: ActionRequest): string | null => {
            const draft = (request.params as { draft?: DraftInput }).draft;
            return draft ? `${draft.subject}\n${draft.textBody}` : null;
          };
          const left = text(original.request),
            right = text(edited);
          distance =
            left !== null && right !== null
              ? editDistanceRatio(left, right)
              : editDistanceRatio(original.request.params, edited.params);
        }
        const decision = await policy.evaluate(edited ?? original.request);
        if (decision.outcome === "deny") {
          throw new PolicyError("ACTION_DENIED", decision.reason);
        }
        await requireClaim(original);
        // A changed held draft needs reapproval, but feedback is still counted once per record.
        if (!(await store.kv.get(`policy:feedback:${actionId}`))) {
          await policy.recordOutcome(
            actionId,
            edited ? "approved_edited" : "approved_unchanged",
            distance,
          );
        }
        const approved = await store.actions.update(actionId, {
          decision,
          decidedAt: now(),
          request: structuredClone(edited ?? original.request),
          editDistance: edited ? distance : null,
        });
        bus.emit({ type: "action.decided", action: approved });
        return holdOrExecute(approved);
      }),
    reject: (actionId, reason) =>
      serial(async () => {
        await requireClaim(await requireAction(actionId, ["proposed"]));
        if (!(await store.kv.get(`policy:feedback:${actionId}`))) {
          await policy.recordOutcome(actionId, "rejected");
        }
        const rejected = await store.actions.update(actionId, {
          status: "rejected",
          decidedAt: now(),
          ...(reason ? { error: reason } : {}),
        });
        bus.emit({ type: "action.decided", action: rejected });
        await settleUnsubscribeParent(rejected);
        return rejected;
      }),
    cancelHold: (actionId) =>
      serial(async () => {
        await requireClaim(await requireAction(actionId, ["held"]));
        const cancelled = await store.actions.update(actionId, {
          status: "rejected",
          decidedAt: now(),
          holdUntil: null,
          error: "Cancelled during outbox hold",
        });
        bus.emit({ type: "action.decided", action: cancelled });
        await settleUnsubscribeParent(cancelled);
        return cancelled;
      }),
    undo: (actionId, context) =>
      serial(async () => {
        const original = await requireAction(actionId, ["executed"]);
        if (!original.inverse) {
          throw new PolicyError("IRREVERSIBLE_ACTION", "This action has no inverse");
        }
        const at = now();
        const request = {
          ...structuredClone(original.inverse),
          ...(context
            ? {
                actor: context.actor,
                reason: `Undo ${actionId}: ${context.reason ?? "Restore prior state"}`,
              }
            : {}),
        };
        const decision = context
          ? await policy.evaluate(request)
          : {
              ...original.decision,
              outcome: "allow" as const,
              reversibility: "reversible" as const,
              reason: `Human requested undo of ${actionId}`,
            };
        if (context?.actor.kind === "external-agent") {
          if (
            (original.request.actor.kind !== "external-agent" ||
              original.request.actor.id !== context.actor.id) &&
            decision.trustLevel !== "full_access"
          ) {
            decision.outcome = "deny";
            decision.reason = "External agents can only undo their own actions below full access.";
          }
          const snapshot = snapshotOf(request);
          const boxes = await store.mailboxes.list(request.accountId);
          let protectedPerson = false;
          if (snapshot?.kind === "person") {
            const id = (request.params as ActionParams["person_update"]).personId;
            const current = await store.people.get(id),
              prior = snapshot.person;
            protectedPerson =
              !prior ||
              !current ||
              !isDeepStrictEqual(
                {
                  emails: prior.emails,
                  relationship: prior.relationship,
                  verifiedSelf: prior.verifiedSelf,
                  downgradeAcknowledgedAt: prior.downgradeAcknowledgedAt,
                },
                {
                  emails: current.emails,
                  relationship: current.relationship,
                  verifiedSelf: current.verifiedSelf,
                  downgradeAcknowledgedAt: current.downgradeAcknowledgedAt,
                },
              );
          }
          if (
            (snapshot?.kind === "mail" &&
              snapshot.emails.some((email) =>
                email.mailboxIds.some((id) =>
                  boxes.some((box) => box.id === id && ["trash", "junk"].includes(box.role ?? "")),
                ),
              )) ||
            (snapshot?.kind === "event" && !snapshot.event) ||
            protectedPerson
          ) {
            decision.outcome = "deny";
            decision.reason =
              "The external agent ceiling forbids restoring protected or destructive state.";
          }
        }
        if (decision.outcome !== "deny" && decision.outcome !== "ask") {
          await requireClaim(original);
        }
        const inverse = await store.actions.insert({
          id: newId(at),
          request,
          decision,
          status:
            decision.outcome === "deny"
              ? "rejected"
              : decision.outcome === "ask"
                ? "proposed"
                : "approved",
          createdAt: at,
          ...(decision.outcome !== "ask" ? { decidedAt: at } : {}),
        });
        await store.kv.set(`policy:undo:${inverse.id}`, actionId);
        if (decision.outcome === "ask") {
          bus.emit({ type: "action.proposed", action: inverse });
          return inverse;
        }
        bus.emit({ type: "action.decided", action: inverse });
        if (decision.outcome === "deny") {
          return inverse;
        }
        const executed = await executeUndo(inverse, actionId, original);
        return context ? executed : (await store.actions.get(actionId))!;
      }),
  };
}
