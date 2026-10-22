import {
  type ActionExecutor,
  type ActionRecord,
  type ActionRequest,
  type ApprovalScope,
  type ApprovalScopeResult,
  compareTrust,
  type Reversibility,
  type RiskLevel,
  type Task,
  type TaskApprovalGrant,
  type TrustLevel,
} from "@passport/types";
import { ApiError } from "../errors.js";
import { logger } from "../logger.js";
import type { TaskService } from "./service.js";
import { clip, neutralize } from "./untrusted.js";

/**
 * The policy reason when only the trust level asked (no identity change, held draft, always-ask
 * category or external ceiling). Grants never cover proposals asked for any other reason.
 */
export const LEVEL_ONLY_REASON = "Human approval is required at this trust level.";
/** The level `always` pins: reversible actions then run without asking. */
const ALWAYS_LEVEL: TrustLevel = "auto_accept_edits";
const MAX_GRANTS = 50;
const RISKS: RiskLevel[] = ["low", "medium", "high", "critical"];
const REVERSIBILITY: Reversibility[] = ["reversible", "delayed", "irreversible"];

/** True when `action` is no riskier, no less reversible and at no lower trust than the grant. */
export function grantCovers(grant: TaskApprovalGrant, action: ActionRecord): boolean {
  const { decision, request } = action;
  return (
    grant.category === request.category &&
    compareTrust(decision.trustLevel, grant.trustLevel) >= 0 &&
    RISKS.indexOf(decision.risk) <= RISKS.indexOf(grant.risk) &&
    REVERSIBILITY.indexOf(decision.reversibility) <= REVERSIBILITY.indexOf(grant.reversibility)
  );
}

/**
 * Approval scopes (`POST /api/actions/:id/approve` `{ scope }`): "approve for this task" grants
 * on the Task, consulted by the runner when one of the task's runs proposes an action, and
 * "always", which pins the category's trust level when the ladder can express it.
 */
export class TaskApprovals {
  constructor(
    private readonly service: TaskService,
    private readonly executor: ActionExecutor,
  ) {}

  /** The task whose run proposed `action`, or null for actions outside tasks. */
  async taskOf(action: ActionRecord): Promise<Task | null> {
    const runId = action.request.runId;
    if (!runId) {
      return null;
    }
    const runs = this.service.tasks.runs;
    const run = (await runs.byActionId?.(action.id, runId)) ?? (await runs.byAgentRunId(runId));
    return run ? this.service.tasks.get(run.taskId) : null;
  }

  async approve(
    original: ActionRecord,
    edited: ActionRequest | undefined,
    scope: ApprovalScope,
  ): Promise<ActionRecord & { approvalScope: ApprovalScopeResult }> {
    const task = await this.taskOf(original);
    const pin = scope === "always" ? await this.pinFor(original) : null;
    if (!task && (scope === "task" || !pin?.level)) {
      throw new ApiError(
        "NOT_A_TASK_ACTION",
        "Only actions proposed by a task can be approved for that task",
      );
    }
    const approved = await this.executor.approve(original.id, edited);
    const result: ApprovalScopeResult = { requested: scope, applied: "task" };
    if (pin?.level) {
      await this.service.options.policy.pinLevel(original.request.category, pin.level);
      Object.assign(result, { applied: "always", pinnedLevel: pin.level });
    } else if (pin) {
      result.code = "ALWAYS_UNAVAILABLE";
    }
    if (task) {
      result.taskId = task.id;
      await this.grant(task, original);
      await this.notice(task.id, original, result, pin?.why);
    }
    return { ...approved, approvalScope: result };
  }

