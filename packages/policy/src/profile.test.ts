import { expect, it } from "vitest";
import { request, setup } from "./testing/fixtures.js";

it("executes a profile update with an ordinary reversible profile_update inverse", async () => {
  const { executor, store, policy } = await setup();
  await policy.pinLevel("matters", "full_access");
  const before = "# USER.md\n\n## Standing rules\n- Ask first.\n";
  await store.kv.set("user_profile", before);
  const action = await executor.submit(
    request(
      "profile_update",
      { markdown: "# USER.md\nNew instructions." },
      { category: "matters" },
    ),
  );
  expect(action).toMatchObject({
    status: "executed",
    decision: { reversibility: "reversible", risk: "low" },
    inverse: { type: "profile_update", params: { markdown: before } },
  });
  expect(await store.kv.get("user_profile")).toBe("# USER.md\nNew instructions.");
  await executor.undo(action.id);
  expect(await store.kv.get("user_profile")).toBe(before);
});

it("leaves USER.md unchanged until a proposed update is approved", async () => {
  const { executor, store, policy } = await setup();
  await policy.pinLevel("matters", "supervised");
  const action = await executor.submit(
    request("profile_update", { markdown: "New profile" }, { category: "matters" }),
  );
  expect(action.status).toBe("proposed");
  expect(await store.kv.get("user_profile")).toBeNull();
  await store.kv.set("user_profile", "Edited while pending");
  await executor.approve(action.id);
  await executor.undo(action.id);
  expect(await store.kv.get("user_profile")).toBe("Edited while pending");
});

it("R12 captures and restores the complete default profile on the first edit", async () => {
  const { DEFAULT_USER_PROFILE } = await import("@passport/types");
  const { executor, store, policy } = await setup();
  await policy.pinLevel("matters", "full_access");
  const action = await executor.submit(
    request("profile_update", { markdown: "New profile" }, { category: "matters" }),
  );
  expect(action.inverse?.params).toEqual({ markdown: DEFAULT_USER_PROFILE });
  await executor.undo(action.id);
  expect(await store.kv.get("user_profile")).toBe(DEFAULT_USER_PROFILE);
});

it.each(["supervised", "auto_accept_edits", "auto", "full_access"] as const)(
  "learned profiles always ask at %s, then approve and undo through the executor",
  async (level) => {
    const { executor, store, policy } = await setup();
    await policy.setConfig({ globalMode: level, alwaysAsk: [] });
    await policy.pinLevel("profile_update", level);
    const before = "# USER.md\n\n## Voice\nOld voice\n";
    await store.kv.set("user_profile", before);
    const action = await executor.submit(
      request("profile_update", { markdown: "Learned voice" }, { category: "profile_update" }),
    );
    expect(action).toMatchObject({
      status: "proposed",
      decision: {
        reversibility: "reversible",
        reason: "Profile learning requires the person's approval.",
      },
    });
    expect(await store.kv.get("user_profile")).toBe(before);
    await executor.approve(action.id);
    expect(await store.kv.get("user_profile")).toBe("Learned voice");
    await executor.undo(action.id);
    expect(await store.kv.get("user_profile")).toBe(before);
  },
);
