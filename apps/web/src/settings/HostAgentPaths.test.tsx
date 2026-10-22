import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HostAgentSettings } from "../api";
import { Harness, stubApi } from "../test-utils";
import { HostAgentPaths } from "./HostAgentPaths";

const settings = (overrides: Partial<HostAgentSettings> = {}): HostAgentSettings => ({
  pathSource: { source: "launchctl", label: "launchctl", entries: 4 },
  paths: {
    "claude-code": { configured: null, environment: null },
    codex: { configured: null, environment: "/env/codex" },
  },
  agents: [
    {
      kind: "codex",
      label: "Codex",
      installed: true,
      binaryPath: "/env/codex",
      version: "0.130.0",
      loggedIn: false,
      account: null,
      ready: false,
      checkedAt: "2026-10-22T00:00:00.000Z",
    },
  ],
  ...overrides,
});

describe("Settings → Model → Agent programs", () => {
  it("shows where each CLI was found, saves an override and re-detects", async () => {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    stubApi({
      "/settings/host-agents": (url: URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({
          method,
          path: url.pathname,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if (method === "PUT") {
          return settings({
            paths: {
              "claude-code": { configured: "/opt/claude/bin/claude", environment: null },
              codex: { configured: null, environment: "/env/codex" },
            },
          });
        }
        if (url.pathname.endsWith("/redetect")) {
          return settings({
            pathSource: { source: "login-shell", label: "login shell (zsh)", entries: 12 },
          });
        }
        return settings();
      },
    });
    render(
      <Harness>
        <HostAgentPaths />
      </Harness>,
    );
    expect(
      await screen.findByText(/searched 4 folders on PATH \(from launchctl\)/),
    ).toBeInTheDocument();
    expect(screen.getByText("Not found")).toBeInTheDocument();
    expect(screen.getByText(/not signed in/)).toBeInTheDocument();
    const codex = screen.getByLabelText("Codex path");
    expect(codex).toBeDisabled();
    expect(codex).toHaveValue("/env/codex");
    expect(screen.getByText("PASSPORT_CODEX_PATH")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Claude Code path"), {
      target: { value: " /opt/claude/bin/claude " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save paths" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "PUT",
        path: "/api/settings/host-agents",
        body: { claudePath: "/opt/claude/bin/claude", codexPath: null },
      }),
    );
    expect(await screen.findByDisplayValue("/opt/claude/bin/claude")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Re-detect" }));
    expect(await screen.findByText(/from login shell \(zsh\)/)).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/settings/host-agents/redetect" });
  });

  it("stays hidden on servers without binary-path settings", async () => {
    const fetchMock = stubApi({});
    const { container } = render(
      <Harness>
        <HostAgentPaths />
      </Harness>,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
