import type { AgentRunPriority, AgentTrigger } from "@passport/types";
import { ApiError } from "../errors.js";

interface Entry {
  priority: AgentRunPriority;
  start: () => void;
  cancel: () => void;
}

/** Interactive runs (composer, task messages) unless the caller says otherwise. */
export function runPriority(trigger: AgentTrigger, priority?: AgentRunPriority): AgentRunPriority {
  return priority ?? (trigger.kind === "manual" ? "interactive" : "background");
}

/**
 * The composition root's single agent serialization boundary, with two lanes: an interactive run
 * starts before every waiting background run (arrivals, routines, wakes); nothing preempts the run
 * in progress. A waiting entry whose signal aborts leaves the queue at once with `RUN_CANCELLED`.
 */
export class LaneQueue {
  private readonly waiting: Entry[] = [];
  private running = false;

  depth(): Record<AgentRunPriority, number> {
    return {
      interactive: this.waiting.filter((entry) => entry.priority === "interactive").length,
      background: this.waiting.filter((entry) => entry.priority === "background").length,
    };
  }

  enqueue<T>(priority: AgentRunPriority, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(cancelledError());
        return;
      }
      const onAbort = () => entry.cancel();
      const entry: Entry = {
        priority,
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          task()
            .then(resolve, reject)
            .finally(() => {
              this.running = false;
              this.next();
            });
        },
        cancel: () => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            reject(cancelledError());
          }
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const at =
        priority === "interactive"
          ? this.waiting.findIndex((item) => item.priority === "background")
          : -1;
      this.waiting.splice(at === -1 ? this.waiting.length : at, 0, entry);
      this.next();
    });
  }

  private next(): void {
    if (this.running) {
      return;
    }
    const entry = this.waiting.shift();
    if (entry) {
      this.running = true;
      entry.start();
    }
  }
}

export function cancelledError(): ApiError {
  return new ApiError("RUN_CANCELLED", "Run cancelled", 409);
}
