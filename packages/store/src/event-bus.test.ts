import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "./index.js";

afterEach(() => vi.restoreAllMocks());

describe("InMemoryEventBus", () => {
  it("fans out synchronously to typed and catch-all handlers", () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.on("email.updated", (event) => seen.push(event.emailId));
    bus.on("email.updated", () => seen.push("second"));
    bus.on("agent.run.started", () => seen.push("unrelated"));
    bus.onAny((event) => seen.push(event.type));
    bus.emit({ type: "email.updated", emailId: "email" });
    expect(seen).toEqual(["email", "second", "email.updated"]);
  });

  it("unsubscribes independently and idempotently, including after a new subscription", () => {
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    const first = bus.on("email.updated", handler);
    const second = bus.on("email.updated", handler);
    const any = bus.onAny(handler);
    first();
    first();
    any();
    any();
    bus.emit({ type: "email.updated", emailId: "email" });
    expect(handler).toHaveBeenCalledTimes(1);
    second();
    bus.on("email.updated", handler);
    second();
    bus.emit({ type: "email.updated", emailId: "email" });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("isolates thrown errors and logs only safe event metadata", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    bus.on("email.updated", () => {
      throw new Error("secret body or credential");
    });
    bus.on("email.updated", handler);
    bus.onAny(() => {
      throw new Error("another secret");
    });
    bus.onAny(handler);
    expect(() => bus.emit({ type: "email.updated", emailId: "email" })).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret");
  });

  it("isolates rejected async consumers without delaying synchronous dispatch", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new InMemoryEventBus();
    const handler = vi.fn();
    bus.on("email.updated", async () => {
      throw new Error("private");
    });
    bus.onAny(handler);
    bus.emit({ type: "email.updated", emailId: "email" });
    expect(handler).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("snapshots subscriptions so changes during dispatch apply on the next emit", () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    let remove = () => {};
    bus.on("email.updated", () => {
      seen.push("first");
      remove();
      bus.onAny(() => seen.push("new"));
    });
    remove = bus.on("email.updated", () => seen.push("removed"));
    bus.emit({ type: "email.updated", emailId: "email" });
    expect(seen).toEqual(["first", "removed"]);
    seen.length = 0;
    bus.emit({ type: "email.updated", emailId: "email" });
    expect(seen).toEqual(["first", "new"]);
  });
});
