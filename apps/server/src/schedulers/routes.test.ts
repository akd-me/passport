import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../auth.test-client.js";
import type { Backend } from "../backend.js";
import { createDemoBackend } from "../demo/index.js";
import { getSchedulerService, type JobView } from "./service.js";

describe("scheduler HTTP API", () => {
  let backend: Backend, app: ReturnType<typeof createApp>;
  beforeEach(async () => {
    backend = await createDemoBackend();
    app = createApp(backend, { staticDir: "/nonexistent" });
  });
  afterEach(async () => {
    await getSchedulerService(backend).stop();
    await backend.close();
    vi.restoreAllMocks();
  });
  const input = {
    name: "Morning triage",
    schedule: {
      type: "weekly",
      days: [1, 2, 3, 4, 5],
      at: "07:30",
      timeZone: "America/New_York",
    },
    routine: { instruction: "Triage new mail, then prepare my day's digest" },
  };
  const request = (method: string, value?: unknown) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  async function create() {
    const response = await app.request("/api/jobs", request("POST", input));
    expect(response.status).toBe(201);
    return (await response.json()) as JobView;
  }
  it("lists built-in definitions, states, and demo jobs", async () => {
    const response = await app.request("/api/jobs");
    expect(response.status).toBe(200);
    const jobs = (await response.json()) as JobView[];
    expect(jobs.map((j) => j.id)).toEqual(
      expect.arrayContaining([
        "sync:account-demo",
        "outbox.release",
        "trust.decay",
        "agent.daily_digest",
        "agent.matter_review",
        "store.maintenance",
      ]),
    );
    expect(jobs.find((j) => j.id === "trust.decay")?.definition.schedule).toMatchObject({
      type: "daily",
      at: "03:00",
    });
    expect(JSON.stringify(jobs)).not.toContain('"run":');
  });
  it("creates, edits, pauses, resumes, runs, inspects history and deletes routines", async () => {
    const job = await create();
    expect(job.kind).toBe("user");
    expect((await app.request(`/api/jobs/${job.id}/pause`, request("POST"))).status).toBe(200);
    expect(getSchedulerService(backend).scheduler.get(job.id)?.enabled).toBe(false);
    const patch = {
      name: "Evening triage",
      schedule: { type: "daily", at: "19:00", timeZone: "UTC" },
      routine: { instruction: "Review my active matters" },
    };
    expect((await app.request(`/api/jobs/${job.id}`, request("PATCH", patch))).status).toBe(200);
    const run = vi.spyOn(backend.agent, "run");
    expect((await app.request(`/api/jobs/${job.id}/run`, request("POST"))).status).toBe(200);
    expect(run).toHaveBeenCalledWith({
      kind: "manual",
      instruction: patch.routine.instruction,
    });
    const history = await (await app.request(`/api/jobs/${job.id}/history`)).json();
    expect(history).toEqual([
      expect.objectContaining({ status: "ok", durationMs: expect.any(Number) }),
    ]);
    const jobs = (await (await app.request("/api/jobs")).json()) as JobView[];
    expect(jobs.find((j) => j.id === job.id)).toMatchObject({
      name: patch.name,
      enabled: false,
      lastStatus: "ok",
      runCount: 1,
      routine: patch.routine,
    });
    expect((await app.request(`/api/jobs/${job.id}/resume`, request("POST"))).status).toBe(200);
    expect((await app.request(`/api/jobs/${job.id}`, request("DELETE"))).status).toBe(200);
    expect((await app.request(`/api/jobs/${job.id}/history`)).status).toBe(404);
    expect(await backend.store.kv.get(`job:${job.id}`)).toBeNull();
    expect(await backend.store.kv.get("scheduler:routines")).toBe("[]");
  });
  it("restores stored routines and their pause/history state", async () => {
    const job = await create();
    await app.request(`/api/jobs/${job.id}/run`, request("POST"));
    await app.request(`/api/jobs/${job.id}/pause`, request("POST"));
    await getSchedulerService(backend).stop();
    const jobs = (await (await app.request("/api/jobs")).json()) as JobView[];
    expect(jobs.find((j) => j.id === job.id)).toMatchObject({
      enabled: false,
      runCount: 1,
      routine: input.routine,
    });
  });
  it("validates inputs and protects system handlers and cross-origin writes", async () => {
    for (const value of [
      { ...input, name: "" },
      { ...input, routine: { instruction: "" } },
      { ...input, schedule: { type: "weekly", days: [8], at: "07:30" } },
      { ...input, schedule: { type: "daily", at: "07:30", timeZone: "bad" } },
      { ...input, run: "evil" },
    ]) {
      expect((await app.request("/api/jobs", request("POST", value))).status).toBe(400);
    }
    expect((await app.request("/api/jobs/outbox.release", request("DELETE"))).status).toBe(409);
    expect((await app.request("/api/jobs/missing/run", request("POST"))).status).toBe(404);
    expect(
      (await app.request("/api/jobs/outbox.release", request("PATCH", { enabled: "yes" }))).status,
    ).toBe(400);
    expect(
      (await app.request("/api/jobs/outbox.release", request("PATCH", { routine: input.routine })))
        .status,
    ).toBe(400);
    expect((await app.request("/api/jobs", { method: "POST", body: "{" })).status).toBe(400);
    expect(
      (
        await app.request("/api/jobs", {
          ...request("POST", input),
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });
  it("records errors and broadcasts job events without bypassing the agent", async () => {
    const job = await create(),
      events: string[] = [];
    const unsubscribe = backend.bus.onAny((e) => events.push(e.type));
    vi.spyOn(backend.agent, "run").mockRejectedValueOnce(new Error("Model is unavailable"));
    const response = await app.request(`/api/jobs/${job.id}/run`, request("POST"));
    expect(await response.json()).toMatchObject({
      status: "error",
      summary: "Model is unavailable",
    });
    expect(events).toEqual(["job.started", "job.finished"]);
    expect(getSchedulerService(backend).scheduler.get(job.id)).toMatchObject({
      consecutiveFailures: 1,
      lastError: "Model is unavailable",
    });
    unsubscribe();
  });
  it("skips maintenance when the store does not expose it", async () => {
    const response = await app.request("/api/jobs/store.maintenance/run", request("POST"));
    expect(await response.json()).toMatchObject({ status: "skipped" });
  });
  it("registers onboarding accounts through the API lifecycle hook", async () => {
    await app.request("/api/jobs");
    const response = await app.request(
      "/api/accounts",
      request("POST", {
        kind: "mock",
        fields: { emailAddress: "new@example.com", displayName: "New" },
      }),
    );
    expect(response.status).toBe(201);
    const account = (await response.json()) as { id: string };
    expect(getSchedulerService(backend).scheduler.get(`sync:${account.id}`)).toBeDefined();
    await backend.store.accounts.delete(account.id);
    await getSchedulerService(backend).reconcileAccounts();
    expect(getSchedulerService(backend).scheduler.get(`sync:${account.id}`)).toBeUndefined();
  });
});
