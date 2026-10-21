import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "./api";
import { handleUnauthorized, initializeAuth, websocketUrl } from "./auth";

describe("web authentication", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    history.replaceState(null, "", "/");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("shows the token form and server-provided file hint before mounting an unauthenticated workspace", async () => {
    fetchMock.mockResolvedValue(
      response({
        authenticated: false,
        tokenPath: "/private/workspace/api-token",
      }),
    );
    const render = vi.fn();
    await initializeAuth(render);
    expect(render).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Sign in to Passport");
    expect(document.body.textContent).toContain("/private/workspace/api-token");
    expect(document.querySelector("input")?.type).toBe("password");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("mounts an authenticated workspace", async () => {
    fetchMock.mockResolvedValue(response({ authenticated: true }));
    const render = vi.fn();
    await initializeAuth(render);
    expect(render).toHaveBeenCalledOnce();
  });
  it("scrubs a Vite startup URL before exchanging its token and checking the session", async () => {
    history.replaceState(null, "", "/?token=dev-test-token&view=mail#section");
    fetchMock.mockImplementation(async (input) => {
      expect(location.search).not.toContain("token");
      return input === "/api/auth/login" ? response({}, 200) : response({ authenticated: true });
    });
    const render = vi.fn();
    await initializeAuth(render);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/auth/login",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ token: "dev-test-token" }),
      }),
    );
    expect(location.search).toBe("?view=mail");
    expect(location.hash).toBe("#section");
    expect(render).toHaveBeenCalledOnce();
  });
  it("sends pasted tokens through login and displays rejected-token errors", async () => {
    fetchMock
      .mockResolvedValueOnce(response({ authenticated: false }))
      .mockResolvedValueOnce(response({ error: { code: "UNAUTHORIZED" } }, 401));
    await initializeAuth(vi.fn());
    document.querySelector("input")!.value = "incorrect";
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("not accepted"),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/login",
      expect.objectContaining({ body: JSON.stringify({ token: "incorrect" }) }),
    );
    expect(document.querySelector("button")!.disabled).toBe(false);
  });
  it("sends the CSRF header and same-origin cookies on API mutations", async () => {
    fetchMock.mockResolvedValue(response({ ok: true }));
    await request("/trust/config", {
      method: "PUT",
      body: JSON.stringify({ globalMode: "supervised" }),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trust/config",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({
          "X-Requested-With": "passport",
          "Content-Type": "application/json",
        }),
      }),
    );
  });
  it("returns to the login gate on 401 while preserving the API error", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { replace } });
    fetchMock.mockResolvedValue(
      response({ error: { code: "UNAUTHORIZED", message: "Sign in" } }, 401),
    );
    await expect(request("/health")).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(replace).toHaveBeenCalledWith("/");
    replace.mockClear();
    handleUnauthorized(response({}, 403));
    expect(replace).not.toHaveBeenCalled();
  });
  it("uses a same-origin WebSocket URL without exposing tokens", () => {
    expect(websocketUrl()).toBe(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    );
    expect(websocketUrl()).not.toContain("token");
  });
});
