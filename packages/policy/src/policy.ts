import {
  type ActionCategory,
  type ActionRequest,
  BASE_REVERSIBILITY,
  BASE_RISK,
  compareTrust,
  DEFAULT_POLICY_CONFIG,
  type EventBus,
  type GlobalPolicyConfig,
  minTrust,
  type OutcomeFeedback,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyOutcome,
  type PromotionOffer,
  type RiskLevel,
  type Store,
  type Timestamp,
  TRUST_LEVELS,
  type TrustLevel,
  type TrustStage,
  type TrustState,
} from "@passport/types";
import { PolicyError } from "./errors.js";
import { readLaneOf } from "./executor-shared.js";

/** Collaborators are injected; the clock returns an ISO timestamp. */
export interface PolicyEngineOptions {
  store: Store;
  bus: EventBus;
  now?: () => Timestamp;
  /**
   * Extra per-request trust ceiling, e.g. the permission mode of the task whose run proposed the
   * action. Applied like `externalAgentCeiling`: it can only lower the effective level.
   */
  ceiling?: (
    request: ActionRequest,
  ) => TrustLevel | null | undefined | Promise<TrustLevel | null | undefined>;
}
const categories: ActionCategory[] = [
  "triage",
  "newsletters",
  "receipts",
  "notifications",
  "scheduling",
  "replies_known",
  "replies_stranger",
  "money",
  "legal",
  "unsubscribe",
  "matters",
  "other",
  "profile_update",
];
const risks: RiskLevel[] = ["low", "medium", "high", "critical"];
const day = 86_400_000;
const clamp = (score: number) => Math.min(1, Math.max(0, score));
const stageFor = (state: TrustState): TrustStage =>
  state.approvals + state.rejections < 3 || state.score < 0.5
    ? "learning"
    : state.score < 0.85
      ? "trusted"
      : "autonomous";
const earnedLevel = (stage: TrustStage): TrustLevel =>
  stage === "learning" ? "supervised" : stage === "trusted" ? "auto_accept_edits" : "auto";
interface Metadata {
  everAutonomous?: boolean;
  decayedDays?: number;
  windowLevel?: TrustLevel;
  approvals?: number;
  unchanged?: number;
}

