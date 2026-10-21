import { describe, expect, it } from "vitest";
import { email, person, request, setup } from "./testing/fixtures.js";

const external = { kind: "external-agent" as const, id: "client-a" };

describe("review findings", () => {
  it.each(["label", "unlabel", "move", "archive", "unarchive", "delete"] as const)(
    "T1 destructive %s uses the delete ceiling and at least medium risk",
    async (type) => {
      const { policy } = await setup();
      const params =
        type === "label" || type === "unlabel"
          ? { emailIds: ["email"], label: "trash" }
          : type === "move"
            ? { emailIds: ["email"], toMailboxId: "trash" }
            : { emailIds: ["email"] };
      expect(
        await policy.evaluate(request(type, params, { actor: external, destructive: true })),
      ).toMatchObject({ outcome: "deny" });
      const decision = await policy.evaluate(request(type, params, { destructive: true }));
      expect(["medium", "high", "critical"]).toContain(decision.risk);
    },
  );

  it("T2 denies external self address/relationship changes even at full access", async () => {
    const { store, executor } = await setup();
    await store.people.upsert(person({ relationship: "self", verifiedSelf: true }));
    for (const patch of [
      { emails: ["friend@example.com", "stranger@example.com"] },
      { relationship: "known" as const },
    ]) {
      expect(
        await executor.submit(
          request(
            "person_update",
            { personId: "person", patch },
            { category: "matters", actor: external },
          ),
        ),
      ).toMatchObject({ status: "rejected", decision: { outcome: "deny" } });
    }
    await store.people.upsert(person({ relationship: "stranger" }));
    expect(
      await executor.submit(
        request(
          "person_update",
          { personId: "person", patch: { relationship: "self" } },
          { actor: external },
        ),
      ),
    ).toMatchObject({ status: "rejected" });
    expect((await store.people.get("person"))?.relationship).toBe("stranger");
  });

  it("T2 self changes always ask and verifiedSelf is minted only after human approval", async () => {
    const { store, policy, executor } = await setup();
    await policy.pinLevel("matters", "full_access");
    await store.people.upsert(person({ relationship: "stranger" }));
    const proposed = await executor.submit(
      request(
        "person_update",
        { personId: "person", patch: { relationship: "self", verifiedSelf: true } },
        { category: "matters", actor: { kind: "human", id: "user" } },
      ),
    );
    expect(proposed.status).toBe("proposed");
    expect((await store.people.get("person"))?.verifiedSelf).toBeUndefined();
    await executor.approve(proposed.id);
    expect(await store.people.get("person")).toMatchObject({
      relationship: "self",
      verifiedSelf: true,
    });
    const add = await executor.submit(
      request("person_update", {
        personId: "person",
        patch: { emails: ["friend@example.com", "alias@example.com"] },
      }),
    );
    expect(add.status).toBe("proposed");
    await executor.approve(add.id);
    expect(await store.people.get("person")).toMatchObject({
      emails: ["friend@example.com", "alias@example.com"],
      verifiedSelf: true,
    });
    await executor.undo(add.id);
    expect((await store.people.get("person"))?.emails).toEqual(["friend@example.com"]);
  });

  it("T2 adding a known address asks, while unchanged addresses and ordinary notes remain bookkeeping", async () => {
    const { store, policy, executor } = await setup();
    await policy.pinLevel("matters", "full_access");
    await store.people.upsert(person());
    const proposed = await executor.submit(
      request(
        "person_update",
        { personId: "person", patch: { emails: ["friend@example.com", "stranger@example.com"] } },
        { category: "matters", actor: external },
      ),
    );
    expect(proposed.status).toBe("proposed");
    expect((await store.people.get("person"))?.emails).toEqual(["friend@example.com"]);
    expect(
      (
        await executor.submit(
          request(
            "person_update",
            {
              personId: "person",
              patch: { emails: ["FRIEND@example.com"], notes: "A colleague", verifiedSelf: true },
            },
            { category: "matters" },
          ),
        )
      ).status,
    ).toBe("executed");
    expect((await store.people.get("person"))?.verifiedSelf).toBeUndefined();
  });

  it("T3 executes an external owner undo from the stored private snapshot, never via public submit", async () => {
    const { executor, policy, store } = await setup();
    await policy.setConfig({ externalAgentCeiling: "auto_accept_edits" });
    const original = await executor.submit(
      request("archive", { emailIds: ["email"] }, { actor: external }),
    );
    await expect(executor.submit(original.inverse!)).rejects.toMatchObject({
      code: "INVALID_PARAMS",
    });
    const inverse = await executor.undo(original.id, { actor: external, reason: "Restore inbox" });
    expect(inverse).toMatchObject({ status: "executed", request: { actor: external } });
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(email().mailboxIds);
    expect((await store.actions.get(original.id))?.status).toBe("undone");
  });

  it("T3 caps external undo, denies other owners below full access, and supports approval of an own undo", async () => {
    const { executor, policy, store } = await setup();
    const original = await executor.submit(
      request("archive", { emailIds: ["email"] }, { actor: external }),
    );
    await policy.setConfig({ externalAgentCeiling: "supervised" });
    expect(
      await executor.undo(original.id, { actor: { ...external, id: "other-client" } }),
    ).toMatchObject({ status: "rejected" });
    const proposed = await executor.undo(original.id, { actor: external });
    expect(proposed).toMatchObject({ status: "proposed", decision: { trustLevel: "supervised" } });
    expect((await store.actions.get(original.id))?.status).toBe("executed");
    await executor.approve(proposed.id);
    expect((await store.actions.get(original.id))?.status).toBe("undone");
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(email().mailboxIds);
  });

  it("T3 permits undo of another actor only when effective trust reaches full access", async () => {
    const { executor, store } = await setup();
    const original = await executor.submit(request("archive", { emailIds: ["email"] }));
    expect(await executor.undo(original.id, { actor: external })).toMatchObject({
      status: "executed",
      decision: { trustLevel: "full_access" },
    });
    expect((await store.actions.get(original.id))?.status).toBe("undone");
  });

  it("T6 downgrade acknowledgement is human approved and external agents cannot clear it", async () => {
    const { executor, store } = await setup();
    await store.people.upsert(
      person({ verification: "green", lastSeenBlueAt: "2026-10-01T00:00:00.000Z" }),
    );
    const patch = { downgradeAcknowledgedAt: "2026-10-20T12:00:00.000Z" };
    expect(
      await executor.submit(
        request("person_update", { personId: "person", patch }, { actor: external }),
      ),
    ).toMatchObject({ status: "rejected" });
    const proposed = await executor.submit(
      request(
        "person_update",
        { personId: "person", patch },
        { actor: { kind: "human", id: "user" } },
      ),
    );
    expect(proposed.status).toBe("proposed");
    await executor.approve(proposed.id);
    expect(await store.people.get("person")).toMatchObject(patch);
  });

  it("T7 creates a missing label inside the action and retains it when undo restores membership", async () => {
    const { executor, mail, store } = await setup();
    const created: string[] = [];
    mail.createMailbox = async (name) => {
      created.push(name);
      return {
        id: "receipts",
        accountId: "account",
        providerId: "remote-receipts",
        name,
        role: null,
        totalEmails: 0,
        unreadEmails: 0,
      };
    };
    const action = await executor.submit(
      request("label", { emailIds: ["email"], label: "Receipts" }),
    );
    expect(action.status).toBe("executed");
    expect(created).toEqual(["Receipts"]);
    expect(action.inverse?.params).toMatchObject({
      __passportPolicyInverse: { createdMailboxIds: ["receipts"] },
    });
    expect((await store.emails.get("email"))?.mailboxIds).toContain("receipts");
    await executor.undo(action.id);
    expect((await store.emails.get("email"))?.mailboxIds).toEqual(email().mailboxIds);
    expect(await store.mailboxes.get("receipts")).not.toBeNull();
    await executor.submit(request("label", { emailIds: ["email"], label: "Receipts" }));
    expect(created).toHaveLength(1);
  });
});
