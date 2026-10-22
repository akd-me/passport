import { describe, expect, it } from "vitest";
import { eventScopes, resourceScope } from "../state";
import { syncSummary, watchDetail } from "./AccountRow";
import type { ConnectedAccount } from "./api";

const account: ConnectedAccount = {
  id: "a",
  kind: "gmail",
  displayName: "Alex",
  emailAddress: "alex@example.com",
  capabilities: {
    mail: true,
    calendar: false,
    contacts: false,
    push: false,
    labels: true,
    submit: true,
  },
  settings: {},
  createdAt: "2026-10-22T09:00:00.000Z",
  updatedAt: "2026-10-22T09:00:00.000Z",
  messageCount: 12,
  watch: {
    since: "2026-10-22T09:00:00.000Z",
    lastTickAt: new Date().toISOString(),
    cursorAgeSeconds: 5,
    status: "watching",
  },
};

describe("watcher status copy", () => {
  it("shows Watching / Paused / Needs sign-in instead of sync progress", () => {
    expect(syncSummary(account)).toBe("Watching");
    expect(watchDetail(account)).toMatch(/^Watching since .+ · last check just now$/);
    expect(syncSummary({ ...account, watch: { ...account.watch!, status: "backoff" } })).toBe(
      "Paused",
    );
    expect(syncSummary({ ...account, settings: { reauthorizationRequired: true } })).toBe(
      "Needs sign-in",
    );
  });
  it("scopes refetches to the resources an event can change", () => {
    expect(eventScopes("account.watch.tick")).toEqual(["accounts", "doctor"]);
    expect(eventScopes("job.finished")).toEqual(["jobs"]);
    expect(eventScopes("action.proposed")).toBeNull();
    expect(resourceScope("/accounts?x=1")).toBe("accounts");
    expect(resourceScope("/jobs/watch%3Aa/history")).toBe("jobs");
  });
});
