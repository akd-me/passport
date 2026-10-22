import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "./policy.js";
import { at, request, trustState } from "./testing/fixtures.js";
import { createMemoryEventBus, createMemoryStore } from "./testing/memory-store.js";

describe("per-request ceiling", () => {
  it("lowers the effective level for matching requests only", async () => {
    const store = createMemoryStore();
    const policy = createPolicyEngine({
      store,
      bus: createMemoryEventBus(),
      now: () => at,
      ceiling: async (req) => (req.runId === "supervised-task-run" ? "supervised" : null),
    });
    await policy.setConfig({ globalMode: "full_access" });
    await store.trust.upsert(trustState({ pinnedLevel: "full_access" }));
    const archive = request("archive", { emailIds: ["email"] });
    expect(await policy.evaluate(archive)).toMatchObject({ outcome: "allow" });
    expect(await policy.evaluate({ ...archive, runId: "supervised-task-run" })).toMatchObject({
      outcome: "ask",
      trustLevel: "supervised",
    });
  });
});
