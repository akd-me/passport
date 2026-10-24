import type { TaskItem } from "./tasks.js";

export type SecretRequestStatus = "pending" | "saved" | "declined" | "timed_out" | "cancelled";
export interface SecretRequest {
  id: string;
  taskId: string;
  clientRequestId: string;
  text: string;
  status: SecretRequestStatus;
  createdAt: string;
  expiresAt: string;
  secretRef?: string;
}

/** Server-only encrypted persistence. Never expose these methods as read tools. */
export interface EncryptedKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** Atomic read and delete, including across processes. */
  take(key: string): Promise<string | null>;
}

export interface StoreSecrets {
  put(value: string): Promise<string>;
  take(ref: string): Promise<string | null>;
  requests: {
    /** Atomically deduplicates by task/clientRequestId and appends one timeline item. */
    create(input: {
      taskId: string;
      runId?: string;
      clientRequestId: string;
      text: string;
      createdAt: string;
      expiresAt: string;
    }): Promise<{ request: SecretRequest; item?: TaskItem }>;
    get(id: string, taskId: string, now: string): Promise<SecretRequest | null>;
    respond(
      id: string,
      taskId: string,
      response: { value: string } | { status: "declined" | "timed_out" | "cancelled" },
      now: string,
    ): Promise<SecretRequest | null>;
  };
}

declare module "./index.js" {
  interface Store {
    encryptedKv?: EncryptedKv;
    secrets?: StoreSecrets;
  }
}
