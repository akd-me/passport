import type { ActionCategory, ActionExecutor, Actor, Email, EventBus, Person, PolicyEngine, Store } from "@passport/types";
import type { JsonSchema } from "./schema.js";

export interface ToolResult {
  [key: string]: unknown;
  isError?: boolean;
}

/** Trusted caller context, never supplied by the model. */
export interface ToolContext {
  runId?: string;
  /** Built-in triage evidence; ignored for external-agent callers and never exposed in schemas. */
  classification?: ActionCategory;
  projectedPeople?: Person[];
  personSnapshot?: Person;
  emailPatch?: Partial<Pick<Email, "category" | "personIds">>;
  matterId?: string;
}
export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  risk: "read" | "write";
  handler(input: unknown, ctx?: ToolContext): Promise<ToolResult>;
}
export interface ToolRegistryOptions {
  store: Store;
  executor: ActionExecutor;
  policy: PolicyEngine;
  bus: EventBus;
  actor: Actor;
  selfAddresses: readonly string[];
  now?: () => string;
  /** Trusted audit label, never used for actor ownership. */
  actorAuditLabel?: () => string | undefined;
  /** Serialized UTF-8 response budget; default 512 KiB, minimum 1024 bytes. */
  responseByteBudget?: number;
  /** Null means no connected calendar provider for this account. */
  freeBusy?: import("./availability.js").FreeBusyResolver;
}
