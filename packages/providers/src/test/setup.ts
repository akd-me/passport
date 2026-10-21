import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live network is forbidden in provider tests; inject a fixture fetch");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});
