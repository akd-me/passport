import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccountScope } from "../accounts/AccountFilter";
import { api } from "../api";
import { Harness, stubApi } from "../test-utils";
import { type SettingsSection, useUi } from "../ui-state";
import { SettingsDialog } from "./SettingsDialog";

const base = {
  "/accounts": {
    accounts: [],
    mode: "real",
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      apiKeyConfigured: false,
      configured: false,
    },
  },
  "/trust": {
    config: {
      globalMode: "supervised",
      outboxHoldMinutes: 5,
      decayAfterDays: 14,
      alwaysAsk: ["money"],
      externalAgentCeiling: "supervised",
    },
    categories: [],
    promotionOffers: [],
  },
  "/user-profile": { markdown: "# Me" },
  "/jobs": [],
  "/providers": [],
};

function Open({ section }: { section: SettingsSection }) {
  const { openSettings } = useUi();
  useEffect(() => openSettings(section), [openSettings, section]);
  return null;
}
function renderSettings(section: SettingsSection = "model") {
  return render(
    <Harness>
      <AccountScope>
        <Open section={section} />
        <SettingsDialog />
      </AccountScope>
    </Harness>,
  );
}

describe("settings dialog", () => {
  it("has five sections and moves between them without leaving the dialog", async () => {
    stubApi({ ...base, "/host-agents": [] });
    renderSettings();
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Model",
      "Accounts",
      "Trust & rules",
      "Routines",
      "Advanced",
    ]);
    expect(screen.getByRole("button", { name: "Model" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Trust & rules" }));
    expect(
      await screen.findByRole("heading", { name: "Standing instructions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Permission mode" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Routines" }));
    expect(await screen.findByText("No routines yet")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("explains when the server cannot detect host agents", async () => {
    stubApi(base);
    renderSettings();
    const note = await screen.findByText(/cannot detect host agents yet/);
    fireEvent.click(within(note).getByRole("button", { name: "Advanced" }));
    expect(
      await screen.findByRole("heading", { name: "API-key model providers" }),
    ).toBeInTheDocument();
  });

  it("switches Passport to a signed-in host agent without an API key", async () => {
    stubApi({
      ...base,
      "/host-agents": [
        {
          kind: "claude-code",
          installed: true,
          version: "2.1.0",
          loggedIn: true,
          account: "alex@example.com",
        },
        { kind: "codex", installed: true, loggedIn: false },
      ],
    });
    const save = vi.spyOn(api, "saveLlm").mockResolvedValue({} as never);
    renderSettings();
    const claude = await screen.findByRole("radio", { name: /Claude Code/ });
    expect(claude).toHaveTextContent("Signed in as alex@example.com");
    fireEvent.click(screen.getByRole("radio", { name: /Codex/ }));
    expect(screen.getByText(/codex login/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Codex" })).toBeDisabled();
    fireEvent.click(claude);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-opus-5-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Use Claude Code" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({ provider: "claude-code", model: "claude-opus-5-5" }),
    );
  });
});
