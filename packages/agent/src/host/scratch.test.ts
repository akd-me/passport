import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { HostAgentKind } from "@passport/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostAgentLlmClient } from "./client.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(kind: HostAgentKind) {
  const dataDir = await realpath(await mkdtemp(join(tmpdir(), "passport-scratch-test-")));
  dirs.push(dataDir);
  const path = join(dataDir, "cli");
  const log = join(dataDir, "calls.jsonl");
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync("run-private.txt", "run output");
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), mode: fs.statSync(".").mode & 0o777 }) + "\\n");
  if (input.includes("FAIL")) return process.exit(1);
  if (input.includes("CANCEL")) return setInterval(() => {}, 1000);
  const events = ${JSON.stringify(kind)} === "claude-code" ? [
    { type: "system", subtype: "init", session_id: "scratch-session" },
    { type: "result", subtype: "success", is_error: false, result: "Done." },
  ] : [
    { type: "thread.started", thread_id: "scratch-session" },
    { type: "item.completed", item: { type: "agent_message", text: "Done." } },
    { type: "turn.completed" },
  ];
  for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
});
`,
  );
  await chmod(path, 0o755);
  const calls = async (): Promise<Array<{ cwd: string; mode: number }>> =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const client = new HostAgentLlmClient({
    kind,
    binaryPath: path,
    cwd: join(dataDir, "host-agent"),
    env: { HOME: dataDir, PATH: "/usr/bin:/bin", PASSPORT_DATA_DIR: dataDir },
  });
  const session = (prompt: string) =>
    client.session(
      {
        prompt,
        systemPrompt: "Respond.",
        mcpServers: {},
        timeoutMs: 5000,
      },
      () => {},
    );
  const checkPaths = async () => {
    const rows = await calls();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.cwd)).size).toBe(2);
    for (const row of rows) {
      expect(dirname(row.cwd)).toBe(await realpath(tmpdir()));
      expect(row.cwd.startsWith(`${dataDir}${sep}`)).toBe(false);
      expect(row.mode).toBe(0o700);
      await expect(stat(row.cwd)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(stat(join(dataDir, "host-agent"))).rejects.toMatchObject({ code: "ENOENT" });
  };
  return { client, session, calls, checkPaths };
}

describe.each(["claude-code", "codex"] as const)("%s host scratch isolation", (kind) => {
  it("uses and removes a separate private OS temp directory for sessions and completions", async () => {
    const env = await fixture(kind);
    expect(await env.session("SESSION").done).toMatchObject({ ok: true });
    expect(
      await env.client.complete({
        system: "Respond.",
        messages: [{ role: "user", content: "COMPLETE" }],
      }),
    ).toMatchObject({ text: "Done." });
    await env.checkPaths();
  });

  it("removes the working directory after failure and cancellation", async () => {
    const env = await fixture(kind);
    expect(await env.session("FAIL").done).toMatchObject({ ok: false });
    const cancelled = env.session("CANCEL");
    await vi.waitFor(async () => expect(await env.calls()).toHaveLength(2));
    cancelled.cancel();
    expect(await cancelled.done).toMatchObject({
      ok: false,
      error: { code: "HOST_AGENT_CANCELLED" },
    });
    await env.checkPaths();
  });
});
