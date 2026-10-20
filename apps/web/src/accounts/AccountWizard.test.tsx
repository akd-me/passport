import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Routes, Route } from "react-router";
import { AccountWizard } from "./AccountWizard";
import { Accounts } from "../views/Accounts";
import { AccountFilter, AccountScope } from "./AccountFilter";
import { StartPage } from "./StartPage";
import type { Account } from "@passport/types";
import { accountApi } from "./api";
import { api, type ProviderDescriptor } from "../api";

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
  it("routes an empty workspace to Accounts so initial sync can finish on that page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ accounts: [] })),
    );
    render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<StartPage />} />
          <Route path="/accounts" element={<p>Account onboarding</p>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Account onboarding")).toBeInTheDocument();
  });
  it("shows the desktop guide, enables PKCE browser setup and honors optional calendar access", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const add = vi.spyOn(api, "addAccount");
    const start = vi.spyOn(accountApi, "start").mockResolvedValue({
      authUrl: "https://accounts.google.com/authorize",
      attemptId: "pending",
      redirectUri: "http://127.0.0.1:3000/oauth/callback",
    });
    vi.spyOn(accountApi, "status").mockResolvedValue({ status: "authorizing" });
    render(<AccountWizard providers={providers} onClose={() => {}} />);
    expect(screen.getByText(/Desktop app/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("OAuth client ID"), {
      target: { value: "my-client" },
    });
    expect(
      screen.getByRole("checkbox", { name: "Connect calendar too" }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Connect calendar too" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        kind: "gmail",
        clientId: "my-client",
        calendar: false,
        accountId: undefined,
      }),
    );
    expect(
      await screen.findByText(/Waiting for authorization/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open authorization tab" }),
    ).toHaveAttribute("target", "_blank");
    expect(add).not.toHaveBeenCalled();
  });
  it("shows Microsoft public-client instructions and the redirect path", () => {
    render(<AccountWizard providers={providers} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Provider"), {
      target: { value: "graph" },
    });
    expect(screen.getByText(/Allow public client flows/)).toBeInTheDocument();
    expect(
      screen.getByText(/Mobile and desktop applications/),
    ).toBeInTheDocument();
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
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Check your app password.",
    );
    expect(test.mock.calls[0]![0]).toMatchObject({
      kind: "imap",
      fields: { host: "imap.example.com", password: "app-secret" },
    });
  });
  it("shows the wizard automatically for an empty workspace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.endsWith("/providers")
            ? providers
            : url.endsWith("/user-profile")
              ? { markdown: "" }
              : {
                  accounts: [],
                  mode: "real",
                  llm: {
                    provider: "anthropic",
                    model: "test",
                    apiKeyConfigured: false,
                  },
                },
        ),
      ),
    );
    render(<Accounts />);
    expect(
      await screen.findByRole("heading", { name: "Connect a mailbox" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
  });
  it("updates accountId in the URL while preserving other filters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          accounts: [
            {
              id: "work",
              kind: "gmail",
              emailAddress: "work@example.com",
              capabilities: { mail: true },
            },
          ],
        }),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/matters?accountId=work&status=active"]}>
        <AccountScope>
          <AccountFilter />
        </AccountScope>
      </MemoryRouter>,
    );
    await screen.findByRole("option", { name: "work@example.com · gmail" });
    expect(
      screen.getByRole("combobox", { name: "Filter by account" }),
    ).toHaveValue("work");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
});
