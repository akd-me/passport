import type { ActionExecutor, ActionRecord, EventBus, PolicyEngine, Store } from "@passport/types";
import { BASE_REVERSIBILITY } from "@passport/types";
import { ApiError, required } from "../errors.js";
import { logger } from "../logger.js";
import { createDemoApply } from "./executor-apply.js";
import { now } from "./executor-shared.js";

/** In-memory action gate. Unsupported mutations fail visibly; nothing is sent to a network. */
export function createDemoExecutor(
  store: Store,
  policy: PolicyEngine,
  bus: EventBus,
): ActionExecutor {
  const restorers = new Map<string, () => Promise<void>>(),
    busy = new Set<string>();
  async function lock<T>(id: string, task: () => Promise<T>): Promise<T> {
    if (busy.has(id)) {
      throw new ApiError("ACTION_BUSY", "This action is already being processed", 409);
    }
    busy.add(id);
    try {
      return await task();
    } finally {
      busy.delete(id);
    }
  }
  async function get(id: string, status: ActionRecord["status"]): Promise<ActionRecord> {
    const record = required(await store.actions.get(id), "Action");
    if (record.status !== status) {
      throw new ApiError("INVALID_ACTION_STATE", `Expected ${status}, found ${record.status}`, 409);
    }
    return record;
  }
  const apply = createDemoApply(store, bus, restorers);
  async function execute(record: ActionRecord): Promise<ActionRecord> {
    await store.actions.update(record.id, { status: "executing" });
    try {
      const inverse = await apply(record);
      const action = await store.actions.update(record.id, {
        status: "executed",
        inverse,
        executedAt: now(),
        holdUntil: null,
        decision: {
          ...record.decision,
          reversibility: inverse ? "reversible" : "irreversible",
        },
      });
      bus.emit({ type: "action.executed", action });
      return action;
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      const action = await store.actions.update(record.id, {
        status: "failed",
        error: error instanceof ApiError ? error.message : "Demo execution failed",
      });
      bus.emit({ type: "action.failed", action });
      throw error;
    }
  }
  async function approved(record: ActionRecord): Promise<ActionRecord> {
    const config = await policy.getConfig();
    if (BASE_REVERSIBILITY[record.request.type] === "delayed" && config.outboxHoldMinutes > 0) {
      const holdUntil = new Date(Date.now() + config.outboxHoldMinutes * 60000).toISOString();
      const action = await store.actions.update(record.id, {
        status: "held",
        holdUntil,
        decision: { ...record.decision, outcome: "hold", holdUntil },
      });
      bus.emit({ type: "action.held", action });
      return action;
    }
    return execute(record);
  }
  const executor: ActionExecutor = {
    submit: async (request) => {
      const decision = await policy.evaluate(request);
      const record = await store.actions.insert({
        id: crypto.randomUUID(),
        request,
        decision,
        status: decision.outcome === "deny" ? "rejected" : "proposed",
        createdAt: now(),
      });
      if (decision.outcome === "ask" || decision.outcome === "deny") {
        bus.emit({ type: "action.proposed", action: record });
      }
      if (decision.promotionOffer) {
        bus.emit({
          type: "trust.promotion_offered",
          offer: decision.promotionOffer,
        });
      }
      return decision.outcome === "allow" || decision.outcome === "hold"
        ? approved(record)
        : record;
    },
    approve: (id, edited) =>
      lock(id, async () => {
        const record = await get(id, "proposed");
        if (
          edited &&
          (edited.type !== record.request.type || edited.accountId !== record.request.accountId)
        ) {
          throw new ApiError(
            "INVALID_EDIT",
            "Edited approvals must preserve action type and account",
          );
        }
        const changed =
          edited && JSON.stringify(edited.params) !== JSON.stringify(record.request.params);
        const action = await store.actions.update(id, {
          request: edited ? { ...record.request, params: edited.params } : record.request,
          status: "approved",
          decidedAt: now(),
          editDistance: changed ? 0.25 : 0,
        });
        await policy.recordOutcome(id, changed ? "approved_edited" : "approved_unchanged");
        bus.emit({ type: "action.decided", action });
        return approved(action);
      }),
    reject: (id, reason) =>
      lock(id, async () => {
        await get(id, "proposed");
        const action = await store.actions.update(id, {
          status: "rejected",
          decidedAt: now(),
          error: reason ?? null,
        });
        await policy.recordOutcome(id, "rejected");
        bus.emit({ type: "action.decided", action });
        return action;
      }),
    cancelHold: (id) =>
      lock(id, async () => {
        await get(id, "held");
        const action = await store.actions.update(id, {
          status: "rejected",
          decidedAt: now(),
          holdUntil: null,
          error: "Cancelled before release",
        });
        bus.emit({ type: "action.decided", action });
        return action;
      }),
    undo: (id) =>
      lock(id, async () => {
        const record = await get(id, "executed");
        if (!record.inverse || !restorers.has(id)) {
          throw new ApiError("NOT_UNDOABLE", "This action cannot be undone", 409);
        }
        const inverseRecord = await store.actions.insert({
          id: crypto.randomUUID(),
          request: record.inverse,
          decision: {
            ...record.decision,
            outcome: "allow",
            reversibility: "reversible",
          },
          status: "executing",
          createdAt: now(),
        });
        await restorers.get(id)!();
        const undoAction = await store.actions.update(inverseRecord.id, {
          status: "executed",
          executedAt: now(),
          inverse: record.request,
          result: { undoes: id },
        });
        restorers.set(inverseRecord.id, async () => {
          await apply(record);
        });
        bus.emit({ type: "action.executed", action: undoAction });
        const action = await store.actions.update(id, {
          status: "undone",
          undoneAt: now(),
        });
        bus.emit({ type: "action.undone", action });
        return action;
      }),
    releaseDue: async (at = now()) => {
      const released: ActionRecord[] = [];
      for (const record of await store.actions.dueHeld(at)) {
        if (busy.has(record.id)) {
          continue;
        }
        await lock(record.id, async () => {
          if ((await store.actions.get(record.id))?.status === "held") {
            try {
              released.push(await execute(record));
            } catch {
              // Demo outbox action failed; continuing other due actions.
              logger.warn("Demo outbox action failed; continuing other due actions");

              /* execute persisted failure and emitted action.failed. */
            }
          }
        });
      }
      return released;
    },
  };
  return executor;
}
