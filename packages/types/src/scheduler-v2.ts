/** Webhook configuration contains references only, never signing secrets. */
export interface WebhookSchedule {
  type: "webhook";
  signature?: {
    header: string;
    encoding: "hex" | "base64";
    prefix?: string;
    secretRef: string;
  };
  maxDeliveryAgeMinutes?: number;
  dedupe?: { replayKey?: string; coalesceKey?: string; coalesceWindowSeconds?: number };
  filters?: WebhookFilter[];
}

export interface WebhookFilter {
  path: string;
  op: "equals" | "notEquals" | "startsWith" | "in" | "exists";
  value?: string | number | boolean | null | (string | number | boolean | null)[];
}

export type WebhookDeliveryOutcome =
  | "accepted"
  | "dispatch_failed"
  | "duplicate"
  | "coalesced"
  | "rejected_signature"
  | "disabled"
  | "rate_limited"
  | "expired"
  | "filtered";

export interface WebhookDelivery {
  id: string;
  jobId: string;
  receivedAt: string;
  outcome: WebhookDeliveryOutcome;
  /** Already framed as untrusted; no authentication headers or hook URL. */
  prompt?: string;
}

export type RoutineRunOn = "bound" | "fresh";
