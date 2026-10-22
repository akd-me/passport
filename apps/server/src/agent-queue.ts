import type { AgentRunPriority } from "@passport/types";

/**
 * The composition root's single run boundary (the executor wrapper reads the current trigger).
 * Interactive runs (composer, manual triage) start before queued background runs (arrivals,
 * schedules); FIFO within a priority; nothing preempts the run in progress.
 */
export class PriorityRunQueue {
  private readonly waiting: Record<AgentRunPriority, Array<() => void>> = {
    interactive: [],
    background: [],
  };
  private running = false;

  depth(): Record<AgentRunPriority, number> {
    return {
      interactive: this.waiting.interactive.length,
      background: this.waiting.background.length,
    };
  }

  enqueue<T>(priority: AgentRunPriority, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting[priority].push(() => {
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            this.running = false;
            this.next();
          });
      });
      this.next();
    });
  }

  private next(): void {
    if (this.running) {
      return;
    }
    const start = this.waiting.interactive.shift() ?? this.waiting.background.shift();
    if (start) {
      this.running = true;
      start();
    }
  }
}
