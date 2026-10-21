import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, nowIso } from "./index.js";

afterEach(() => vi.restoreAllMocks());

describe("identifiers and timestamps", () => {
  it("generates unique valid ULIDs in strict order within a millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000_000_000);
    const ids = Array.from({ length: 10_000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id))).toBe(true);
    expect(ids).toEqual([...ids].sort());
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let time = 0n;
    for (const character of ids[0]!.slice(0, 10))
      time = (time << 5n) | BigInt(alphabet.indexOf(character));
    expect(time).toBe(2_000_000_000_000n);
  });

  it("remains monotonic through clock rollback and recovery", () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(2_000_000_000_100);
    const first = newId();
    clock.mockReturnValue(1_000_000_000_000);
    const second = newId();
    clock.mockReturnValue(2_000_000_000_200);
    const third = newId();
    expect(first < second && second < third).toBe(true);
  });

  it("re-exports a UTC ISO timestamp helper", () => {
    const before = Date.now();
    const timestamp = nowIso();
    expect(timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(timestamp)).toBeLessThanOrEqual(Date.now());
  });
});
