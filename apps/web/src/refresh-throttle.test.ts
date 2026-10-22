import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefreshThrottle } from "./refresh-throttle";

describe("workspace refresh throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores watcher ticks that found nothing new", () => {
    const refresh = vi.fn();
    const throttle = createRefreshThrottle(refresh);
    throttle.push({ type: "account.watch.tick", added: 0, arrivals: 0 });
    vi.advanceTimersByTime(60_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("coalesces a burst into one refetch", () => {
    const refresh = vi.fn();
    const throttle = createRefreshThrottle(refresh);
    for (let i = 0; i < 20; i++) {
      throttle.push({ type: "action.updated" });
    }
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("spaces refetches per event type without delaying other types", () => {
    const refresh = vi.fn();
    const throttle = createRefreshThrottle(refresh);
    throttle.push({ type: "account.watch.tick", added: 1, arrivals: 1 });
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(1);
    throttle.push({ type: "account.watch.tick", added: 2, arrivals: 0 });
    vi.advanceTimersByTime(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    // A decision arriving meanwhile is not held back by the tick's spacing.
    throttle.push({ type: "action.created" });
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    throttle.push({ type: "account.watch.tick", added: 1, arrivals: 0 });
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("cancels a pending refetch", () => {
    const refresh = vi.fn();
    const throttle = createRefreshThrottle(refresh);
    throttle.push({ type: "email.received" });
    throttle.cancel();
    vi.advanceTimersByTime(1_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
