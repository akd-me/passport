import { describe, expect, it } from "vitest";
import { createToolRegistry } from "./index.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./testing/fakes.js";

function tool(readOnly = false) {
  const store = new MemoryStore();
  const policy = new MemoryPolicy();
  return createToolRegistry({
    store,
    policy,
    executor: new MemoryExecutor(store, policy),
    bus: new MemoryBus(),
    actor: { kind: "agent", id: "run" },
    selfAddresses: [],
    readOnly,
  }).find((tool) => tool.name === "request_secret")!;
}
describe("request_secret guards", () => {
  it("requires a trusted task context and never accepts a value supplied by the model", async () => {
    const request = tool();
    expect(await request.handler({ text: "App password", clientRequestId: "imap" })).toMatchObject({
      isError: true,
      error: "TASK_REQUIRED",
    });
    expect(
      await request.handler({ text: "App password", clientRequestId: "imap", value: "bad" }),
    ).toMatchObject({
      isError: true,
    });
    expect(request.inputSchema).not.toHaveProperty("properties.value");
  });
  it("records a plan without displaying a private request or storing a value", async () => {
    expect(
      await tool(true).handler({ text: "App password", clientRequestId: "imap" }),
    ).toMatchObject({
      status: "planned",
      tool: "request_secret",
    });
  });
});
