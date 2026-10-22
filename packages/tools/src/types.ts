import type {
  ActionCategory,
  ActionExecutor,
  Actor,
  Email,
  EventBus,
  MailReaderResolver,
  Person,
  PolicyEngine,
  Store,
} from "@passport/types";
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
  /** Per-call on-demand readers; overrides `ToolRegistryOptions.readers` for this call. */
  readers?: MailReaderResolver;
}
/** MCP tool hints that differ from the defaults derived from `risk`. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  risk: "read" | "write";
  annotations?: ToolAnnotations;
  handler(input: unknown, ctx?: ToolContext): Promise<ToolResult>;
}
export interface ToolRegistryOptions {
  log?: (message: string) => void;
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
  /**
   * On-demand mail readers (v0.3). When set, the `mail_*` tools read the provider directly and the
   * legacy mail reads alias them; when absent, legacy tools read the local store and the new
   * tools return `ON_DEMAND_UNSUPPORTED`.
   */
  readers?: MailReaderResolver;
  /**
   * Root directory for `mail_export` (MCP hosts only). Files go to `<scratchDir>/<session>/`
   * with mode 0700; the host sweeps them after 24 h (`sweepScratchDir`). Absent: no `mail_export`.
   */
  scratchDir?: string;
  /** Session directory name under `scratchDir`; default a random UUID per registry. */
  scratchSession?: string;
  /**
   * The host renders `IMAGE_CONTENT` on results as image content (the MCP server does), so
   * `mail_attachment_read` returns images without `asImage:true`.
   */
  imageContent?: boolean;
}
