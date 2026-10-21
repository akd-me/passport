import type { ActionRequest } from "@passport/types";
import { afterEach, describe, expect, it } from "vitest";
import type { Backend } from "../backend.js";
import { createDemoBackend } from "./index.js";

describe("demo permission boundaries", () => {
  let backend: Backend;
  afterEach(async () => {
    await backend.close();
  });
  const request: ActionRequest = {
    type: "archive",
    accountId: "account-demo",
    actor: { kind: "agent", id: "test" },
    category: "newsletters",
    params: { emailIds: ["email-5"] },
    reason: "File the newsletter.",
  };
  it("mirrors the four modes, applies pins and always-ask rules, and caps external agents", async () => {
    backend = await createDemoBackend();
    await backend.policy.setConfig({ globalMode: "supervised" });
    expect((await backend.policy.evaluate(request)).outcome).toBe("ask");
    await backend.policy.setConfig({ globalMode: "auto_accept_edits" });
    expect((await backend.policy.evaluate(request)).outcome).toBe("allow");
    const send: ActionRequest = {
      ...request,
      type: "send",
      params: {
        draft: {
          accountId: request.accountId,
          to: [{ email: "maya@example.com" }],
          subject: "Hello",
          textBody: "Hello.",
        },
      },
    };
    expect((await backend.policy.evaluate(send)).outcome).toBe("ask");
    await backend.policy.setConfig({ globalMode: "auto" });
    expect((await backend.policy.evaluate(send)).outcome).toBe("hold");
    expect((await backend.policy.evaluate({ ...send, category: "replies_stranger" })).outcome).toBe(
      "ask",
    );
    await backend.policy.setConfig({ globalMode: "full_access" });
    expect((await backend.policy.evaluate({ ...send, category: "replies_stranger" })).outcome).toBe(
      "hold",
    );
    expect((await backend.policy.evaluate({ ...send, category: "money" })).outcome).toBe("ask");
    await backend.policy.pinLevel("newsletters", "supervised");
    expect((await backend.policy.evaluate(request)).outcome).toBe("ask");
    await backend.policy.pinLevel("newsletters", null);
    await backend.policy.setConfig({ externalAgentCeiling: "supervised" });
    expect(
      (
        await backend.policy.evaluate({
          ...request,
          actor: { kind: "external-agent", id: "mcp-test" },
        })
      ).outcome,
    ).toBe("ask");
  });
  it("rejects simultaneous double approval without creating duplicate sends", async () => {
    backend = await createDemoBackend();
    const action = (await backend.store.actions.query({ status: ["proposed"] })).items.find(
      (a) => a.request.type === "send",
    )!;
    const outcomes = await Promise.allSettled([
      backend.executor.approve(action.id),
      backend.executor.approve(action.id),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await backend.store.actions.get(action.id))?.status).toBe("held");
  });
});
