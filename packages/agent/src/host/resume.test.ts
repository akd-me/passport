import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { claudeInvocation, createClaudeParser } from "./claude.js";
import { codexInvocation } from "./codex.js";
import type { HostRunSpec } from "./types.js";

const spec = (overrides: Partial<HostRunSpec>): HostRunSpec => ({
  kind: "claude-code",
  prompt: "hi",
  cwd: tmpdir(),
  completion: false,
  mcpServers: {
    passport: { url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } },
  },
  ...overrides,
});
const id = "41e79ef5-6092-45ed-b88e-f93afde2e516";

describe("resumable host sessions", () => {
  it("Claude Code keeps the session on disk only when asked, and resumes by id", async () => {
    const plain = await claudeInvocation(spec({}));
    expect(plain.args).toContain("--no-session-persistence");
    const kept = await claudeInvocation(spec({ persistSession: true }));
    expect(kept.args).not.toContain("--no-session-persistence");
    expect(kept.args).not.toContain("--resume");
    const resumed = await claudeInvocation(spec({ resumeSessionId: id }));
    expect(resumed.args).not.toContain("--no-session-persistence");
    expect(resumed.args[resumed.args.indexOf("--resume") + 1]).toBe(id);
    for (const invocation of [plain, kept, resumed]) {
      await invocation.cleanup();
    }
    // Completions never persist or resume.
    const completion = await claudeInvocation(spec({ completion: true, resumeSessionId: id }));
    expect(completion.args).toContain("--no-session-persistence");
    expect(completion.args).not.toContain("--resume");
  });

  it("Codex drops --ephemeral for resumable sessions and resumes with exec resume", async () => {
    const plain = await codexInvocation(spec({ kind: "codex" }));
    expect(plain.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(plain.args).toContain("--ephemeral");
    const kept = await codexInvocation(spec({ kind: "codex", persistSession: true }));
    expect(kept.args).not.toContain("--ephemeral");
    expect(kept.args).toEqual(expect.arrayContaining(["-s", "read-only"]));
    const resumed = await codexInvocation(spec({ kind: "codex", resumeSessionId: id }));
    expect(resumed.args.slice(0, 4)).toEqual(["exec", "resume", id, "--json"]);
    // `exec resume` rejects -s and --color; the sandbox is still read-only through config.
    expect(resumed.args).not.toContain("-s");
    expect(resumed.args).not.toContain("--color");
    expect(resumed.args).not.toContain("--ephemeral");
    expect(resumed.args).toContain('sandbox_mode="read-only"');
    expect(resumed.args).toContain("features.shell_tool=false");
    expect(resumed.args.at(-1)).toBe("-");
    expect(resumed.args.some((arg) => arg.startsWith("mcp_servers.passport.url="))).toBe(true);
  });

  it("rejects session ids that could read as flags or carry other characters", async () => {
    for (const bad of ["--help", "-x", "a b", "a;b", "", "x".repeat(200)]) {
      await expect(claudeInvocation(spec({ resumeSessionId: bad }))).rejects.toMatchObject({
        code: "HOST_AGENT_CONFIG",
      });
      await expect(
        codexInvocation(spec({ kind: "codex", resumeSessionId: bad })),
      ).rejects.toMatchObject({ code: "HOST_AGENT_CONFIG" });
    }
  });

  it("parses Claude Code's recorded missing-session result as a missing session", () => {
    const parser = createClaudeParser();
    const lines = readFileSync(
      new URL("./fixtures/claude-resume-missing.jsonl", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter(Boolean);
    expect(lines.flatMap((line) => parser.push(line))).toEqual([]);
    expect(parser.outcome()).toMatchObject({
      finished: true,
      error: {
        code: "HOST_AGENT_SESSION_MISSING",
        message: expect.stringContaining("No conversation found"),
      },
    });
  });
});
