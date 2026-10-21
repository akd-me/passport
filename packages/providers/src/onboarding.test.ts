import { describe, expect, it } from "vitest";
import gmail from "./fixtures/gmail.json" with { type: "json" };
import sample from "./fixtures/graph.json" with { type: "json" };
import window from "./fixtures/graph-window.json" with { type: "json" };
import { GoogleCalendarProvider } from "./google-calendar.js";
import { GraphMailProvider } from "./graph.js";
import { createProviderRegistry } from "./registry.js";
import { account, collect, fixtureFetch, lastCursor, response } from "./test/helpers.js";

describe("real-account adapter regressions", () => {
  it("keeps Gmail's date query on every full-sync page and captures the history watermark before listing", async () => {
    const calls: string[] = [];
    const p = createProviderRegistry({
      fetch: fixtureFetch((url) => {
        calls.push(url.pathname);
        if (url.pathname.endsWith("/labels")) return response({ labels: [] });
        if (url.pathname.endsWith("/profile")) return response({ historyId: "watermark" });
        if (url.pathname.endsWith("/messages")) {
          expect(url.searchParams.get("q")).toBe("after:1767225600");
          return response(
            url.searchParams.has("pageToken")
              ? { messages: [{ id: "b" }] }
              : { messages: [{ id: "a" }], nextPageToken: "next" },
          );
        }
        return response({ ...gmail, id: url.pathname.split("/").pop() });
      }),
    }).mail("gmail");
    await p.connect(account, { access_token: "token" });
    const changes = await collect(p.sync(null, { since: "2026-01-01T00:00:00Z" }));
    expect(lastCursor(changes)).toBe("watermark");
    expect(changes.filter((d) => d.kind === "email")).toHaveLength(2);
    expect(calls.findIndex((c) => c.endsWith("/profile"))).toBeLessThan(
      calls.findIndex((c) => c.endsWith("/messages")),
    );
  });
  it("drains folder/message nextLinks to deltaLinks and skips old Graph bodies while widening fresh snapshots", async () => {
    const bodies: string[] = [],
      calls: URL[] = [];
    const p = new GraphMailProvider({
      fetch: fixtureFetch((url, init) => {
        calls.push(url);
        expect(new Headers(init.headers).get("Prefer")).toContain('IdType="ImmutableId"');
        if (url.pathname.endsWith("/mailFolders/delta")) return response(window.folderPages[0]);
        if (url.pathname.endsWith("/folder-page-2")) return response(window.folderPages[1]);
        if (url.pathname.endsWith("/folder-state"))
          return response({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/folder-state",
          });
        if (
          /\/mailFolders\/(inbox|archive|drafts|sentitems|deleteditems|junkemail)$/.test(
            url.pathname,
          )
        )
          return response({}, 404);
        if (url.pathname.endsWith("/child-id/messages/delta"))
          return response({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/child-state",
          });
        if (url.pathname.endsWith("/messages/delta")) {
          expect(new Headers(init.headers).get("Prefer")).toContain("odata.maxpagesize=100");
          expect(url.searchParams.get("$orderby")).toBe("receivedDateTime desc");
          return response(window.messagePages[0]);
        }
        if (url.pathname.endsWith("/message-page-2")) return response(window.messagePages[1]);
        if (url.pathname.endsWith("/message-state") || url.pathname.endsWith("/child-state"))
          return response({ value: [], "@odata.deltaLink": url.href });
        bodies.push(url.pathname);
        return response({
          ...sample,
          id: url.pathname.split("/").pop(),
          receivedDateTime: url.pathname.endsWith("/older")
            ? "2025-01-01T00:00:00Z"
            : "2026-02-20T12:00:00Z",
          hasAttachments: false,
          attachments: [],
        });
      }),
    });
    await p.connect(account, { access_token: "token" });
    const first = await collect(p.sync(null, { since: "2026-02-01T00:00:00Z" }));
    expect(bodies).toEqual(["/v1.0/me/messages/recent"]);
    expect(first.filter((d) => d.kind === "mailbox")).toHaveLength(2);
    const cursor = lastCursor(first);
    await collect(p.sync(cursor));
    expect(calls.some((u) => u.pathname.endsWith("/folder-state"))).toBe(true);
    expect(calls.some((u) => u.pathname.endsWith("/message-state"))).toBe(true);
    await collect(p.sync(null, { since: "2024-01-01T00:00:00Z" }));
    expect(bodies).toContain("/v1.0/me/messages/older");
  });
  it.each(["folder", "messages"])(
    "reports Graph 410 on %s delta as an expired cursor",
    async (kind) => {
      const p = new GraphMailProvider({
        fetch: fixtureFetch((url) => {
          if (url.pathname.endsWith("/mailFolders/delta") && kind !== "folder")
            return response({
              value: [{ id: "f", displayName: "Inbox" }],
              "@odata.deltaLink": "https://graph.microsoft.com/v1.0/folders-state",
            });
          if (url.pathname.endsWith("/messages/delta") || kind === "folder")
            return response({}, 410);
          return response({}, 404);
        }),
      });
      await p.connect(account, { access_token: "token" });
      await expect(collect(p.sync(null))).rejects.toMatchObject({
        code: "CURSOR_EXPIRED",
      });
    },
  );
  it("uses Google event-feed metadata with calendar.events and keeps all-day timezone normalization", async () => {
    const fetcher = fixtureFetch((url) => {
      expect(url.pathname).not.toContain("calendarList");
      if (url.searchParams.get("maxResults") === "1")
        return response({
          summary: "Personal",
          timeZone: "America/New_York",
          items: [],
        });
      return response({
        items: [
          {
            id: "all-day",
            start: { date: "2026-02-20" },
            end: { date: "2026-02-21" },
          },
        ],
        nextSyncToken: "next",
      });
    });
    const p = new GoogleCalendarProvider({ fetch: fetcher });
    await p.connect(account, {
      access_token: "token",
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
    });
    expect((await p.listCalendars())[0]).toMatchObject({
      providerId: "primary",
      timeZone: "America/New_York",
    });
    const changes = await collect(p.sync(null));
    expect(changes.find((d) => d.kind === "event")).toMatchObject({
      event: { start: "2026-02-20T05:00:00.000Z" },
    });
  });
  it.each(["gmail", "graph"] as const)(
    "supports %s public PKCE and per-attempt scopes without a client secret",
    async (kind) => {
      const fetcher = fixtureFetch((_url, init) => {
        const body = new URLSearchParams(String(init.body));
        expect(body.get("client_secret")).toBeNull();
        expect(body.get("code_verifier")).toBe("verifier");
        if (kind === "graph") expect(body.get("scope")).toBe("openid email User.Read");
        return response({ access_token: "new", refresh_token: "refresh" });
      });
      const oauth = createProviderRegistry({ fetch: fetcher }).describe(kind).oauth!;
      const settings = {
        clientId: "public",
        codeVerifier: "verifier",
        scopes: "openid email User.Read",
      };
      const url = new URL(
        oauth.buildAuthUrl(settings, "http://127.0.0.1:3000/oauth/callback", "state"),
      );
      expect(url.searchParams.get("scope")).toBe(settings.scopes);
      expect(url.searchParams.has("include_granted_scopes")).toBe(false);
      await expect(
        oauth.exchangeCode(settings, "http://127.0.0.1:3000/oauth/callback", "code"),
      ).resolves.toMatchObject({ refresh_token: "refresh" });
    },
  );
  it("turns a denied refresh into a re-authorization error while leaving throttling retryable", async () => {
    for (const [status, code] of [
      [400, "OAUTH_REFRESH_FAILED"],
      [429, "RATE_LIMITED"],
      [503, "HTTP_503"],
    ] as const) {
      const p = createProviderRegistry({
        fetch: fixtureFetch(() => response({ error: "private" }, status)),
      }).mail("gmail");
      await p.connect(
        { ...account, settings: { clientId: "client" } },
        { access_token: "expired", refresh_token: "revoked", expires_at: "1" },
      );
      await expect(p.getEmail("id")).rejects.toMatchObject({ code });
    }
  });
});
