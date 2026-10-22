import { describe, expect, it } from "vitest";
import { PriorityRunQueue } from "./agent-queue.js";

describe("R2-4 interactive runs overtake queued background runs", () => {
  it("starts a manual run second, behind only the run already in progress", async () => {
    const queue = new PriorityRunQueue();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const job = (name: string, wait?: Promise<void>) => async () => {
      started.push(name);
      await wait;
      return name;
    };
    const runs = [
      queue.enqueue("background", job("arrival-1", gate)),
      queue.enqueue("background", job("arrival-2")),
      queue.enqueue("background", job("arrival-3")),
      queue.enqueue("interactive", job("manual")),
    ];
    expect(queue.depth()).toEqual({ interactive: 1, background: 2 });
    release();
    await Promise.all(runs);
    expect(started).toEqual(["arrival-1", "manual", "arrival-2", "arrival-3"]);
  });
});
