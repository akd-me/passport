import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Account,
  ActionRecord,
  AgentRun,
  CalendarEvent,
  Email,
  Page,
  Person,
} from "@passport/types";
import { createApp } from "./auth.test-client.js";
import { createDemoBackend } from "./demo/index.js";
import type { Backend } from "./backend.js";

describe("HTTP API with DemoBackend", () => {
  let backend: Backend;
  let app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    backend = await createDemoBackend();
    app = createApp(backend, { staticDir: "/nonexistent" });
  });
  afterEach(async () => {
    await backend.close();
  });
  const body = (value: unknown) => ({
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  async function decisions() {
    return (await (
      await app.request("/api/decisions")
    ).json()) as Page<ActionRecord>;
  }
  it("seeds realistic linked records and exposes every read surface", async () => {
    const emails = (await (
      await app.request("/api/emails?limit=5")
    ).json()) as Page<Email>;
    expect(emails.total).toBe(40);
    expect(emails.items).toHaveLength(5);
    expect(emails.nextCursor).toBe("5");
    expect(emails.items[0]?.textBody).toBeUndefined();
    for (const route of [
      "/api/decisions",
      "/api/actions?status=executed",
      "/api/emails/email-0",
      "/api/threads/thread-0",
      "/api/matters",
      "/api/matters/matter-0",
      "/api/people",
      "/api/people/person-0",
      "/api/events",
      "/api/trust",
      "/api/user-profile",
      "/api/accounts",
      "/api/providers",
      `/api/digest/${new Date().toISOString().slice(0, 10)}`,
    ]) {
      const response = await app.request(route);
      expect(response.status, route).toBe(200);
    }
    const matter = (await (
      await app.request("/api/matters/matter-0")
    ).json()) as {
      people: Person[];
      emails: Page<Email>;
      events: CalendarEvent[];
    };
    expect(matter.people).toHaveLength(2);
    expect(matter.emails.items.length).toBeGreaterThan(0);
    expect(matter.events).toHaveLength(1);
  });
  it("approves edited content into a cancellable outbox, preserving actor metadata", async () => {
    const action = (await decisions()).items.find(
      (a) => a.status === "proposed" && a.request.type === "send",
    )!;
    const draft = (action.request.params as { draft: object }).draft;
    const edited = {
      ...action.request,
      actor: { kind: "human", id: "forged" },
      category: "legal",
      params: { draft: { ...draft, textBody: "Thanks Maya, Thursday works." } },
    };
    const response = await app.request(`/api/actions/${action.id}/approve`, {
      method: "POST",
      ...body({ request: edited }),
    });
    expect(response.status).toBe(200);
    const held = (await response.json()) as ActionRecord;
    expect(held.status).toBe("held");
    expect(held.holdUntil).toBeTruthy();
    expect(held.executedAt).toBeUndefined();
    expect(held.request.actor.kind).toBe("agent");
    expect(held.request.category).toBe(action.request.category);
    expect(
      (held.request.params as { draft: { textBody: string } }).draft.textBody,
    ).toBe("Thanks Maya, Thursday works.");
    const trust = await backend.policy.getTrustFor(action.request.category);
    expect(trust.edits).toBeGreaterThan(2);
    expect(
      (
        await app.request(`/api/actions/${action.id}/cancel-hold`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect((await backend.store.actions.get(action.id))?.status).toBe(
      "rejected",
    );
    expect(
      (await backend.executor.releaseDue("2099-01-01T00:00:00Z")).some(
        (a) => a.id === action.id,
      ),
    ).toBe(false);
  });
  it("rejects once, records feedback, and returns conflicts for stale decisions", async () => {
    const action = (await decisions()).items.find(
      (a) => a.status === "proposed",
    )!;
    const before = await backend.policy.getTrustFor(action.request.category);
    const response = await app.request(`/api/actions/${action.id}/reject`, {
      method: "POST",
      ...body({ reason: "Needs a different tone" }),
    });
    expect(((await response.json()) as ActionRecord).status).toBe("rejected");
    expect(
      (await backend.policy.getTrustFor(action.request.category)).rejections,
    ).toBe(before.rejections + 1);
    expect(
      (
        await app.request(`/api/actions/${action.id}/approve`, {
          method: "POST",
        })
      ).status,
    ).toBe(409);
    expect(
      (await app.request("/api/actions/missing/approve", { method: "POST" }))
        .status,
    ).toBe(404);
  });
  it("undo restores exact mail state and logs the inverse", async () => {
    const archived = (
      await backend.store.actions.query({ status: ["executed"] })
    ).items.find((a) => a.request.type === "archive")!;
    expect((await backend.store.emails.get("email-5"))?.mailboxIds).toEqual([
      "mailbox-archive",
    ]);
    const response = await app.request(`/api/actions/${archived.id}/undo`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ActionRecord).status).toBe("undone");
    expect((await backend.store.emails.get("email-5"))?.mailboxIds).toEqual([
      "mailbox-inbox",
    ]);
    const history = await backend.store.actions.query({ status: ["executed"] });
    expect(history.items.some((a) => a.result?.undoes === archived.id)).toBe(
      true,
    );
    expect(
      (
        await app.request(`/api/actions/${archived.id}/undo`, {
          method: "POST",
        })
      ).status,
    ).toBe(409);
  });
  it("only releases due sends once and marks released sends irreversible", async () => {
    const held = (await decisions()).items.find((a) => a.status === "held")!;
    expect(await backend.executor.releaseDue("2000-01-01T00:00:00Z")).toEqual(
      [],
    );
    const released = await backend.executor.releaseDue("2099-01-01T00:00:00Z");
    expect(released).toHaveLength(1);
    expect(released[0]?.id).toBe(held.id);
    expect(released[0]?.inverse).toBeNull();
    expect(released[0]?.decision.reversibility).toBe("irreversible");
    expect(await backend.executor.releaseDue("2099-01-01T00:00:00Z")).toEqual(
      [],
    );
    expect(
      (await app.request(`/api/actions/${held.id}/undo`, { method: "POST" }))
        .status,
    ).toBe(409);
    const detail = (await (
      await app.request("/api/matters/matter-1")
    ).json()) as { emails: Page<Email> };
    expect(
      detail.emails.items.some((e: Email) =>
        e.mailboxIds.includes("mailbox-sent"),
      ),
    ).toBe(true);
  });
  it("persists trust mode, safety settings and category pins; rejects invalid input", async () => {
    const response = await app.request("/api/trust/config", {
      method: "PUT",
      ...body({
        globalMode: "auto",
        outboxHoldMinutes: 12,
        decayAfterDays: 30,
        alwaysAsk: ["money", "legal", "unsubscribe"],
      }),
    });
    expect(response.status).toBe(200);
    expect(await backend.policy.getConfig()).toMatchObject({
      globalMode: "auto",
      outboxHoldMinutes: 12,
      decayAfterDays: 30,
    });
    expect(
      (
        await app.request("/api/trust/newsletters/pin", {
          method: "PUT",
          ...body({ level: "full_access" }),
        })
      ).status,
    ).toBe(200);
    expect((await backend.policy.getTrustFor("newsletters")).pinnedLevel).toBe(
      "full_access",
    );
    expect(
      (
        await app.request("/api/trust/newsletters/pin", {
          method: "PUT",
          ...body({ level: null }),
        })
      ).status,
    ).toBe(200);
    for (const patch of [
      { globalMode: "anything" },
      { outboxHoldMinutes: -1 },
      { decayAfterDays: 0 },
      { alwaysAsk: ["fake"] },
      { unexpected: true },
    ])
      expect(
        (
          await app.request("/api/trust/config", {
            method: "PUT",
            ...body(patch),
          })
        ).status,
      ).toBe(400);
  });
  it("updates matters through the action gate and allows undo", async () => {
    const old = await backend.store.matters.get("matter-0");
    const response = await app.request("/api/matters/matter-0", {
      method: "PATCH",
      ...body({ status: "done", nextStep: "All finished." }),
    });
    const action = (await response.json()) as ActionRecord;
    expect(action.status).toBe("executed");
    expect(action.request.type).toBe("matter_update");
    expect((await backend.store.matters.get("matter-0"))?.status).toBe("done");
    await backend.executor.undo(action.id);
    expect(await backend.store.matters.get("matter-0")).toEqual(old);
    expect(
      (
        await app.request("/api/matters/matter-0", {
          method: "PATCH",
          ...body({ id: "forged" }),
        })
      ).status,
    ).toBe(400);
  });
  it("drives account setup from descriptors and never returns secret fields", async () => {
    const response = await app.request("/api/accounts", {
      method: "POST",
      ...body({
        kind: "mock",
        fields: {
          emailAddress: "work@example.com",
          displayName: "Work",
          demoToken: "private-test-token",
        },
      }),
    });
    const account = (await response.json()) as Account;
    expect(response.status).toBe(201);
    expect(account.settings.demoToken).toBeUndefined();
    expect(await backend.store.accounts.getCredentials(account.id)).toEqual({
      demoToken: "private-test-token",
    });
    const publicAccounts = await (await app.request("/api/accounts")).text();
    expect(publicAccounts).not.toContain("private-test-token");
    expect(JSON.stringify(backend.config)).not.toContain("private-test-token");
    expect(
      (
        await app.request(`/api/accounts/${account.id}/sync`, {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(
      (await backend.store.accounts.get(account.id))?.lastSyncAt,
    ).toBeTruthy();
    expect(
      (
        await app.request("/api/accounts", {
          method: "POST",
          ...body({ kind: "gmail", fields: {} }),
        })
      ).status,
    ).toBe(400);
  });
  it("saves the standing profile, LLM preferences, and triggers a demo review", async () => {
    const markdown = "# My preferences\nBe brief.";
    expect(
      (
        await app.request("/api/user-profile", {
          method: "PUT",
          ...body({ markdown }),
        })
      ).status,
    ).toBe(200);
    expect(await backend.agent.getUserProfile()).toBe(markdown);
    expect(
      (
        await app.request("/api/settings/llm", {
          method: "PUT",
          ...body({ provider: "openai", model: "example-model" }),
        })
      ).status,
    ).toBe(200);
    expect(backend.config.llm.model).toBe("example-model");
    expect(
      (
        await app.request("/api/settings/llm", {
          method: "PUT",
          ...body({ apiKey: "never" }),
        })
      ).status,
    ).toBe(400);
    const pending = (await decisions()).items.find(
      (a) => a.request.matterId === "matter-0",
    )!;
    await backend.executor.reject(pending.id);
    const run = (await (
      await app.request("/api/agent/run", { method: "POST", ...body({}) })
    ).json()) as AgentRun;
    expect(run.actionIds).toHaveLength(1);
  });
  it("applies filters and rejects malformed input, unknown resources, and cross-origin writes", async () => {
    const emails = (await (
      await app.request(
        "/api/emails?matterId=matter-0&includeBodies=true&has=$seen&sort=receivedAt_asc",
      )
    ).json()) as Page<Email>;
    expect(emails.items.length).toBeGreaterThan(0);
    expect(
      emails.items.every(
        (e) => e.matterId === "matter-0" && e.textBody && e.keywords.$seen,
      ),
    ).toBe(true);
    for (const path of [
      "/api/emails?limit=-1",
      "/api/actions?status=invalid",
      "/api/people?relationship=alien",
      "/api/events?start=invalid",
      "/api/digest/2026-99-99",
    ])
      expect((await app.request(path)).status, path).toBe(400);
    expect(
      (await app.request("/api/trust/config", { method: "PUT", body: "{" }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/user-profile", {
          method: "PUT",
          headers: { Origin: "https://evil.example" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await app.request("/api/no-such-route")).status).toBe(404);
    expect((await app.request("/api/emails/missing")).status).toBe(404);
  });
});
