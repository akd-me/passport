/**
 * Live setup task against the real `codex` CLI and its subscription login, with the real
 * setup MCP server and a scripted fake console in place of the browser (no internet pages,
 * nothing created anywhere). Skips when Codex is not installed or not logged in, or when
 * PASSPORT_SKIP_LIVE_HOST_AGENTS=1. PASSPORT_SETUP_LIVE_MODEL overrides the model.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectHostAgents } from "@passport/agent";
import { InMemoryEventBus } from "@passport/store";
import type { Account, SetupPromptKind, SetupTask } from "@passport/types";
import { SetupTaskRunner } from "./runner.js";

const statuses = process.env.PASSPORT_SKIP_LIVE_HOST_AGENTS ? [] : await detectHostAgents();
const codexReady = statuses.some(status => status.kind === "codex" && status.ready);
const fakeConsole = fileURLToPath(new URL("./fixtures/fake-console-mcp.mjs", import.meta.url));

describe.skipIf(!codexReady)("live setup task (codex)", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "passport-setup-live-")); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it("asks the user to sign in, registers the client it reads, and finishes once connected", async () => {
    const signedIn = join(dir, "signed-in"), consented = join(dir, "consented"), calls = join(dir, "calls.log");
    await writeFile(calls, "");
    const registered: Array<Record<string, unknown>> = [];
    const asked: SetupPromptKind[] = [];
    const bus = new InMemoryEventBus();
    const runner = new SetupTaskRunner({
      mode: "real", dataDir: dir, bus,
      detectAgents: async () => statuses,
      browser: {
        detect: () => "chrome",
        prepare: async () => {},
        server: () => ({ command: process.execPath, args: [fakeConsole], env: { FAKE_CONSOLE_SIGNED_IN: signedIn, FAKE_CONSOLE_LOG: calls } }),
        close: async () => {},
      },
      oauth: {
        start: async input => {
          registered.push(input);
          return { authUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x", attemptId: "attempt-live", nonce: "nonce", redirectUri: "http://127.0.0.1:3999/oauth/callback" };
        },
        // Connected once the agent's browser opened the consent link and the user approved.
        peek: () => existsSync(consented) && readFileSync(calls, "utf8").includes("/oauth/setup/") ? { status: "connected", accountId: "acc-live" } : { status: "authorizing" },
      },
      listAccounts: async () => [{ id: "acc-live", kind: "gmail", emailAddress: "alex@example.com", settings: { oauthGroup: "acc-live" } } as unknown as Account],
      models: process.env.PASSPORT_SETUP_LIVE_MODEL ? { codex: { model: process.env.PASSPORT_SETUP_LIVE_MODEL, reasoning: "medium" } } : {},
      sessionTimeoutMs: 9 * 60_000,
    });
    // Play the user: sign in, approve, answer questions.
    const answered = new Set<string>();
    bus.on("setup.task.updated", ({ task }) => {
      const prompt = task.prompt;
      if (!prompt || answered.has(prompt.id)) return;
      answered.add(prompt.id);
      asked.push(prompt.kind);
      if (prompt.kind === "sign_in") appendFileSync(signedIn, "yes");
      if (prompt.kind === "confirm") appendFileSync(consented, "yes");
      setTimeout(() => runner.respond(task.id, prompt.id, prompt.kind === "question" ? "Use alex@example.com" : "done"), 50);
    });
    const task = runner.start({ provider: "gmail", calendar: true, agent: "codex" }, "http://127.0.0.1:3999");
    const final = await new Promise<SetupTask>(resolve => {
      const check = () => {
        const current = runner.get(task.id);
        if (["completed", "failed", "cancelled"].includes(current.status)) resolve(current);
        else setTimeout(check, 250);
      };
      check();
    });
    await runner.close();
    const summary = JSON.stringify({ status: final.status, error: final.error, asked, log: final.log.map(line => line.text) }, null, 2);
    if (process.env.PASSPORT_SETUP_LIVE_VERBOSE) console.log(summary);
    expect(final.status, summary).toBe("completed");
    expect(asked[0], summary).toBe("sign_in");
    expect(asked, summary).toContain("confirm");
    expect(registered, summary).toEqual([expect.objectContaining({ kind: "gmail", clientId: "4711-fakeclient.apps.googleusercontent.com", clientSecret: "GOCSPX-fake-secret-4711", calendar: true })]);
    expect(final.result).toEqual({ accountIds: ["acc-live"] });
    expect(readFileSync(calls, "utf8")).toMatch(/navigate http:\/\/127\.0\.0\.1:3999\/oauth\/setup\//);
    expect(JSON.stringify(final)).not.toContain("GOCSPX-fake-secret-4711");
  }, 600_000);
});