  /**
   * Runner hook: approves a proposal of one of the task's runs when a grant covers it. Never in
   * plan mode or for a settled or archived task, never for proposals asked for a reason other
   * than the trust level, and never above the level the grant recorded (`grantCovers`). The
   * approval does not count as the person's feedback, so it never trains the trust ladder.
   */
  async autoApprove(taskId: string, action: ActionRecord): Promise<ActionRecord | null> {
    if (
      action.status !== "proposed" ||
      action.request.actor.kind !== "agent" ||
      action.decision.outcome !== "ask" ||
      action.decision.reason !== LEVEL_ONLY_REASON
    ) {
      return null;
    }
    const task = await this.service.tasks.get(taskId);
    if (
      !task ||
      task.interactionMode === "plan" ||
      task.status === "settled" ||
      task.status === "archived" ||
      !task.approvalGrants?.some((grant) => grantCovers(grant, action))
    ) {
      return null;
    }
    const kv = this.service.options.store.kv;
    const feedbackKey = `policy:feedback:${action.id}`;
    try {
      // The executor records feedback once per record; marking it first keeps the ladder untouched.
      await kv.set(feedbackKey, "task_scope");
      const approved = await this.executor.approve(action.id);
      await this.service.runner.appendItem({
        taskId,
        runId: null,
        kind: "system_notice",
        at: this.service.now(),
        untrusted: true,
        payload: {
          text: clip(neutralize(`Approved for this task: ${action.request.reason}`)),
          code: "TASK_APPROVED",
        },
      });
      return approved;
    } catch {
      // Fall back to asking the person; the proposal stays pending.
      await kv.delete(feedbackKey).catch(() => undefined);
      logger.warn("Task-scoped approval failed; asking instead");
      return null;
    }
  }

  private async grant(task: Task, action: ActionRecord): Promise<void> {
    const grant: TaskApprovalGrant = {
      category: action.request.category,
      actionId: action.id,
      trustLevel: action.decision.trustLevel,
      risk: action.decision.risk,
      reversibility: action.decision.reversibility,
      grantedAt: this.service.now(),
    };
    await this.service.runner.updateTask(task.id, (current) => ({
      approvalGrants: [...(current.approvalGrants ?? []), grant].slice(-MAX_GRANTS),
    }));
  }

  /**
   * The trust pin `always` maps to: `auto_accept_edits` for a reversible action asked for only
   * by the ladder's level. Sends and irreversible actions, other policy rules, and asks that
   * came from the global mode or the task's mode (the ladder already allows) have no pin.
   */
  private async pinFor(action: ActionRecord): Promise<{ level?: TrustLevel; why?: string }> {
    const { decision, request } = action;
    if (decision.reason !== LEVEL_ONLY_REASON) {
      return { why: "a policy rule other than the trust level asked" };
    }
    if (decision.reversibility !== "reversible") {
      return { why: "it sends mail or can't be undone" };
    }
    const policy = this.service.options.policy;
    if (compareTrust((await policy.getConfig()).globalMode, ALWAYS_LEVEL) < 0) {
      return { why: "your global mode asks before every action" };
    }
    const state = await policy.getTrustFor(request.category);
    if (compareTrust(state.level, ALWAYS_LEVEL) >= 0) {
      return { why: "your global mode or this task's permission mode asked, not the trust level" };
    }
    return { level: ALWAYS_LEVEL };
  }

  private async notice(
    taskId: string,
    action: ActionRecord,
    result: ApprovalScopeResult,
    why?: string,
  ): Promise<void> {
    const category = action.request.category;
    const text = result.pinnedLevel
      ? `Approved always: ${category} actions that can be undone now run without asking (trust level pinned to ${result.pinnedLevel}). This task also stops asking for them.`
      : result.code
        ? `"Always" isn't available for ${category} here (${why}). Approved for the rest of this task instead.`
        : `Approved for the rest of this task: ${category} actions like this one run without asking.`;
    await this.service.runner.appendItem({
      taskId,
      runId: null,
      kind: "system_notice",
      at: this.service.now(),
      payload: { text, code: result.code ?? "APPROVAL_SCOPE" },
    });
  }
}
