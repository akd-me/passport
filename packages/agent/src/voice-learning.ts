import type { AgentRunOptions, Store } from "@passport/types";
import { AgentError } from "./errors.js";
import { isObject } from "./llm/json.js";

/** Enforces the connect task's sampling bound even if mail content redirects the model. */
export class VoiceLearningGuard {
  private searched = false;
  private proposed = false;
  private rows = new Set<string>();
  private read = new Set<string>();
  private readSucceeded = false;

  constructor(private readonly limits: NonNullable<AgentRunOptions["voiceLearning"]>) {}

  /**
   * A profile proposal for this account already waiting on the person ends sampling: a second
   * run (a restart continuation, a follow-up) must not propose a competing whole profile (R1-49).
   */
  async seed(store: Store): Promise<void> {
    const pending = await store.actions.query({
      status: ["proposed"],
      category: "profile_update",
      limit: 50,
    });
    if (pending.items.some((action) => action.request.accountId === this.limits.accountId)) {
      this.searched = true;
      this.proposed = true;
    }
  }

  input(name: string, input: unknown): unknown {
    const value = isObject(input) ? input : {};
    if (name === "get_user_profile") {
      return {};
    }
    if (name === "mail_search" && !this.searched) {
      this.searched = true;
      return {
        account: this.limits.accountId,
        container: this.limits.sentContainer,
        query: "in:sent",
        limit: 50,
        threads: false,
      };
    }
    if (
      name === "mail_read" &&
      typeof value.id === "string" &&
      this.rows.has(value.id) &&
      !this.read.has(value.id)
    ) {
      this.read.add(value.id);
      return {
        id: value.id,
        view: "message",
        quoted: "collapse",
        format: "text",
        length: 8000,
        offset: 0,
      };
    }
    if (name === "profile_update" && !this.proposed && this.readSucceeded) {
      this.proposed = true;
      return { ...value, accountId: this.limits.accountId };
    }
    throw new AgentError(
      "Voice learning permits one Sent search (50 messages), one collapsed read per sampled message, and one profile proposal after reading evidence. Stop when the sample is empty.",
      "INPUT_VOICE_LIMIT",
    );
  }

  result(name: string, result: Record<string, unknown>): void {
    if (name === "mail_read" && !result.isError) {
      this.readSucceeded = true;
    }
    if (name === "mail_search" && Array.isArray(result.items)) {
      result.items = result.items.slice(0, 50);
      result.nextPageToken = null;
      for (const row of result.items as unknown[]) {
        if (isObject(row) && typeof row.id === "string" && row.account === this.limits.accountId) {
          this.rows.add(row.id);
        }
      }
    }
  }
}
