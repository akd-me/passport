import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { UiProvider } from "./ui-state";

/**
 * Stub `fetch` for `/api/*`: the longest matching path prefix wins; a function value receives
 * the request. Unknown routes answer 404 like the server does.
 */
export function stubApi(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api/, "");
    const key = Object.keys(routes)
      .filter((route) => path === route || path.startsWith(`${route}/`) || path.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined)
      return Response.json(
        { error: { code: "NOT_FOUND", message: "Unknown API route" } },
        { status: 404 },
      );
    const value = routes[key];
    const body = typeof value === "function" ? await value(url, init) : value;
    return body instanceof Response ? body : Response.json(body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function Harness({
  children,
  path = "/",
}: {
  children: ReactNode;
  path?: string;
}) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <UiProvider>{children}</UiProvider>
    </MemoryRouter>
  );
}
