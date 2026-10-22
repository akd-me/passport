import { isDeepStrictEqual } from "node:util";
import {
  type ActionExecutor,
  type ActionRecord,
  type ActionRequest,
  BASE_REVERSIBILITY,
  type DraftInput,
  getEffectiveProfile,
} from "@passport/types";
import { PolicyError } from "./errors.js";
import { createExecutorCommands } from "./executor-commands.js";
import { createExecutorContext } from "./executor-context.js";
import { createDispatch } from "./executor-dispatch.js";
import { createMailActions } from "./executor-mail.js";
import { knowledgeInverseOf } from "./executor-notes.js";
import { createRestoration } from "./executor-restoration.js";
import { type ActionExecutorOptions, marker, type Request, snapshotOf } from "./executor-shared.js";
import { newId } from "./id.js";

export type { ActionExecutorOptions } from "./executor-shared.js";

/** Persist, authorize, execute, hold, and undo all mutations through one serialized gate. */
export function createActionExecutor(options: ActionExecutorOptions): ActionExecutor {
  const {
    store,
    bus,
    policy,
    mailProviderFor,
    calendarProviderFor,
    fetch: fetcher,
    resolveDns,
    log,
    now = () => new Date().toISOString(),
  } = options;
  const dependencies = {
    store,
    bus,
    policy,
    mailProviderFor,
    calendarProviderFor,
    fetch: fetcher,
    resolveDns,
    log,
    now,
  };
  let queue = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const context = createExecutorContext(dependencies);
  const { requireAction, claim, requireClaim, resolvedDraft, assertPublic, capture } = context;

  const mail = createMailActions(dependencies);

  const restoration = createRestoration(dependencies, context, mail);

  const settleUnsubscribeParent = async (child: ActionRecord) => {
    const parentId = await store.kv.get(`policy:unsubscribe-parent:${child.id}`);
    if (!parentId || !["executed", "failed", "rejected"].includes(child.status)) {
      return;
    }
    const parent = await store.actions.get(parentId);
    if (parent?.status !== "executing" || parent.result?.childActionId !== child.id) {
      return;
    }
    const status = child.status;
    if (!(await claim(parent, status))) {
      return;
    }
    const updated = await store.actions.update(parentId, {
      status,
      ...(status === "executed"
        ? { executedAt: now() }
        : { error: child.error ?? "Unsubscribe send was rejected" }),
      result: {
        ...parent.result,
        status: status === "executed" ? "sent" : status,
        ...(child.result?.warning ? { warning: child.result.warning } : {}),
      },
    });
    bus.emit({
      type:
        status === "executed"
          ? "action.executed"
          : status === "failed"
            ? "action.failed"
            : "action.decided",
      action: updated,
    });
  };
  const dispatched = createDispatch(dependencies, context, mail, restoration, {
    submitAction: (request, onCreated) => submitAction(request, onCreated),
    settleUnsubscribeParent,
  });
  const { dispatch } = dispatched;
  const execute = async (action: ActionRecord, undoOf?: ActionRecord): Promise<ActionRecord> => {
    let current = action;
    try {
      const request = action.request as Request;
      if (!undoOf && (request.type === "send" || request.type === "calendar_propose")) {
        let resolved: DraftInput | undefined;
        try {
          resolved = await resolvedDraft(request);
        } catch (error) {
          // Missing or changed draft references trigger reapproval; unrelated errors propagate.

          if (
            !(error instanceof PolicyError) ||
            !["EMAIL_NOT_FOUND", "NOT_A_DRAFT", "REPLY_NOT_FOUND"].includes(error.code)
          ) {
            throw error;
          }
        }
        if (!action.approvedSnapshot || !isDeepStrictEqual(resolved, action.approvedSnapshot)) {
          const proposed = await store.actions.update(action.id, {
            status: "proposed",
            holdUntil: null,
            error: "DRAFT_CHANGED_SINCE_APPROVAL",
            decision: {
              ...action.decision,
              outcome: "ask",
              reason: "DRAFT_CHANGED_SINCE_APPROVAL",
              holdUntil: null,
            },
          });
          bus.emit({ type: "action.proposed", action: proposed });
          return proposed;
        }
      }
      const snapshot = snapshotOf(request) ? null : await capture(request);
      // Knowledge-only person/matter updates invert to their prior content, like profile_update.
      const knowledge = undoOf ? null : await knowledgeInverseOf(store, request);
      const inverseParams =
        request.type === "profile_update"
          ? { markdown: await getEffectiveProfile(store) }
          : knowledge
            ? knowledge
            : snapshot
              ? { ...request.params, [marker]: snapshot }
              : null;
      const inverse: ActionRequest | null = undoOf
        ? undoOf.request
        : inverseParams
          ? {
              ...structuredClone(request),
              actor: { kind: "human", id: "undo" },
              reason: `Undo: ${request.reason}`,
              params: inverseParams,
            }
          : null;
      const reversibility = undoOf
        ? "reversible"
        : BASE_REVERSIBILITY[request.type] === "delayed"
          ? "irreversible"
          : BASE_REVERSIBILITY[request.type];
      const decision = { ...action.decision, reversibility };
      if (decision.reversibility === "reversible" && !inverse) {
        throw new PolicyError(
          "MISSING_INVERSE",
          "Reversible actions must capture an inverse before execution",
        );
      }
      current = await store.actions.update(action.id, {
        status: "executing",
        decision,
        inverse,
        holdUntil: null,
      });
      const result = await dispatch(request, snapshot, action);
      if (request.type === "unsubscribe" && result.childActionId) {
        return (await store.actions.get(action.id))!;
      }
      current = await store.actions.update(action.id, {
        status: "executed",
        executedAt: now(),
        result,
        inverse,
      });
      bus.emit({ type: "action.executed", action: current });
      await settleUnsubscribeParent(current);
      return current;
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      // A post-execution notification/parent write must not turn a delivered send into a retryable failure.
      if (current.status === "executed") {
        throw error;
      }
      if (
        ["send", "calendar_propose"].includes(action.request.type) &&
        (error as { code?: string } | null)?.code === "SUBMISSION_ACCEPTED"
      ) {
        current = await store.actions.update(action.id, {
          status: "executed",
          executedAt: now(),
          holdUntil: null,
          inverse: null,
          decision: { ...action.decision, reversibility: "irreversible" },
          result: {
            warning: error instanceof Error ? error.message : "SUBMISSION_ACCEPTED",
            code: "SUBMISSION_ACCEPTED",
            messageId: (error as { messageId?: string }).messageId ?? null,
          },
        });
        bus.emit({ type: "action.executed", action: current });
        await settleUnsubscribeParent(current);
        return current;
      }
      current = await store.actions.update(action.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      bus.emit({ type: "action.failed", action: current });
      await settleUnsubscribeParent(current);
      throw error;
    }
  };
  const executeUndo = async (
    action: ActionRecord,
    originalId: string,
    claimedOriginal?: ActionRecord,
  ): Promise<ActionRecord> => {
    const original = claimedOriginal ?? (await requireAction(originalId, ["executed"]));
    if (!claimedOriginal) {
      await requireClaim(original);
    }
    try {
      const executed = await execute(action, original);
      const undone = await store.actions.update(originalId, { status: "undone", undoneAt: now() });
      bus.emit({ type: "action.undone", action: undone });
      return executed;
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      await store.actions.update(originalId, { status: "executed" });
      throw error;
    }
  };
  const holdOrExecute = async (action: ActionRecord): Promise<ActionRecord> => {
    const undoOf = await store.kv.get(`policy:undo:${action.id}`);
    if (undoOf) {
      return executeUndo(action, undoOf);
    }
    if (action.request.type === "send" || action.request.type === "calendar_propose") {
      try {
        action = await store.actions.update(action.id, {
          approvedSnapshot: await resolvedDraft(action.request),
          error: null,
        });
      } catch (error) {
        // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

        const failed = await store.actions.update(action.id, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        bus.emit({ type: "action.failed", action: failed });
        await settleUnsubscribeParent(failed);
        throw error;
      }
    }
    const config = await policy.getConfig();
    if (BASE_REVERSIBILITY[action.request.type] === "delayed" && config.outboxHoldMinutes > 0) {
      const holdUntil = new Date(
        Date.parse(now()) + config.outboxHoldMinutes * 60_000,
      ).toISOString();
      const held = await store.actions.update(action.id, { status: "held", holdUntil });
      bus.emit({ type: "action.held", action: held });
      return held;
    }
    return execute(action);
  };
  // Internal submission avoids re-entering this executor's queue for unsubscribe child sends.
  const submitAction = async (
    request: ActionRequest,
    onCreated?: (action: ActionRecord) => Promise<void>,
  ): Promise<ActionRecord> => {
    await assertPublic(request);
    const decision = await policy.evaluate(request),
      at = now();
    const record = await store.actions.insert({
      id: newId(at),
      request: structuredClone(request),
      decision,
      status:
        decision.outcome === "deny"
          ? "rejected"
          : decision.outcome === "ask"
            ? "proposed"
            : "approved",
      createdAt: at,
      ...(decision.outcome !== "ask" ? { decidedAt: at } : {}),
      ...(decision.outcome === "deny" ? { error: decision.reason } : {}),
    });
    await onCreated?.(record);
    if (decision.outcome === "ask") {
      bus.emit({ type: "action.proposed", action: record });
      return record;
    }
    bus.emit({ type: "action.decided", action: record });
    if (decision.outcome === "deny") {
      return record;
    }
    return holdOrExecute(record);
  };
  return {
    submit: (request) => serial(() => submitAction(request)),
    ...createExecutorCommands(dependencies, context, {
      serial,
      holdOrExecute,
      executeUndo,
      settleUnsubscribeParent,
    }),
    releaseDue: (at = now()) =>
      serial(async () => {
        if (!Number.isFinite(Date.parse(at))) {
          throw new PolicyError("INVALID_TIME", "Release time must be an ISO timestamp");
        }
        const executed: ActionRecord[] = [];
        let firstError: unknown;
        for (const candidate of await store.actions.dueHeld(at)) {
          const current = await store.actions.get(candidate.id);
          if (current?.status !== "held" || !current.holdUntil || current.holdUntil > at) {
            continue;
          }
          try {
            const claimed = await claim(current);
            if (claimed) {
              const result = await execute(claimed);
              if (result.status === "executed") {
                executed.push(result);
              }
            }
          } catch (error) {
            // Outbox release failed; retaining the first error while continuing due actions.
            log?.("Outbox release failed; retaining the first error while continuing due actions");

            firstError ??= error;
          }
        }
        if (firstError) {
          throw firstError;
        }
        return executed;
      }),
  };
}
