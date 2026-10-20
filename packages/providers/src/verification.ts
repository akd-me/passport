import type { AuthResult, EmailHeaders, VerificationState } from "@passport/types";

export type HeaderInput = EmailHeaders | Record<string, string | string[] | undefined> | Array<{ name: string; value: string }>;

export function headerValues(input: HeaderInput): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const add = (name: string, value: string | string[] | undefined | null) => {
    if (value == null) return;
    (result[name.toLowerCase()] ??= []).push(...(Array.isArray(value) ? value : [value]));
  };
  if (Array.isArray(input)) input.forEach(h => add(h.name, h.value));
  else if ("messageId" in input && "references" in input) {
    const h = input as EmailHeaders;
    Object.entries(h.extra ?? {}).forEach(([k, v]) => add(k, v));
    if (h.authenticationResults?.length) result["authentication-results"] = [...h.authenticationResults];
    add("message-id", h.messageId); add("in-reply-to", h.inReplyTo);
    add("references", h.references.join(" ")); add("list-id", h.listId);
    add("list-unsubscribe", h.listUnsubscribe); add("list-unsubscribe-post", h.listUnsubscribePost);
  } else Object.entries(input).forEach(([k, v]) => add(k, v as string | string[] | undefined));
  return result;
}

/** Reports receiver-supplied authentication results; does not itself validate DKIM or an ARC chain. */
export function parseAuthenticationResults(headers: HeaderInput): VerificationState {
  const h = headerValues(headers);
  const direct = (h["authentication-results"] ?? []).join(";").replace(/\r?\n[ \t]+/g, " ").replace(/\([^)]*\)/g, "");
  const arc = (h["arc-authentication-results"] ?? []).join(";").replace(/\r?\n[ \t]+/g, " ").replace(/\([^)]*\)/g, "");
  const get = (method: string): AuthResult => {
    const pattern = new RegExp(`(?:^|;)\\s*${method}\\s*=\\s*([a-z]+)`, "gi");
    let values = [...direct.matchAll(pattern)].map(m => m[1]!.toLowerCase());
    if (!values.length) values = [...arc.matchAll(pattern)].map(m => m[1]!.toLowerCase());
    if (values.some(v => ["fail", "softfail", "permerror"].includes(v))) return "fail";
    if (values.includes("pass")) return "pass";
    if (values.includes("none")) return "none";
    return "unknown";
  };
  const signer = /(?:^|;)\s*dkim\s*=\s*pass\b[^;]*\bheader\.d\s*=\s*([^\s;]+)/i.exec(/(?:^|;)\s*dkim\s*=/i.test(direct) ? direct : arc)?.[1];
  return { dkim: get("dkim"), spf: get("spf"), dmarc: get("dmarc"), passport: "green", ...(signer ? { signer } : {}) };
}

/** Inject a cryptographic Passport identity verifier here when the signature format is available. */
export interface PassportVerifier {
  verify(headers: EmailHeaders, authentication: VerificationState): Promise<VerificationState>;
}

/** Deliberate stub: observes the signature header but never grants blue status. */
export class StubPassportVerifier implements PassportVerifier {
  async verify(headers: EmailHeaders, authentication: VerificationState): Promise<VerificationState> {
    const signature = headerValues(headers)["x-passport-signature"]?.[0];
    void signature;
    return { ...authentication, passport: "green" };
  }
}

export async function verifyHeaders(headers: EmailHeaders, verifier: PassportVerifier = new StubPassportVerifier()): Promise<VerificationState> {
  return verifier.verify(headers, parseAuthenticationResults(headers));
}
