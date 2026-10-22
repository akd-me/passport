import type { Account } from "@passport/types";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { api, type ProviderDescriptor } from "../api";
import { Sidebar } from "../shell/Sidebar";
import { Harness, stubApi } from "../test-utils";
import { AccountScope } from "./AccountFilter";
import { AccountWizard } from "./AccountWizard";
import { accountApi } from "./api";

const providers: ProviderDescriptor[] = [
  { kind: "gmail", label: "Gmail", fields: [], oauth: { scopes: [] } },
  { kind: "graph", label: "Outlook", fields: [], oauth: { scopes: [] } },
  {
    kind: "imap",
    label: "IMAP",
    fields: [
      { id: "host", label: "IMAP host", secret: false, required: true },
      { id: "password", label: "App password", secret: true, required: true },
    ],
  },
];
describe("account wizard", () => {
  it("sends only descriptor fields when switching to a mock account", async () => {
    const added = { id: "new-mock" } as Account;
    const add = vi.spyOn(api, "addAccount").mockResolvedValue(added);
    const sync = vi.spyOn(api, "sync").mockResolvedValue({ ok: true });
    const onClose = vi.fn();
    render(
      <AccountWizard
        providers={[...providers, { kind: "mock", label: "Demo", fields: [] }]}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "mock" },
    });
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "alex@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add account" }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({
        kind: "mock",
        emailAddress: "alex@example.com",
        displayName: "",
        fields: {},
      }),
    );
    expect(sync).toHaveBeenCalledWith("new-mock");
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
  it("shows the desktop guide, enables PKCE browser setup and honors optional calendar access", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const add = vi.spyOn(api, "addAccount");
    const start = vi.spyOn(accountApi, "start").mockResolvedValue({
      authUrl: "https://accounts.google.com/authorize",
      launchUrl: "http://127.0.0.1:3000/oauth/launch/ticket",
      attemptId: "pending",
      redirectUri: "http://127.0.0.1:3000/oauth/callback",
    });
    vi.spyOn(accountApi, "status").mockResolvedValue({ status: "authorizing" });
    render(<AccountWizard providers={providers} onClose={() => {}} />);
    expect(screen.getByText(/Desktop app/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("OAuth client ID"), {
      target: { value: "my-client" },
    });
    expect(screen.getByRole("checkbox", { name: "Connect calendar too" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Connect calendar too" }));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        kind: "gmail",
        clientId: "my-client",
        calendar: false,
        accountId: undefined,
      }),
    );
    expect(await screen.findByText(/Waiting for authorization/)).toBeInTheDocument();
    // R3-1: with no tab of its own (the Mac app), consent goes through the binding launch URL.
    expect(open).toHaveBeenLastCalledWith(
      "http://127.0.0.1:3000/oauth/launch/ticket",
      "_blank",
      "noopener",
    );
    expect(screen.getByRole("link", { name: "Open authorization tab" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(add).not.toHaveBeenCalled();
  });
  it("shows Microsoft public-client instructions and the redirect path", () => {
    render(<AccountWizard providers={providers} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "graph" },
    });
    expect(screen.getByText(/Allow public client flows/)).toBeInTheDocument();
    expect(screen.getByText(/Mobile and desktop applications/)).toBeInTheDocument();
    expect(screen.getByText(/\/oauth\/callback/)).toBeInTheDocument();
  });
  it("tests IMAP without saving and displays failures in the wizard", async () => {
    const test = vi
      .spyOn(accountApi, "test")
      .mockRejectedValue(new Error("Check your app password."));
    render(<AccountWizard providers={providers} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "imap" },
    });
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "alex@example.com" },
    });
    fireEvent.change(screen.getByLabelText("IMAP host"), {
      target: { value: "imap.example.com" },
    });
    fireEvent.change(screen.getByLabelText("App password"), {
      target: { value: "app-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(test).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your app password.");
    expect(test.mock.calls[0]![0]).toMatchObject({
      kind: "imap",
      fields: { host: "imap.example.com", password: "app-secret" },
    });
  });
  it("preselects the provider chosen before falling back to manual setup", () => {
    render(<AccountWizard providers={providers} initialKind="graph" onClose={() => {}} />);
    expect(screen.getByLabelText("Provider")).toHaveValue("graph");
    expect(screen.getByText(/Allow public client flows/)).toBeInTheDocument();
  });
});

const workAccount = {
  id: "work",
  kind: "gmail",
  displayName: "Work",
  emailAddress: "work@example.com",
  capabilities: { mail: true },
  settings: {},
  lastSyncAt: new Date().toISOString(),
};
function LocationProbe() {
  const location = useLocation();
  return <output aria-label="location">{location.pathname + location.search}</output>;
}

describe("account onboarding in the shell", () => {
  it("shows the connect flow in place of the queue for an empty workspace", async () => {
    stubApi({
      "/accounts": {
        accounts: [],
        mode: "real",
        llm: { provider: "anthropic", model: "m", apiKeyConfigured: false },
      },
      "/decisions": { items: [] },
      "/matters": [],
      "/people": [],
      "/trust": {
        config: { globalMode: "supervised", alwaysAsk: [] },
        categories: [],
        promotionOffers: [],
      },
    });
    render(
      <Harness>
        <App />
      </Harness>,
    );
    expect(
      await screen.findByRole("heading", { name: "Connect the mailbox Passport should work on" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Gmail" })).toBeEnabled();
    expect(screen.queryByRole("heading", { name: /proposals? need/ })).not.toBeInTheDocument();
  });
  it("opens Settings → Accounts for the legacy /accounts URL the OAuth callback returns to", async () => {
    stubApi({
      "/accounts": {
        accounts: [workAccount],
        mode: "real",
        llm: { provider: "anthropic", model: "m", apiKeyConfigured: true },
      },
      "/providers": providers,
      "/decisions": { items: [] },
      "/actions": { items: [] },
      "/matters": [],
      "/people": [],
      "/trust": {
        config: { globalMode: "supervised", alwaysAsk: [] },
        categories: [],
        promotionOffers: [],
      },
    });
    render(
      <Harness path="/accounts?connected=work">
        <App />
      </Harness>,
    );
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveTextContent("Connected accounts");
    expect(await screen.findAllByText("work@example.com")).not.toHaveLength(0);
  });
  it("scopes to one account from the sidebar while preserving other filters", async () => {
    stubApi({
      "/accounts": { accounts: [workAccount], mode: "real" },
      "/decisions": { items: [] },
      "/matters": [],
      "/people": [],
      "/trust": {
        config: { globalMode: "supervised", alwaysAsk: [] },
        categories: [],
        promotionOffers: [],
      },
    });
    render(
      <Harness path="/matters?status=active">
        <AccountScope>
          <Sidebar />
          <Routes>
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </AccountScope>
      </Harness>,
    );
    const account = await screen.findByRole("button", { name: /work@example\.com/ });
    expect(account).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(account);
    expect(screen.getByLabelText("location")).toHaveTextContent(
      "/matters?status=active&accountId=work",
    );
    expect(account).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(account);
    expect(screen.getByLabelText("location")).toHaveTextContent("/matters?status=active");
  });
});
