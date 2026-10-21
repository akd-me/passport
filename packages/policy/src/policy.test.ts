import {
  type ActorKind,
  type PolicyOutcome,
  type Reversibility,
  TRUST_LEVELS,
  type TrustLevel,
} from "@passport/types";
import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "./policy.js";
import { action, at, draft, email, request, setup, trustState } from "./testing/fixtures.js";

const matrix: Record<TrustLevel, Record<Reversibility, PolicyOutcome>> = {
  supervised: { reversible: "ask", delayed: "ask", irreversible: "ask" },
  auto_accept_edits: { reversible: "allow", delayed: "ask", irreversible: "ask" },
  auto: { reversible: "allow", delayed: "hold", irreversible: "allow" },
  full_access: { reversible: "allow", delayed: "hold", irreversible: "allow" },
};
const examples = {
  reversible: request("archive", { emailIds: ["email"] }),
  delayed: request("send", { draft }),
  irreversible: request("calendar_respond", { eventId: "event", status: "accepted" }),
};
const cases = TRUST_LEVELS.flatMap((level) =>
  (Object.keys(examples) as Reversibility[]).flatMap((reversibility) =>
    (["human", "agent", "external-agent"] as ActorKind[]).map((actor) => ({
      level,
      reversibility,
      actor,
      expected: matrix[level][reversibility],
    })),
  ),
);

