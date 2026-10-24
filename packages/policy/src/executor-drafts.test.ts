import type { ActionRecord, DraftInput } from "@passport/types";
import { describe, expect, it, vi } from "vitest";
import { createActionExecutor } from "./executor.js";
import { draftOriginalKey } from "./executor-drafts.js";
import { editDistanceRatio } from "./helpers.js";
import { draft, request, setup } from "./testing/fixtures.js";

const rewrite = "The person rewrote this response completely, including the next steps.";
const draftOf = (action: ActionRecord) => (action.request.params as { draft: DraftInput }).draft;
const distanceTo = (text: string) =>
  editDistanceRatio(`${draft.subject}\n${draft.textBody}`, `${draft.subject}\n${text}`);

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function proposal() {
  const env = await setup();
  const action = await env.executor.submit(
    request(
      "draft_create",
      { draft: { ...draft, htmlBody: "<p>Original</p>" } },
      {
        category: "replies_stranger",
      },
    ),
  );
  expect(action.status).toBe("proposed");
  return { ...env, action };
}

describe("executor draft saves (R1-23, R1-24)", () => {
  it("leaves approval pending and records the eventual rewrite as edited feedback without trust gain", async () => {
    const { executor, store, policy, bus, mail, action } = await proposal();
    const before = await policy.getTrustFor(action.request.category);
    bus.events.length = 0;
    const saved = await executor.editDraft(action.id, rewrite);
    expect(saved).toMatchObject({ status: "proposed", decision: action.decision });
    expect(saved.request).toEqual({
      ...action.request,
      params: { draft: { ...draftOf(action), textBody: rewrite, htmlBody: null } },
    });
    expect(mail.drafts).toEqual([]);
    expect(bus.events.map((event) => event.type)).toEqual(["action.updated"]);
    expect(await policy.getTrustFor(action.request.category)).toEqual(before);
    expect(await store.kv.get(`policy:feedback:${action.id}`)).toBeNull();
    const approved = await executor.approve(action.id);
    expect(approved.status).toBe("executed");
    expect(approved.editDistance).toBeCloseTo(distanceTo(rewrite));
    expect(await store.kv.get(`policy:feedback:${action.id}`)).toBe("approved_edited");
    expect(await policy.getTrustFor(action.request.category)).toMatchObject({
      approvals: before.approvals + 1,
      approvalsUnchanged: before.approvalsUnchanged,
      edits: before.edits + 1,
      score: before.score - Math.max(0.01, 0.04 * distanceTo(rewrite)),
    });
    expect(mail.drafts[0]?.draft?.textBody).toBe(rewrite);
  });

  it("compares later saves and an inline approval edit with the first agent draft after restart", async () => {
    const { executor, store, policy, bus, mail, calendar, now, action } = await proposal();
    await executor.editDraft(action.id, rewrite);
    const saved = await executor.editDraft(action.id, "Second saved draft");
    expect(JSON.parse((await store.kv.get(draftOriginalKey(action.id))) ?? "null")).toEqual(
      action.request,
    );
    const restarted = createActionExecutor({
      store,
      policy,
      bus,
      now,
      mailProviderFor: () => mail,
      calendarProviderFor: () => calendar,
    });
    const finalText = "Last edit at approval";
    const approved = await restarted.approve(action.id, {
      ...saved.request,
      params: { draft: { ...draftOf(saved), textBody: finalText } },
    });
    expect(approved.editDistance).toBeCloseTo(distanceTo(finalText));
    expect(await store.kv.get(`policy:feedback:${action.id}`)).toBe("approved_edited");
    expect(mail.drafts[0]?.draft?.textBody).toBe(finalText);
  });

  it("applies an in-flight save before a racing approval", async () => {
    const { executor, store, mail, action } = await proposal();
    const entered = gate();
    const release = gate();
    const set = store.kv.set.bind(store.kv);
    vi.spyOn(store.kv, "set").mockImplementationOnce(async (key, value) => {
      entered.open();
      await release.opened;
      await set(key, value);
    });
    const saving = executor.editDraft(action.id, rewrite);
    await entered.opened;
    const approving = executor.approve(action.id);
    release.open();
    const [saved, approved] = await Promise.all([saving, approving]);
    expect(saved.status).toBe("proposed");
    expect(approved.status).toBe("executed");
    expect(draftOf(approved).textBody).toBe(rewrite);
    expect(mail.drafts[0]?.draft?.textBody).toBe(rewrite);
    expect(await store.kv.get(`policy:feedback:${action.id}`)).toBe("approved_edited");
  });

  it("refuses a save queued behind an in-flight approval with ACTION_DECIDED", async () => {
    const { executor, store, policy, mail, action } = await proposal();
    const entered = gate();
    const release = gate();
    const evaluate = policy.evaluate.bind(policy);
    vi.spyOn(policy, "evaluate").mockImplementationOnce(async (request) => {
      entered.open();
      await release.opened;
      return evaluate(request);
    });
    const approving = executor.approve(action.id);
    await entered.opened;
    const saving = executor.editDraft(action.id, rewrite);
    const rejected = expect(saving).rejects.toMatchObject({ code: "ACTION_DECIDED" });
    release.open();
    const approved = await approving;
    await rejected;
    expect(draftOf(approved).textBody).toBe(draft.textBody);
    expect(mail.drafts[0]?.draft?.textBody).toBe(draft.textBody);
    expect(await store.kv.get(draftOriginalKey(action.id))).toBeNull();
    expect(await store.kv.get(`policy:feedback:${action.id}`)).toBe("approved_unchanged");
  });

  it.each(["", "   ", "x".repeat(100_001)])("rejects an invalid draft body (%#)", async (text) => {
    const { executor, store, action } = await proposal();
    await expect(executor.editDraft(action.id, text)).rejects.toMatchObject({
      code: "INVALID_EDIT",
    });
    expect(await store.actions.get(action.id)).toEqual(action);
    expect(await store.kv.get(draftOriginalKey(action.id))).toBeNull();
  });

  it.each(["held", "executed", "rejected"] as const)(
    "refuses to edit %s actions",
    async (status) => {
      const { executor, store, action } = await proposal();
      await store.actions.update(action.id, { status });
      await expect(executor.editDraft(action.id, rewrite)).rejects.toMatchObject({
        code: "ACTION_DECIDED",
      });
    },
  );

  it("refuses missing actions, non-draft proposals and stored undo requests", async () => {
    const { executor, store, policy, action } = await proposal();
    await expect(executor.editDraft("missing", rewrite)).rejects.toMatchObject({
      code: "ACTION_NOT_FOUND",
    });
    await policy.pinLevel("other", "supervised");
    const other = await executor.submit(request("archive", { emailIds: ["email"] }));
    await expect(executor.editDraft(other.id, rewrite)).rejects.toMatchObject({
      code: "INVALID_EDIT",
    });
    await store.kv.set(`policy:undo:${action.id}`, "original-action");
    await expect(executor.editDraft(action.id, rewrite)).rejects.toMatchObject({
      code: "INVALID_EDIT",
    });
    expect(await store.actions.get(action.id)).toEqual(action);
  });

  it("runs public request validation before saving or capturing the feedback baseline", async () => {
    const { executor, store, action } = await proposal();
    await store.actions.update(action.id, {
      request: {
        ...action.request,
        params: { draft: { ...draftOf(action), accountId: "another-account" } },
      },
    });
    await expect(executor.editDraft(action.id, rewrite)).rejects.toMatchObject({
      code: "ACCOUNT_MISMATCH",
    });
    expect(await store.kv.get(draftOriginalKey(action.id))).toBeNull();
  });
});
