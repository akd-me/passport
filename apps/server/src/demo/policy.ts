import {
  BASE_REVERSIBILITY,
  BASE_RISK,
  DEFAULT_POLICY_CONFIG,
  TRUST_LEVELS,
  minTrust,
} from "@passport/types";
import type {
  EventBus,
  PolicyEngine,
  Store,
  TrustLevel,
} from "@passport/types";
import { required } from "../errors.js";

/** Toy trust model for the demo; production risk and promotion logic lives in @passport/policy. */
export function createDemoPolicy(store: Store, bus: EventBus): PolicyEngine {
  const policy: PolicyEngine = {
    getConfig: async () =>
      (await store.trust.getConfig()) ?? structuredClone(DEFAULT_POLICY_CONFIG),
    setConfig: async (patch) => {
      const config = { ...(await policy.getConfig()), ...patch };
      await store.trust.setConfig(config);
      return config;
    },
    getTrust: () => store.trust.list(),
    getTrustFor: async (category) =>
      required(await store.trust.get(category), "Trust category"),
    pinLevel: async (category, level) => {
      const state = await store.trust.upsert({
        ...(await policy.getTrustFor(category)),
        pinnedLevel: level,
      });
      bus.emit({ type: "trust.changed", state });
      return state;
    },
    evaluate: async (request) => {
      const config = await policy.getConfig(),
        state = await policy.getTrustFor(request.category);
      let trustLevel = state.pinnedLevel
        ? minTrust(config.globalMode, state.pinnedLevel)
        : config.globalMode;
      if (request.actor.kind === "external-agent")
        trustLevel = minTrust(trustLevel, config.externalAgentCeiling);
      const reversibility = BASE_REVERSIBILITY[request.type];
      let outcome: "ask" | "allow" | "hold" | "deny" = "ask";
      if (request.actor.kind === "human") outcome = "allow";
      else if (!config.alwaysAsk.includes(request.category)) {
        if (
          trustLevel === "full_access" ||
          (trustLevel === "auto" && state.score >= 0.75) ||
          (trustLevel === "auto_accept_edits" && reversibility === "reversible")
        )
          outcome = "allow";
      }
      if (
        request.actor.kind === "external-agent" &&
        reversibility === "irreversible"
      )
        outcome = "deny";
      if (
        outcome === "allow" &&
        reversibility === "delayed" &&
        config.outboxHoldMinutes > 0
      )
        outcome = "hold";
      return {
        outcome,
        trustLevel,
        category: request.category,
        risk: BASE_RISK[request.type],
        reversibility,
        reason:
          outcome === "ask"
            ? "A human decision is needed at this trust level."
            : outcome === "hold"
              ? "Ready to send after your outbox safety window."
              : "Allowed by your demo trust policy.",
        holdUntil:
          outcome === "hold"
            ? new Date(
                Date.now() + config.outboxHoldMinutes * 60000,
              ).toISOString()
            : null,
        promotionOffer:
          request.category === "newsletters"
            ? {
                category: "newsletters",
                from: "auto_accept_edits",
                to: "auto",
                message:
                  "Your newsletter decisions have been consistent. Ready to give Passport a little more room?",
                evidence: {
                  approvals: 27,
                  approvalsUnchanged: 25,
                  window: "30 days",
                },
              }
            : null,
      };
    },
    recordOutcome: async (id, feedback) => {
      const action = required(await store.actions.get(id), "Action"),
        old = await policy.getTrustFor(action.request.category);
      const approved = feedback !== "rejected",
        unchanged = feedback === "approved_unchanged";
      const score = Math.max(
        0,
        Math.min(1, old.score + (unchanged ? 0.025 : approved ? -0.03 : -0.08)),
      );
      const stage =
        score >= 0.9 ? "autonomous" : score >= 0.7 ? "trusted" : "learning";
      const level: TrustLevel =
        stage === "autonomous"
          ? "auto"
          : stage === "trusted"
            ? "auto_accept_edits"
            : "supervised";
      const state = await store.trust.upsert({
        ...old,
        score,
        stage,
        level,
        approvals: old.approvals + Number(approved),
        approvalsUnchanged: old.approvalsUnchanged + Number(unchanged),
        edits: old.edits + Number(approved && !unchanged),
        rejections: old.rejections + Number(!approved),
        lastActivityAt: new Date().toISOString(),
      });
      bus.emit({ type: "trust.changed", state });
      return state;
    },
    applyDecay: async (now = new Date().toISOString()) => {
      const config = await policy.getConfig(),
        day = now.slice(0, 10);
      if ((await store.kv.get("demo.decay-day")) === day)
        return policy.getTrust();
      for (const state of await policy.getTrust())
        if (
          state.lastActivityAt &&
          Date.parse(now) - Date.parse(state.lastActivityAt) >
            config.decayAfterDays * 86400000
        ) {
          const score = Math.max(0, state.score - 0.01);
          const updated = await store.trust.upsert({
            ...state,
            score,
            stage:
              score >= 0.9
                ? "autonomous"
                : score >= 0.7
                  ? "trusted"
                  : "learning",
            level:
              score >= 0.9
                ? TRUST_LEVELS[2]!
                : score >= 0.7
                  ? TRUST_LEVELS[1]!
                  : TRUST_LEVELS[0]!,
          });
          bus.emit({ type: "trust.changed", state: updated });
        }
      await store.kv.set("demo.decay-day", day);
      return policy.getTrust();
    },
  };
  return policy;
}
