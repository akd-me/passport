import type { Store } from "@passport/types";
import type { AgentDecision } from "./integration.js";

/** A small KV index is needed because Store.kv intentionally has no key-enumeration API. */
export async function recordDecision(
  store: Store,
  runId: string,
  decision: AgentDecision,
): Promise<void> {
  const key = `decision:${runId}:${decision.emailId}`;
  await store.kv.set(key, JSON.stringify(decision));
  const saved = await store.kv.get("agent:pending_decisions");
  const keys = saved ? (JSON.parse(saved) as string[]) : [];
  if (!keys.includes(key)) {
    keys.push(key);
  }
  await store.kv.set("agent:pending_decisions", JSON.stringify(keys));
}

export async function pendingDecisions(store: Store): Promise<AgentDecision[]> {
  const saved = await store.kv.get("agent:pending_decisions");
  const keys = saved ? (JSON.parse(saved) as string[]) : [];
  const active: string[] = [];
  const decisions: AgentDecision[] = [];
  for (const key of keys) {
    const value = await store.kv.get(key);
    if (value) {
      active.push(key);
      decisions.push(JSON.parse(value) as AgentDecision);
    }
  }
  if (active.length !== keys.length) {
    await store.kv.set("agent:pending_decisions", JSON.stringify(active));
  }
  return decisions;
}
