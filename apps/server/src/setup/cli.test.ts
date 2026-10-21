import type { SetupPrompt, SetupTask } from "@passport/types";
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors.js";
import { followSetupTask, parseConnectArgs, type SetupClient } from "./cli.js";

const base: SetupTask = {
  id: "t1",
  provider: "gmail",
  status: "running",
  log: [],
  steps: [
    { id: "prepare", title: "Start the browser and agent", status: "running" },
    { id: "sign_in", title: "Sign in to Google Cloud", status: "pending" },
  ],
};

describe("passport accounts connect", () => {
  it("parses flags", () => {
    expect(parseConnectArgs(["--provider", "gmail"])).toEqual({
      provider: "gmail",
      calendar: true,
    });
    expect(
      parseConnectArgs(["--provider", "microsoft", "--no-calendar", "--agent", "claude-code"]),
    ).toEqual({ provider: "microsoft", calendar: false, agent: "claude-code" });
    expect(() => parseConnectArgs([])).toThrow(ApiError);
  });

  it("prints step and log changes once and answers each prompt once", async () => {
    const prompt: SetupPrompt = {
      id: "p1",
      kind: "sign_in",
      message: "Sign in to Google in the browser window I opened, then click Continue.",
    };
    const states: SetupTask[] = [
      base,
      {
        ...base,
        status: "waiting_for_user",
        prompt,
        log: [{ at: "1", level: "info", text: "Agent started." }],
      },
      {
        ...base,
        status: "waiting_for_user",
        prompt,
        log: [{ at: "1", level: "info", text: "Agent started." }],
      },
      {
        ...base,
        status: "completed",
        steps: base.steps.map((step) => ({ ...step, status: "done" })),
        result: { accountIds: ["a1"] },
        log: [
          { at: "1", level: "info", text: "Agent started." },
          { at: "2", level: "warn", text: "click failed: timeout" },
        ],
      },
    ];
    const responses: string[] = [];
    let index = 0;
    const client: SetupClient = {
      start: async () => "t1",
      get: async () => states[Math.min(index++, states.length - 1)]!,
      respond: async (_id, promptId, answer) => {
        responses.push(`${promptId}:${answer}`);
        throw new ApiError("PROMPT_STALE", "stale", 409);
      },
      cancel: async () => {},
    };
    const asked: string[] = [],
      lines: string[] = [];
    const final = await followSetupTask(
      client,
      "t1",
      async (p) => {
        asked.push(p.kind);
        return "done";
      },
      (line) => lines.push(line),
      { intervalMs: 1 },
    );
    expect(final.status).toBe("completed");
    expect(asked).toEqual(["sign_in"]);
    expect(responses).toEqual(["p1:done"]);
    expect(lines).toEqual([
      "[…] Start the browser and agent",
      "    Agent started.",
      "[✓] Start the browser and agent",
      "[✓] Sign in to Google Cloud",
      "    warn: click failed: timeout",
    ]);
  });
});
