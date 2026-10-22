import { type ConversationWatch, type Email, parseMailHandle } from "@passport/types";

export type WakeKind = "reply" | "bounce" | "auto_reply";

const BOUNCE_FROM = /^(mailer-daemon|postmaster)@/i;
const BOUNCE_SUBJECT =
  /undeliver|delivery status notification|delivery (has )?failed|mail delivery (failed|subsystem)|returned mail/i;
const AUTO_SUBJECT =
  /^(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|autoreply|abwesenheit|r[ée]ponse automatique)/i;

export const WAKE_LABEL: Record<WakeKind, string> = {
  reply: "New reply",
  bounce: "Bounce",
  auto_reply: "Automatic reply",
};

/** Bounce and auto-reply detection from headers first, then sender and subject conventions. */
export function classifyWake(email: Email): WakeKind {
  const headers = Object.fromEntries(
    Object.entries(email.headers.extra ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value.toLowerCase(),
    ]),
  );
  if (email.from.some((a) => BOUNCE_FROM.test(a.email)) || BOUNCE_SUBJECT.test(email.subject)) {
    return "bounce";
  }
  const auto = headers["auto-submitted"];
  if (
    (auto && auto !== "no") ||
    headers["x-autoreply"] ||
    headers["x-autorespond"] ||
    /^(auto_reply|auto-reply)$/.test(headers.precedence ?? "") ||
    AUTO_SUBJECT.test(email.subject.trim())
  ) {
    return "auto_reply";
  }
  return "reply";
}

export function sameThread(watch: ConversationWatch, email: Email): boolean {
  if (email.accountId !== watch.account) {
    return false;
  }
  if (email.threadId === watch.threadHandle) {
    return true;
  }
  const a = parseMailHandle(watch.threadHandle);
  const b = parseMailHandle(email.threadId);
  return !!a && !!b && a.type === "thread" && b.type === "thread" && a.providerId === b.providerId;
}

/** A handle quoted for a prompt: JSON-escaped, so it cannot end the sentence it sits in. */
export function quoteHandle(handle: string): string {
  return JSON.stringify(handle.slice(0, 1024));
}
