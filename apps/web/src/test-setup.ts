import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
// Node 25 ships a global `localStorage` that shadows jsdom's and lacks methods without
// --localstorage-file; give tests a working in-memory Storage.
if (typeof globalThis.localStorage?.clear !== "function") {
  const data = new Map<string, string>();
  const storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  } satisfies Storage;
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
