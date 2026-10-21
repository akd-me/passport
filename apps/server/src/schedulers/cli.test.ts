import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runJobsCommand } from "./cli.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(async () => actual.defaultConfig("/unused-demo-config")),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
beforeEach(() => vi.stubEnv("PASSPORT_API_TOKEN", "fixture-api-token"));
describe("jobs CLI", () => {
  it("sends list/run/pause/resume to the live server", async () => {
    const fetcher = vi.fn(async (url: string) =>
      Response.json(url.endsWith("health") ? { ok: true, mode: "real" } : { ok: true }),
    );
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const command of ["list", "run", "pause", "resume"])
      await runJobsCommand([command, "routine:morning"]);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3000/api/health",
      "http://127.0.0.1:3000/api/jobs",
      "http://127.0.0.1:3000/api/health",
      "http://127.0.0.1:3000/api/jobs/routine%3Amorning/run",
      "http://127.0.0.1:3000/api/health",
      "http://127.0.0.1:3000/api/jobs/routine%3Amorning/pause",
      "http://127.0.0.1:3000/api/health",
      "http://127.0.0.1:3000/api/jobs/routine%3Amorning/resume",
    ]);
  });
  it("submits a daily routine with its instruction", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true, mode: "real" }),
    );
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runJobsCommand([
      "add-routine",
      "--name",
      "Morning",
      "--daily",
      "07:30",
      "--instruction",
      "Prepare my digest",
      "--time-zone",
      "UTC",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({
      name: "Morning",
      schedule: { type: "daily", at: "07:30", timeZone: "UTC" },
      routine: { instruction: "Prepare my digest" },
    });
  });
  it("propagates server errors and rejects invalid commands", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ok: true, mode: "real" }))
      .mockResolvedValueOnce(
        Response.json(
          { error: { code: "JOB_NOT_FOUND", message: "Job not found" } },
          { status: 404 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(runJobsCommand(["run", "missing"])).rejects.toHaveProperty(
      "code",
      "JOB_NOT_FOUND",
    );
    await expect(runJobsCommand(["wrong"])).rejects.toHaveProperty("code", "INVALID_COMMAND");
  });
  it("runs isolated demo commands without networking", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runJobsCommand(["list", "--demo"]);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "outbox.release" })]),
    );
    await runJobsCommand(["run", "agent.daily_digest", "--demo"]);
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      status: "ok",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("R3: authenticates health and job requests with the API token", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ ok: true, mode: "real" }),
    );
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runJobsCommand(["list"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls)
      expect(init?.headers).toHaveProperty("Authorization", "Bearer fixture-api-token");
  });
  it.each([0, 1])(
    "R3: fails loudly on a reachable server's 401 at request %s without local fallback",
    async (where) => {
      const fetcher = vi.fn();
      if (where === 1) fetcher.mockResolvedValueOnce(Response.json({ ok: true, mode: "real" }));
      fetcher.mockResolvedValueOnce(
        Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
      );
      vi.stubGlobal("fetch", fetcher);
      await expect(runJobsCommand(["list"])).rejects.toThrow("PASSPORT_API_TOKEN");
      expect(fetcher).toHaveBeenCalledTimes(where + 1);
    },
  );
});
