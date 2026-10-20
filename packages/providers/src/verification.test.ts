import { describe, expect, it } from "vitest";
import { parseAuthenticationResults, StubPassportVerifier } from "./verification.js";
import { normalizeHeaders } from "./normalize/index.js";

describe("Authentication-Results", () => {
  it("returns unknown authentication and green Passport status when absent", () => { expect(parseAuthenticationResults({})).toEqual({ dkim: "unknown", spf: "unknown", dmarc: "unknown", passport: "green" }); });
  it("handles case, comments, folding, and DKIM signing domains", () => { expect(parseAuthenticationResults({ "Authentication-Results": "mx;\r\n DKIM=pass (good) header.d=example.com; SPF=pass; DMARC=none" })).toMatchObject({ dkim: "pass", spf: "pass", dmarc: "none", signer: "example.com" }); });
  it("conservatively reports failure across duplicate signatures", () => { expect(parseAuthenticationResults({ "authentication-results": ["mx; dkim=pass header.d=a.example; spf=softfail", "mx; dkim=fail; dmarc=permerror"] })).toMatchObject({ dkim: "fail", spf: "fail", dmarc: "fail" }); });
  it("uses ARC only for methods absent from Authentication-Results", () => { expect(parseAuthenticationResults({ "authentication-results": "mx; dkim=fail", "arc-authentication-results": "i=1; relay; dkim=pass; spf=pass; dmarc=pass" })).toMatchObject({ dkim: "fail", spf: "pass", dmarc: "pass" }); });
  it("retains an ARC DKIM signer when direct results only report SPF", () => { expect(parseAuthenticationResults({ "authentication-results": "mx; spf=pass", "arc-authentication-results": "i=1; relay; dkim=pass header.d=example.com" })).toMatchObject({ dkim: "pass", signer: "example.com" }); });
  it("does not read body text or unrelated header values", () => { expect(parseAuthenticationResults({ subject: "dkim=pass; spf=pass", "x-random": "dmarc=pass" }).dkim).toBe("unknown"); });
  it("leaves transient and unrecognized results unknown", () => { expect(parseAuthenticationResults({ "authentication-results": "mx; dkim=temperror; spf=neutral; dmarc=bestguesspass" })).toMatchObject({ dkim: "unknown", spf: "unknown", dmarc: "unknown" }); });
  it("the Passport stub reads signature headers but always stays green", async () => { const h = normalizeHeaders({ "x-passport-signature": "untrusted", "authentication-results": "mx; dkim=pass" }); expect((await new StubPassportVerifier().verify(h, parseAuthenticationResults(h))).passport).toBe("green"); });
});
