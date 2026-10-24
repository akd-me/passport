/** Iterative traversal protects clone/stringify/template paths from deeply nested JSON. */
export function exceedsWebhookDepth(body: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop();
    if (!entry || !entry.value || typeof entry.value !== "object") {
      continue;
    }
    if (entry.depth >= 64) {
      return true;
    }
    for (const value of Object.values(entry.value)) {
      pending.push({ value, depth: entry.depth + 1 });
    }
  }
  return false;
}

export const WEBHOOK_SECRET_KEY =
  /auth|cookie|pass|pwd|credential|key|token|secret|sig|code|session|hmac|jwt|assertion/i;