describe("policy decision matrix", () => {
  it.each(cases)(
    "$level / $reversibility / $actor -> $expected",
    async ({ level, reversibility, actor, expected }) => {
      const { store, policy } = await setup();
      await store.trust.upsert(trustState({ pinnedLevel: level }));
      const decision = await policy.evaluate({
        ...examples[reversibility],
        actor: { kind: actor, id: "test" },
      });
      expect(decision).toMatchObject({ outcome: expected, reversibility, trustLevel: level });
      if (expected === "hold") expect(decision.holdUntil).toBe("2026-10-20T12:05:00.000Z");
    },
  );

  it.each(["matters", "triage"] as const)(
    "allows only internal reversible work in supervised %s",
    async (category) => {
      const { policy } = await setup();
      await policy.setConfig({ globalMode: "supervised" });
      expect(
        (
          await policy.evaluate(
            request(
              "matter_update",
              { matterId: "matter", patch: { summary: "Updated" } },
              { category },
            ),
          )
        ).outcome,
      ).toBe("allow");
      expect(
        (await policy.evaluate(request("archive", { emailIds: ["email"] }, { category }))).outcome,
      ).toBe("ask");
    },
  );

  it("caps category pins by the global mode and external ceiling", async () => {
    const { policy } = await setup();
    await policy.setConfig({ globalMode: "auto", externalAgentCeiling: "auto_accept_edits" });
    expect((await policy.evaluate(examples.delayed)).trustLevel).toBe("auto");
    expect(
      await policy.evaluate({ ...examples.delayed, actor: { kind: "external-agent", id: "mcp" } }),
    ).toMatchObject({ outcome: "ask", trustLevel: "auto_accept_edits" });
  });

  it.each(["delete", "unsubscribe", "calendar_delete"] as const)(
    "denies external-agent %s at every level",
    async (type) => {
      const { policy } = await setup();
      const params =
        type === "delete"
          ? { emailIds: ["email"] }
          : type === "unsubscribe"
            ? { emailId: "email", method: "header" as const }
            : { eventId: "event" };
      expect(
        (
          await policy.evaluate(
            request(type, params, { actor: { kind: "external-agent", id: "mcp" } }),
          )
        ).outcome,
      ).toBe("deny");
    },
  );

  it("denies non-reversible external work at a supervised ceiling", async () => {
    const { policy } = await setup();
    await policy.setConfig({ externalAgentCeiling: "supervised" });
    for (const example of [examples.delayed, examples.irreversible])
      expect(
        (await policy.evaluate({ ...example, actor: { kind: "external-agent", id: "mcp" } }))
          .outcome,
      ).toBe("deny");
    expect(
      (
        await policy.evaluate({
          ...examples.reversible,
          actor: { kind: "external-agent", id: "mcp" },
        })
      ).outcome,
    ).toBe("ask");
  });

  it("F5 requires approval for reversible and outward-facing alwaysAsk work even at full access", async () => {
    const { policy } = await setup();
    await policy.pinLevel("money", "full_access");
    for (const example of [examples.delayed, examples.irreversible])
      expect((await policy.evaluate({ ...example, category: "money" })).outcome).toBe("ask");
    expect((await policy.evaluate({ ...examples.reversible, category: "money" })).outcome).toBe(
      "ask",
    );
  });

  it.each(TRUST_LEVELS)(
    "F5 requires approval for legal delete and draft edits at %s",
    async (level) => {
      const { policy } = await setup();
      await policy.pinLevel("legal", level);
      expect(
        (await policy.evaluate(request("delete", { emailIds: ["email"] }, { category: "legal" })))
          .outcome,
      ).toBe("ask");
      expect(
        (await policy.evaluate(request("draft_create", { draft }, { category: "legal" }))).outcome,
      ).toBe("ask");
    },
  );

  it("R1 exempts internal bookkeeping but all always-ask mailbox edits require approval", async () => {
    const { policy, store } = await setup();
    await policy.pinLevel("legal", "full_access");
    for (const operation of [
      request("matter_update", { matterId: "matter", patch: {} }, { category: "legal" }),
      request("person_update", { personId: "person", patch: {} }, { category: "legal" }),
      request(
        "snooze",
        { emailIds: ["email"], until: "2099-01-01T00:00:00.000Z" },
        { category: "legal" },
      ),
    ])
      expect((await policy.evaluate(operation)).outcome).toBe("allow");
    const trash = (await store.mailboxes.get("trash"))!;
    await store.mailboxes.upsertMany([
      { ...trash, id: "junk", providerId: "remote-junk", name: "Junk", role: "junk" },
    ]);
    for (const label of ["tag", "trash", "remote-trash", "Junk", "inbox"]) {
      expect(
        (
          await policy.evaluate(
            request(
              label === "inbox" ? "unlabel" : "label",
              { emailIds: ["email"], label },
              { category: "legal" },
            ),
          )
        ).outcome,
      ).toBe("ask");
    }
  });

  it("forces novelty into learning and auto delayed work asks until trusted", async () => {
    const { policy, store } = await setup();
    await store.trust.upsert(
      trustState({ pinnedLevel: "auto", approvals: 2, approvalsUnchanged: 2 }),
    );
    expect((await policy.getTrustFor("other")).stage).toBe("learning");
    expect((await policy.evaluate(examples.delayed)).outcome).toBe("ask");
    await store.trust.upsert(trustState({ pinnedLevel: "auto", score: 0.6 }));
    expect((await policy.evaluate(examples.delayed)).outcome).toBe("hold");
    expect((await policy.evaluate(examples.irreversible)).outcome).toBe("ask");
  });

  it("raises stranger send/calendar risk twice and clamps to critical", async () => {
    const { policy } = await setup();
    const counterparty = { emails: ["stranger@example.com"], class: "stranger" as const };
    expect((await policy.evaluate({ ...examples.reversible, counterparty })).risk).toBe("medium");
    expect((await policy.evaluate({ ...examples.delayed, counterparty })).risk).toBe("critical");
    expect(await policy.evaluate({ ...examples.irreversible, counterparty })).toMatchObject({
      risk: "critical",
      outcome: "ask",
    });
    expect(
      (await policy.evaluate(request("unsubscribe", { emailId: "email", method: "link" }))).risk,
    ).toBe("high");
  });

  it.each([
    { keywords: {}, risk: "high" },
    { keywords: { $seen: true }, risk: "medium" },
    { keywords: { $seen: true, $flagged: true }, risk: "high" },
  ])("raises delete risk for unread or flagged mail: $risk", async ({ keywords, risk }) => {
    const { policy, store } = await setup();
    await store.emails.upsertMany([email({ keywords })]);
    expect((await policy.evaluate(request("delete", { emailIds: ["email"] }))).risk).toBe(risk);
  });

  it("validates configuration without persisting invalid values", async () => {
    const { policy } = await setup();
    await expect(policy.setConfig({ outboxHoldMinutes: -1 })).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    expect((await policy.getConfig()).outboxHoldMinutes).toBe(5);
    const config = await policy.getConfig();
    config.alwaysAsk.push("other");
    expect((await policy.getConfig()).alwaysAsk).not.toContain("other");
  });
});

