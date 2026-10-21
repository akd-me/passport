import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostAgentStatus } from "@passport/types";
import { ModelCard } from "./ModelCard";

const agents: HostAgentStatus[] = [
  { kind: "codex", label: "Codex", installed: true, binaryPath: "/bin/codex", version: "0.163.0", loggedIn: true, account: "ChatGPT", ready: true, checkedAt: "2026-10-21T00:00:00Z" },
  { kind: "claude-code", label: "Claude Code", installed: false, binaryPath: null, version: null, loggedIn: false, account: null, ready: false, fix: "Install Claude Code, then run `claude auth login`.", checkedAt: "2026-10-21T00:00:00Z" },
];

describe("ModelCard", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("lists detected host agents and switches without asking for a key", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(agents));
    vi.stubGlobal("fetch", fetcher);
    render(<ModelCard demo={false} llm={{ provider: "claude-code", model: "claude-sonnet-5-5", configured: true, selection: "explicit" }} />);
    expect(await screen.findByText("0.163.0 · ChatGPT login")).toBeInTheDocument();
    expect(screen.getByText(/Install Claude Code/)).toBeInTheDocument();
    expect(screen.getByText(/Claude Code · claude-sonnet-5-5/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use Codex" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/settings/llm", expect.objectContaining({ method: "PUT", body: JSON.stringify({ provider: "codex" }) })));
    fireEvent.click(screen.getByRole("button", { name: "Choose automatically" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/settings/llm", expect.objectContaining({ body: JSON.stringify({ provider: "auto" }) })));
  });
});