/** Create the policy gate and persistent per-category trust ladder. */
export function createPolicyEngine({
  store,
  bus,
  now = () => new Date().toISOString(),
  ceiling,
}: PolicyEngineOptions): PolicyEngine {
  let queue = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const metaKey = (category: ActionCategory) => `policy:trust:${category}`;
  const readMeta = async (category: ActionCategory): Promise<Metadata> =>
    JSON.parse((await store.kv.get(metaKey(category))) ?? "{}") as Metadata;
  const getConfig = async () =>
    structuredClone((await store.trust.getConfig()) ?? DEFAULT_POLICY_CONFIG);
  const hasHeldSend = async (draftEmailId: string, accountId: string) => {
    let cursor: string | null | undefined;
    do {
      const page = await store.actions.query({ status: ["held"], limit: 100, cursor });
      if (
        page.items.some(
          (action) =>
            action.request.accountId === accountId &&
            action.request.type === "send" &&
            (action.request.params as { draftEmailId?: string }).draftEmailId === draftEmailId,
        )
      ) {
        return true;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  };
  const getTrustFor = async (category: ActionCategory): Promise<TrustState> => {
    const state = (await store.trust.get(category)) ?? {
      category,
      level: "supervised",
      score: 0.3,
      stage: "learning",
      approvals: 0,
      approvalsUnchanged: 0,
      edits: 0,
      rejections: 0,
      lastActivityAt: null,
    };
    state.stage = stageFor(state);
    state.level = state.pinnedLevel ?? earnedLevel(state.stage);
    return state;
  };
  const save = async (state: TrustState, meta: Metadata) => {
    state.score = clamp(state.score);
    state.stage = stageFor(state);
    state.level = state.pinnedLevel ?? earnedLevel(state.stage);
    if (state.stage === "autonomous") {
      meta.everAutonomous = true;
    }
    await store.kv.set(metaKey(state.category), JSON.stringify(meta));
    const saved = await store.trust.upsert(state);
    bus.emit({ type: "trust.changed", state: saved });
    return saved;
  };
  const promotion = async (
    state: TrustState,
    config: GlobalPolicyConfig,
  ): Promise<PromotionOffer | undefined> => {
    const meta = await readMeta(state.category);
    if (
      meta.windowLevel !== state.level ||
      (meta.approvals ?? 0) < 10 ||
      (meta.unchanged ?? 0) / meta.approvals! < 0.9 ||
      compareTrust(state.level, config.globalMode) >= 0
    ) {
      return;
    }
    const key = `policy:promotion:${state.category}:${state.level}`;
    if (await store.kv.get(key)) {
      return;
    }
    const to = TRUST_LEVELS[TRUST_LEVELS.indexOf(state.level) + 1]!;
    const offer: PromotionOffer = {
      category: state.category,
      from: state.level,
      to,
      message: `You've approved ${meta.unchanged} of ${meta.approvals} actions unchanged. Let me handle these at ${to}?`,
      evidence: {
        approvals: meta.approvals!,
        approvalsUnchanged: meta.unchanged!,
        window: `current level: ${state.level}`,
      },
    };
    await store.kv.set(key, JSON.stringify(offer));
    bus.emit({ type: "trust.promotion_offered", offer });
    return offer;
  };
  return {
    getConfig,
    getTrustFor,
    getTrust: () => Promise.all(categories.map(getTrustFor)),
    setConfig: (patch) =>
      serial(async () => {
        const config = { ...(await getConfig()), ...patch };
        if (
          !TRUST_LEVELS.includes(config.globalMode) ||
          !TRUST_LEVELS.includes(config.externalAgentCeiling) ||
          !Number.isFinite(config.outboxHoldMinutes) ||
          config.outboxHoldMinutes < 0 ||
          !Number.isFinite(config.decayAfterDays) ||
          config.decayAfterDays < 0 ||
          !Array.isArray(config.alwaysAsk) ||
          !config.alwaysAsk.every((item) => categories.includes(item))
        ) {
          throw new PolicyError("INVALID_CONFIG", "Invalid global policy configuration");
        }
        await store.trust.setConfig(config);
        return config;
      }),
    pinLevel: (category, level) =>
      serial(async () => {
        if (level !== null && !TRUST_LEVELS.includes(level)) {
          throw new PolicyError("INVALID_LEVEL", "Unknown trust level");
        }
        const state = await getTrustFor(category),
          meta = await readMeta(category);
        state.pinnedLevel = level;
        const next = level ?? earnedLevel(state.stage);
        if (next !== state.level) {
          meta.windowLevel = next;
          meta.approvals = 0;
          meta.unchanged = 0;
        }
        return save(state, meta);
      }),
    evaluate: (request) =>
      serial(async () => {
        if (
          !Object.hasOwn(BASE_RISK, request.type) ||
          !categories.includes(request.category) ||
          !["human", "agent", "external-agent"].includes(request.actor?.kind)
        ) {
          throw new PolicyError("INVALID_ACTION", "Unknown action type, category, or actor");
        }
        const config = await getConfig(),
          state = await getTrustFor(request.category);
        let trustLevel = minTrust(config.globalMode, state.pinnedLevel ?? state.level);
        const external = request.actor.kind === "external-agent";
        if (external) {
          trustLevel = minTrust(trustLevel, config.externalAgentCeiling);
        }
        const requestCeiling = await ceiling?.(request);
        if (requestCeiling) {
          trustLevel = minTrust(trustLevel, requestCeiling);
        }
        const reversibility = BASE_REVERSIBILITY[request.type];
        let riskIndex = risks.indexOf(BASE_RISK[request.type]);
        const destructive = request.type === "delete" || request.destructive === true;
        if (destructive) {
          riskIndex = Math.max(1, riskIndex);
        }
        let selfChange = false,
          knownAddressAddition = false,
          downgradeAcknowledgement = false;
        if (request.type === "person_update") {
          const { personId, patch } =
            request.params as import("@passport/types").ActionParams["person_update"];
          const person = await store.people.get(personId);
          const normalize = (email: string) => email.trim().toLowerCase();
          const previous = new Set(person?.emails.map(normalize) ?? []);
          const next = patch.emails ? new Set(patch.emails.map(normalize)) : previous;
          const changedEmails =
            next.size !== previous.size || [...next].some((email) => !previous.has(email));
          selfChange =
            (person?.relationship === "self" &&
              (changedEmails ||
                (patch.relationship !== undefined &&
                  patch.relationship !== person.relationship))) ||
            (patch.relationship === "self" &&
              (person?.relationship !== "self" || !person.verifiedSelf || !patch.stats));
          knownAddressAddition =
            person?.relationship === "known" && [...next].some((email) => !previous.has(email));
          downgradeAcknowledgement =
            patch.downgradeAcknowledgedAt !== undefined &&
            patch.downgradeAcknowledgedAt !== person?.downgradeAcknowledgedAt;
          if (selfChange || knownAddressAddition) {
            riskIndex = Math.max(1, riskIndex);
          }
        }
        if (request.counterparty?.class === "stranger") {
          riskIndex++;
          if (request.type === "send" || request.type.startsWith("calendar_")) {
            riskIndex++;
          }
        }
        if (request.type === "unsubscribe") {
          riskIndex++;
        }
        if (destructive) {
          const ids = (request.params as { emailIds: string[] }).emailIds;
          const emails = await Promise.all(
            ids.map((id) => store.emails.get(id, { lane: readLaneOf(request) })),
          );
          if (emails.some((email) => email && (email.keywords.$flagged || !email.keywords.$seen))) {
            riskIndex++;
          }
        }
        const risk = risks[Math.min(risks.length - 1, riskIndex)]!;
        let bookkeeping =
          request.type.startsWith("matter_") || ["person_update", "snooze"].includes(request.type);
        if (request.type === "label" || request.type === "unlabel") {
          const name = (request.params as { label: string }).label;
          const box = (await store.mailboxes.list(request.accountId)).find((box) =>
            [box.id, box.providerId, box.name].includes(name),
          );
          // Removing inbox membership archives mail; trash/junk labels are destructive.
          bookkeeping =
            !!box &&
            !["trash", "junk"].includes(box.role ?? "") &&
            !(request.type === "unlabel" && box.role === "inbox");
        }
        if (destructive) {
          bookkeeping = false;
        }
        const heldDraft =
          (request.type === "draft_update" || request.type === "draft_delete") &&
          (await hasHeldSend(
            (request.params as { draftEmailId: string }).draftEmailId,
            request.accountId,
          ));
        let outcome: PolicyOutcome = "ask";
        let reason = "Human approval is required at this trust level.";
        if (
          external &&
          (destructive ||
            selfChange ||
            downgradeAcknowledgement ||
            ["unsubscribe", "calendar_delete"].includes(request.type) ||
            (config.externalAgentCeiling === "supervised" && reversibility !== "reversible"))
        ) {
          outcome = "deny";
          reason = "The external agent ceiling forbids this action.";
        } else if (request.category === "profile_update" && request.actor.kind !== "human") {
          reason = "Profile learning requires the person's approval.";
        } else if (selfChange || knownAddressAddition || downgradeAcknowledgement) {
          reason = "Identity changes and downgrade acknowledgements require human approval.";
        } else if (heldDraft) {
          reason = "This draft is referenced by a held send and requires approval to change.";
        } else if (
          config.alwaysAsk.includes(request.category) &&
          (!bookkeeping || ["label", "unlabel"].includes(request.type))
        ) {
          reason = "This category always requires approval.";
        } else if (trustLevel === "supervised") {
          if (
            reversibility === "reversible" &&
            (request.category === "matters" || request.category === "triage") &&
            ["matter_create", "matter_update", "matter_attach", "person_update", "snooze"].includes(
              request.type,
            )
          ) {
            outcome = "allow";
          }
        } else if (reversibility === "reversible") {
          outcome = "allow";
        } else if (trustLevel === "full_access") {
          outcome = reversibility === "delayed" ? "hold" : risk === "critical" ? "ask" : "allow";
        } else if (trustLevel === "auto") {
          if (reversibility === "delayed" && state.stage !== "learning") {
            outcome = "hold";
          }
          if (reversibility === "irreversible" && state.stage === "autonomous" && riskIndex <= 1) {
            outcome = "allow";
          }
        }
        if (outcome === "allow") {
          reason = "The effective trust level permits this action.";
        }
        if (outcome === "hold") {
          reason = "Trusted outward-facing action; held for cancellation before release.";
        }
        const decision: PolicyDecision = {
          outcome,
          risk,
          reversibility,
          trustLevel,
          category: request.category,
          reason,
        };
        if (outcome === "hold") {
          decision.holdUntil = new Date(
            Date.parse(now()) + config.outboxHoldMinutes * 60_000,
          ).toISOString();
        }
        if (outcome !== "deny") {
          const offer = await promotion(state, config);
          if (offer) {
            decision.promotionOffer = offer;
          }
        }
        return decision;
      }),
    recordOutcome: (actionId, feedback: OutcomeFeedback, editDistance = 0) =>
      serial(async () => {
        const action = await store.actions.get(actionId);
        if (!action) {
          throw new PolicyError("ACTION_NOT_FOUND", `Action ${actionId} does not exist`);
        }
        if (
          !["approved_unchanged", "approved_edited", "rejected"].includes(feedback) ||
          !Number.isFinite(editDistance) ||
          editDistance < 0 ||
          editDistance > 1
        ) {
          throw new PolicyError("INVALID_FEEDBACK", "Feedback or edit distance is invalid");
        }
        const feedbackKey = `policy:feedback:${actionId}`;
        if (await store.kv.get(feedbackKey)) {
          throw new PolicyError("FEEDBACK_RECORDED", "This action already has human feedback");
        }
        const state = await getTrustFor(action.request.category),
          meta = await readMeta(state.category);
        if (state.stage === "autonomous") {
          meta.everAutonomous = true;
        }
        if (meta.windowLevel !== state.level) {
          meta.windowLevel = state.level;
          meta.approvals = 0;
          meta.unchanged = 0;
        }
        if (feedback === "rejected") {
          state.rejections++;
          state.score -= 0.15;
        } else {
          state.approvals++;
          meta.approvals = (meta.approvals ?? 0) + 1;
          if (feedback === "approved_unchanged") {
            state.approvalsUnchanged++;
            state.score += 0.08;
            meta.unchanged = (meta.unchanged ?? 0) + 1;
          } else {
            state.edits++;
            state.score -= Math.max(0.01, 0.04 * editDistance);
          }
        }
        state.lastActivityAt = now();
        meta.decayedDays = 0;
        const oldLevel = state.level;
        const saved = await save(state, meta);
        if (saved.level !== oldLevel) {
          meta.windowLevel = saved.level;
          meta.approvals = 0;
          meta.unchanged = 0;
          await store.kv.set(metaKey(state.category), JSON.stringify(meta));
        }
        await store.kv.set(feedbackKey, feedback);
        return saved;
      }),
    applyDecay: (at = now()) =>
      serial(async () => {
        if (!Number.isFinite(Date.parse(at))) {
          throw new PolicyError("INVALID_TIME", "Decay time must be an ISO timestamp");
        }
        const config = await getConfig(),
          changed: TrustState[] = [];
        for (const raw of await store.trust.list()) {
          const state = await getTrustFor(raw.category);
          if (!state.lastActivityAt) {
            continue;
          }
          const meta = await readMeta(state.category);
          if (state.stage === "autonomous") {
            meta.everAutonomous = true;
          }
          const days = Math.max(
            0,
            Math.floor(
              (Date.parse(at) - Date.parse(state.lastActivityAt)) / day - config.decayAfterDays,
            ),
          );
          const additional = days - (meta.decayedDays ?? 0);
          if (additional <= 0) {
            continue;
          }
          meta.decayedDays = days;
          const score = Math.max(
            Math.min(state.score, meta.everAutonomous ? 0.3 : 0),
            state.score - additional * 0.02,
          );
          if (score === state.score) {
            await store.kv.set(metaKey(state.category), JSON.stringify(meta));
            continue;
          }
          state.score = score;
          const oldLevel = state.level;
          changed.push(await save(state, meta));
          if (oldLevel !== state.level) {
            meta.windowLevel = state.level;
            meta.approvals = 0;
            meta.unchanged = 0;
            await store.kv.set(metaKey(state.category), JSON.stringify(meta));
          }
        }
        return changed;
      }),
  };
}