describe("trust ladder", () => {
  it("starts at 0.3 supervised and earns trusted then autonomous levels", async () => {
    const { store, policy, bus } = await setup();
    expect(await policy.getTrustFor("receipts")).toMatchObject({
      score: 0.3,
      stage: "learning",
      level: "supervised",
      lastActivityAt: null,
    });
    for (let i = 0; i < 8; i++) {
      await store.actions.insert(action(`approval-${i}`, "receipts"));
      await policy.recordOutcome(`approval-${i}`, "approved_unchanged");
      if (i === 1) expect((await policy.getTrustFor("receipts")).stage).toBe("learning");
      if (i === 2)
        expect(await policy.getTrustFor("receipts")).toMatchObject({
          stage: "trusted",
          level: "auto_accept_edits",
        });
    }
    expect(await policy.getTrustFor("receipts")).toMatchObject({
      stage: "autonomous",
      level: "auto",
      approvals: 8,
    });
    expect(bus.events.filter((event) => event.type === "trust.changed")).toHaveLength(8);
    expect(await policy.getTrust()).toHaveLength(12);
  });

  it("uses threshold boundaries, clamps scores, and applies minimum edit penalties", async () => {
    const { policy, store } = await setup();
    for (const [index, score, stage, level] of [
      [0, 0.5, "trusted", "auto_accept_edits"],
      [1, 0.85, "autonomous", "auto"],
    ] as const) {
      await store.trust.upsert(trustState({ score, pinnedLevel: null }));
      expect(await policy.getTrustFor("other")).toMatchObject({ stage, level });
      await store.actions.insert(action(`threshold-${index}`));
    }
    await store.trust.upsert(trustState({ score: 0.99 }));
    expect((await policy.recordOutcome("threshold-0", "approved_unchanged")).score).toBe(1);
    await store.actions.insert(action("edit"));
    expect((await policy.recordOutcome("edit", "approved_edited", 0)).score).toBeCloseTo(0.99);
    await store.actions.insert(action("large-edit"));
    expect((await policy.recordOutcome("large-edit", "approved_edited", 1)).score).toBeCloseTo(
      0.95,
    );
    await store.trust.upsert(trustState({ score: 0.05 }));
    expect((await policy.recordOutcome("threshold-1", "rejected")).score).toBe(0);
    await expect(policy.recordOutcome("threshold-1", "rejected")).rejects.toMatchObject({
      code: "FEEDBACK_RECORDED",
    });
    await expect(policy.recordOutcome("absent", "rejected")).rejects.toMatchObject({
      code: "ACTION_NOT_FOUND",
    });
  });

  it("keeps pinned levels through score changes, and unpinning restores the earned level", async () => {
    const { policy, store } = await setup();
    await policy.pinLevel("other", "full_access");
    await store.actions.insert(action("reject"));
    const state = await policy.recordOutcome("reject", "rejected");
    expect(state).toMatchObject({ level: "full_access", stage: "trusted" });
    expect((await policy.pinLevel("other", null)).level).toBe("auto_accept_edits");
  });

  it("decays only additional inactive days, persists idempotency, and floors formerly autonomous categories", async () => {
    const { policy, store, bus } = await setup();
    await store.trust.upsert(trustState({ pinnedLevel: null, score: 0.9 }));
    expect(await policy.applyDecay("2026-11-03T12:00:00.000Z")).toEqual([]);
    expect((await policy.applyDecay("2026-11-04T12:00:00.000Z"))[0]?.score).toBeCloseTo(0.88);
    const restarted = createPolicyEngine({ store, bus, now: () => at });
    expect(await restarted.applyDecay("2026-11-04T12:00:00.000Z")).toEqual([]);
    expect((await restarted.applyDecay("2026-11-05T12:00:00.000Z"))[0]?.score).toBeCloseTo(0.86);
    expect((await restarted.applyDecay("2027-01-01T12:00:00.000Z"))[0]?.score).toBe(0.3);
    expect(bus.events.filter((event) => event.type === "trust.changed")).toHaveLength(3);
  });

  it("resets the decay cursor on feedback and never decays categories with no activity", async () => {
    const { policy, store, setTime } = await setup();
    await store.trust.upsert(trustState({ category: "receipts", lastActivityAt: null }));
    await policy.applyDecay("2026-11-10T12:00:00.000Z");
    expect((await policy.getTrustFor("receipts")).score).toBe(0.95);
    setTime("2026-11-10T12:00:00.000Z");
    await store.actions.insert(action("fresh"));
    await policy.recordOutcome("fresh", "approved_unchanged");
    expect(await policy.applyDecay("2026-11-24T12:00:00.000Z")).toEqual([]);
    expect((await policy.applyDecay("2026-11-25T12:00:00.000Z"))[0]?.score).toBeCloseTo(0.87);
  });

  it("does not raise a rejected score to the decay floor or emit changes once the floor is reached", async () => {
    const { policy, store, bus } = await setup();
    await policy.applyDecay("2027-01-01T12:00:00.000Z");
    const count = bus.events.length;
    expect(await policy.applyDecay("2027-01-02T12:00:00.000Z")).toEqual([]);
    expect(bus.events).toHaveLength(count);
    await store.actions.insert(action("below-floor"));
    await policy.recordOutcome("below-floor", "rejected");
    expect((await policy.getTrustFor("other")).score).toBeCloseTo(0.15);
    expect(await policy.applyDecay("2027-01-03T12:00:00.000Z")).toEqual([]);
    expect((await policy.getTrustFor("other")).score).toBeCloseTo(0.15);
  });
});

