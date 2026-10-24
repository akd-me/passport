import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentJobTimeout, runBudget, validateAgentBudget } from "./agent-session.js";
import { loadConfig } from "./config.js";

describe("agent run budget configuration", () => {
  it("reads agentBudget from the file and lets the environment override it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passport-budget-"));
    try {
      await writeFile(
        join(dir, "passport.config.json"),
        JSON.stringify({ agentBudget: { maxToolCalls: 50, maxRunMinutes: 10 } }),
      );
      const fromFile = await loadConfig({ PASSPORT_DATA_DIR: dir });
      expect(fromFile.agentBudget).toEqual({ maxToolCalls: 50, maxRunMinutes: 10 });
      const overridden = await loadConfig({
        PASSPORT_DATA_DIR: dir,
        PASSPORT_AGENT_MAX_TOOL_CALLS: "75",
      });
      expect(overridden.agentBudget).toEqual({ maxToolCalls: 75, maxRunMinutes: 10 });
      expect(runBudget(overridden.agentBudget)).toEqual({
        maxToolCalls: 75,
        maxDurationMs: 600_000,
      });
      await expect(
        loadConfig({ PASSPORT_DATA_DIR: dir, PASSPORT_AGENT_MAX_RUN_MINUTES: "soon" }),
      ).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the runtime budget and rejects out-of-range limits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "passport-budget-"));
    try {
      expect((await loadConfig({ PASSPORT_DATA_DIR: dir })).agentBudget).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(runBudget(undefined)).toEqual({});
    expect(agentJobTimeout(undefined)).toBe(31 * 60_000);
    expect(agentJobTimeout({ maxRunMinutes: 10 })).toBe(11 * 60_000);
    for (const bad of [
      [],
      { maxToolCalls: 0 },
      { maxToolCalls: 1.5 },
      { maxToolCalls: 10_001 },
      { maxRunMinutes: 1441 },
    ]) {
      expect(() => validateAgentBudget(bad)).toThrow(/agentBudget/);
    }
    expect(() => validateAgentBudget({ maxToolCalls: 200, maxRunMinutes: 30 })).not.toThrow();
  });
});
