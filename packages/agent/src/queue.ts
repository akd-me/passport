import type { AgentRunPriority } from "@passport/types";

interface Entry {
  priority: AgentRunPriority;
  start: () => void;
}

/**
 * One-at-a-time run queue. Interactive entries start before every queued background entry (FIFO
 * within a priority); nothing preempts the run in progress. Wave 2 splits these into lanes.
 */
export class RunQueue {
  private readonly waiting: Entry[] = [];
  private running = false;

  constructor(private readonly log?: (message: string) => void) {}

  /** Entries waiting to start, by priority. */
  depth(): Record<AgentRunPriority, number> {
    return {
      interactive: this.waiting.filter((entry) => entry.priority === "interactive").length,
      background: this.waiting.filter((entry) => entry.priority === "background").length,
    };
  }

  enqueue<T>(priority: AgentRunPriority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = {
        priority,
        start: () => {
          task()
            .then(resolve, (error: unknown) => {
              // Agent queue operation failed; later runs may continue.
              this.log?.("Agent queue operation failed; later runs may continue");
              reject(error);
            })
            .finally(() => {
              this.running = false;
              this.next();
            });
        },
      };
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