describe("promotion offers", () => {
  it("offers once per level after ten approvals with at least 90% unchanged, surviving restart", async () => {
    const { policy, store, bus } = await setup();
    await policy.pinLevel("other", "supervised");
    for (let i = 0; i < 10; i++) {
      await store.actions.insert(action(`promotion-${i}`));
      await policy.recordOutcome(
        `promotion-${i}`,
        i === 0 ? "approved_edited" : "approved_unchanged",
        0.5,
      );
      if (i === 8)
        expect((await policy.evaluate(examples.reversible)).promotionOffer).toBeUndefined();
    }
    expect((await policy.evaluate(examples.reversible)).promotionOffer).toMatchObject({
      from: "supervised",
      to: "auto_accept_edits",
      evidence: { approvals: 10, approvalsUnchanged: 9 },
    });
    const restarted = createPolicyEngine({ store, bus, now: () => at });
    expect((await restarted.evaluate(examples.reversible)).promotionOffer).toBeUndefined();
    expect(bus.events.filter((event) => event.type === "trust.promotion_offered")).toHaveLength(1);
    await policy.pinLevel("other", "auto_accept_edits");
    expect((await policy.evaluate(examples.reversible)).promotionOffer).toBeUndefined();
    for (let i = 0; i < 10; i++) {
      await store.actions.insert(action(`next-${i}`));
      await policy.recordOutcome(`next-${i}`, "approved_unchanged");
    }
    expect((await policy.evaluate(examples.reversible)).promotionOffer?.from).toBe(
      "auto_accept_edits",
    );
    expect(bus.events.filter((event) => event.type === "trust.promotion_offered")).toHaveLength(2);
  });

  it("does not offer above the global dial or with fewer than 90% unchanged", async () => {
    const { policy, store } = await setup();
    await policy.pinLevel("other", "supervised");
    for (let i = 0; i < 10; i++) {
      await store.actions.insert(action(`low-${i}`));
      await policy.recordOutcome(`low-${i}`, i < 2 ? "approved_edited" : "approved_unchanged");
    }
    expect((await policy.evaluate(examples.reversible)).promotionOffer).toBeUndefined();
    await policy.setConfig({ globalMode: "supervised" });
    for (let i = 0; i < 10; i++) {
      await store.actions.insert(action(`more-${i}`));
      await policy.recordOutcome(`more-${i}`, "approved_unchanged");
    }
    expect((await policy.evaluate(examples.reversible)).promotionOffer).toBeUndefined();
  });
});
