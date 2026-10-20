import { describe, expect, it } from "vitest";
import type { ProviderKind } from "@passport/types";
import { createProviderRegistry } from "./registry.js";
import { account, collect, fixtureFetch, response } from "./test/helpers.js";

describe("registry and setup", () => {
  it.each(["gmail", "graph", "google-calendar", "graph-calendar"] as ProviderKind[])("builds scoped %s consent URLs without exposing client secrets", kind => {
    const descriptor = createProviderRegistry().describe(kind), oauth = descriptor.oauth!;
    const url = new URL(oauth.buildAuthUrl({ clientId: "own-client", clientSecret: "never-in-the-url", tenantId: "my-tenant", codeVerifier: "test-verifier" }, "http://localhost:3000/oauth/callback", "random-state"));
    expect(url.searchParams.get("state")).toBe("random-state"); expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/oauth/callback"); expect(url.searchParams.get("client_id")).toBe("own-client"); expect(url.searchParams.get("scope")?.split(" ")).toEqual(oauth.scopes); expect(url.href).not.toContain("never-in-the-url"); expect(url.searchParams.get("code_challenge_method")).toBe("S256"); expect(descriptor.fields.find(f => f.id === "clientSecret")?.secret).toBe(true);
    if (kind === "gmail" || kind === "google-calendar") { expect(url.searchParams.get("access_type")).toBe("offline"); expect(url.searchParams.get("prompt")).toBe("consent"); } else { expect(url.pathname).toContain("my-tenant"); expect(oauth.scopes).toContain("offline_access"); }
  });
  it.each(["gmail", "graph"] as ProviderKind[])("exchanges %s codes with the supplied client and retains refresh credentials", async kind => {
    const fetcher = fixtureFetch((_url, init) => { const body = new URLSearchParams(String(init.body)); expect(body.get("grant_type")).toBe("authorization_code"); expect(body.get("client_secret")).toBe("own-secret"); expect(body.get("code_verifier")).toBe("verifier"); return response({ access_token: "new", refresh_token: "refresh", expires_in: 3600 }); });
    const tokens = await createProviderRegistry({ fetch: fetcher }).describe(kind).oauth!.exchangeCode({ clientId: "own-client", clientSecret: "own-secret", codeVerifier: "verifier" }, "http://localhost/callback", "code");
    expect(tokens).toMatchObject({ access_token: "new", refresh_token: "refresh", clientSecret: "own-secret" }); expect(Number(tokens.expires_at)).toBeGreaterThan(Date.now()); expect(tokens).not.toHaveProperty("codeVerifier");
  });
  it("requires PKCE for Microsoft public clients and nonempty OAuth state", async () => {
    const oauth = createProviderRegistry().describe("graph").oauth!;
    await expect(oauth.exchangeCode({ clientId: "client" }, "http://localhost", "code")).rejects.toMatchObject({ code: "CONFIG_REQUIRED" }); expect(() => oauth.buildAuthUrl({ clientId: "client" }, "http://localhost", "")).toThrow();
  });
  it("provides mail/calendar factories and descriptors for every supported kind", () => {
    const registry = createProviderRegistry();
    for (const kind of ["gmail", "graph", "imap", "jmap", "mock"] as const) { expect(registry.mail(kind).kind).toBe(kind); expect(registry.mail(kind)).not.toBe(registry.mail(kind)); expect(registry.describe(kind).label).toBeTruthy(); }
    for (const kind of ["google-calendar", "graph-calendar", "caldav", "mock"] as const) expect(registry.calendar(kind).kind).toBe(kind);
    expect(() => registry.calendar("jmap-calendar")).toThrow(expect.objectContaining({ code: "NOT_IMPLEMENTED" }));
  });
  it("refreshes OAuth tokens once for concurrent requests and persists rotations", async () => {
    let refreshes = 0; const saved: unknown[] = [];
    const fetcher = fixtureFetch((url, init) => {
      if (url.hostname === "oauth2.googleapis.com") { refreshes++; expect(new URLSearchParams(String(init.body)).get("refresh_token")).toBe("old-refresh"); return response({ access_token: "new-token", refresh_token: "rotated-refresh", expires_in: 3600 }); }
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer new-token"); return response({ id: "m", payload: { headers: [] }, labelIds: [] });
    });
    const p = createProviderRegistry({ fetch: fetcher, onCredentials: (_id, credentials) => { saved.push(credentials); } }).mail("gmail");
    await p.connect({ ...account, settings: { clientId: "client" } }, { refresh_token: "old-refresh", clientSecret: "secret", expires_at: "1" }); await Promise.all([p.getEmail("m"), p.getEmail("m")]);
    expect(refreshes).toBe(1); expect(saved).toContainEqual(expect.objectContaining({ refresh_token: "rotated-refresh", clientSecret: "secret" }));
  });
  it("retries one expired Microsoft access token after HTTP 401", async () => {
    let calls = 0;
    const fetcher = fixtureFetch((url, init) => {
      if (url.hostname === "login.microsoftonline.com") return response({ access_token: "new-token", expires_in: 3600 });
      calls++; return calls === 1 ? response({ error: "expired" }, 401) : (expect(new Headers(init.headers).get("authorization")).toBe("Bearer new-token"), response({ id: "m" }));
    });
    const p = createProviderRegistry({ fetch: fetcher }).mail("graph"); await p.connect({ ...account, settings: { clientId: "client" } }, { access_token: "old-token", refresh_token: "refresh", clientSecret: "secret" }); expect((await p.getEmail("m"))?.providerId).toBe("m"); expect(calls).toBe(2);
  });
  it("redacts remote error bodies and network exception messages", async () => {
    const fetcher = fixtureFetch(() => response("secret-token-and-body", 403)); const p = createProviderRegistry({ fetch: fetcher }).mail("gmail"); await p.connect(account, { access_token: "token" });
    await expect(p.getEmail("m")).rejects.toMatchObject({ code: "HTTP_403", message: "Provider request failed (HTTP 403)" });
    const q = createProviderRegistry({ fetch: fixtureFetch(() => { throw new Error("secret-token"); }) }).mail("gmail"); await q.connect(account, { access_token: "token" }); await expect(q.getEmail("m")).rejects.toMatchObject({ code: "NETWORK_ERROR", message: "Provider request failed or timed out" });
  });
  it("all unconnected sync adapters fail with a coded error", async () => {
    const r = createProviderRegistry();
    for (const kind of ["gmail", "graph", "imap", "jmap", "mock"] as const) await expect(collect(r.mail(kind).sync(null))).rejects.toMatchObject({ code: "NOT_CONNECTED" });
    for (const kind of ["google-calendar", "graph-calendar", "caldav", "mock"] as const) await expect(collect(r.calendar(kind).sync(null))).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
});
