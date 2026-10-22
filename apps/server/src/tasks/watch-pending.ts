import { type MailRow, type Store, TASK_LIMITS } from "@passport/types";
import type { WakeKind } from "./watch-classify.js";

/** A coalesced wake waiting for its deadline; persisted so a restart replays it (R4-7). */
export interface PendingWake {
  taskId: string;
  threadHandle: string;
  emailId: string;
  /** Raw row of the latest message; framed and neutralized when the wake fires. */
  row: MailRow;
  kind: WakeKind;
  /** Epoch ms when the wake fires. */
  due: number;
  /** Replay keys (Message-IDs) the wake covers; marked seen once its run exists. */
  keys: string[];
}

const KEY = "task-watch-pending";

export function pendingKey(taskId: string, threadHandle: string): string {
  return `${taskId}\n${threadHandle}`;
}

/** kv-backed pending wakes, one JSON map; writes are serialized in-process. */
export class PendingWakes {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: Store["kv"]) {}

  async all(): Promise<PendingWake[]> {
    await this.chain;
    return Object.values(await this.read());
  }

  put(wake: PendingWake): Promise<void> {
    return this.write((map) => {
      map[pendingKey(wake.taskId, wake.threadHandle)] = wake;
    });
  }

  remove(key: string): Promise<void> {
    return this.write((map) => {
      delete map[key];
    });
  }

  /** Resolves once every queued write is on disk. */
  async settled(): Promise<void> {
    await this.chain;
  }

  private async read(): Promise<Record<string, PendingWake>> {
    try {
      const parsed: unknown = JSON.parse((await this.kv.get(KEY)) ?? "{}");
      return parsed && typeof parsed === "object" ? (parsed as Record<string, PendingWake>) : {};
    } catch {
      return {};
    }
  }

  private write(change: (map: Record<string, PendingWake>) => void): Promise<void> {
    const next = this.chain.then(async () => {
      const map = await this.read();
      change(map);
      await (Object.keys(map).length ? this.kv.set(KEY, JSON.stringify(map)) : this.kv.delete(KEY));
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** Replay keys (Message-IDs) per task in kv `task-watch-seen:<taskId>`, pruned to 7 days. */
export class SeenKeys {
  constructor(
    private readonly kv: Store["kv"],
    private readonly now: () => string,
  ) {}

  async has(taskId: string, key: string): Promise<boolean> {
    return !!(await this.read(taskId))[key];
  }

  async add(taskId: string, keys: string[]): Promise<void> {
    const seen = await this.read(taskId);
    const at = new Date(Date.parse(this.now())).toISOString();
    for (const key of keys) {
      seen[key] = at;
    }
    await this.kv.set(`task-watch-seen:${taskId}`, JSON.stringify(seen));
  }

  private async read(taskId: string): Promise<Record<string, string>> {
    let seen: Record<string, string> = {};
    try {
      seen = JSON.parse((await this.kv.get(`task-watch-seen:${taskId}`)) ?? "{}");
    } catch {
      seen = {};
    }
    const now = Date.parse(this.now());
    for (const [key, at] of Object.entries(seen)) {
      if (now - Date.parse(at) > TASK_LIMITS.watchReplayMs) {
        delete seen[key];
      }
    }
    return seen;
  }
}
