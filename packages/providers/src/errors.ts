/** A provider failure with a stable, machine-readable code. No remote bodies or secrets are included. */
export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

export class NotImplementedError extends ProviderError {
  constructor(message: string) { super("NOT_IMPLEMENTED", message); this.name = "NotImplementedError"; }
}

/** SMTP accepted the message. Retry only sent-copy/draft cleanup, never the submission itself. */
export class SubmissionAcceptedError extends ProviderError {
  constructor(public readonly messageId: string | null) {
    super("SUBMISSION_ACCEPTED", "SMTP accepted the message, but sent-copy or draft cleanup failed. Do not retry send; resync and repair the local state.");
    this.name = "SubmissionAcceptedError";
  }
}

export function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new ProviderError("CONFIG_REQUIRED", `Missing ${name}`);
  return value;
}

export function encodeCursor(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
export function decodeCursor<T>(value: string): T {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed as T;
  }
  catch { throw new ProviderError("INVALID_CURSOR", "Invalid provider cursor; request a full sync"); }
}

/** Stable account-scoped adapter IDs; the store may remap these when ingesting deltas. */
export function localId(accountId: string, type: string, providerId: string): string {
  return `${accountId}:${type}:${encodeURIComponent(providerId)}`;
}

export function assertSend(input: { draftProviderId?: string; draft?: unknown }): void {
  if (Boolean(input.draftProviderId) === Boolean(input.draft)) {
    throw new ProviderError("INVALID_SEND", "Supply exactly one of draftProviderId or draft");
  }
}
