import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Harness } from "../test-utils";
import { AccountRow, watchLabel, watchSummary } from "./AccountRow";
import type { ConnectedAccount } from "./api";

const now = new Date();
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const account: ConnectedAccount = {
  id: "work",
  kind: "gmail",
  displayName: "Work",
  emailAddress: "work@example.com",
  capabilities: {
    mail: true,
    calendar: false,
    contacts: false,
    push: false,
    labels: true,
    submit: true,
    search: true,
  },
  settings: {},
  createdAt: minutesAgo(600),
  updatedAt: minutesAgo(600),
  messageCount: 1234,
  watch: {
    since: minutesAgo(600),
    lastTickAt: minutesAgo(2),
    cursorAgeSeconds: 120,
    status: "watching",
  },
};

describe("account watcher status", () => {
  it("shows when watching started, the last check and the Inbox count, with no backfill", () => {
    render(
      <Harness>
        <AccountRow account={account} reauthorize={() => {}} />
      </Harness>,
    );
    expect(screen.getByText(/^Watching since .+ · last check 2m ago$/)).toBeInTheDocument();
    expect(screen.getByText(`${(1234).toLocaleString()} in Inbox`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check now/ })).toBeEnabled();
    expect(screen.queryByText("Load older mail")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Backfill" })).not.toBeInTheDocument();
  });

  it("labels watching, paused and needs-sign-in states for the sidebar", () => {
    expect(watchLabel(account)).toBe("Watching");
    const backoff: ConnectedAccount = {
      ...account,
      watch: { ...account.watch!, status: "backoff", retryAt: minutesAgo(-5) },
    };
    expect(watchLabel(backoff)).toBe("Paused");
    expect(watchSummary(backoff)).toBe("Paused by the provider's rate limit · next check in 5m");
    expect(watchLabel({ ...account, settings: { reauthorizationRequired: true } })).toBe(
      "Needs sign-in",
    );
    expect(
      watchSummary({ ...account, watch: { ...account.watch!, since: null, status: "starting" } }),
    ).toBe("Starting to watch for new mail…");
  });
});
