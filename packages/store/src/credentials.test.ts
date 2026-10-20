import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCredentials, encryptCredentials } from "./credentials.js";

describe("credential envelope", () => {
  const credentials = { refreshToken: "a very private token", password: "🔐" };

  it("encrypts with a fresh nonce and authenticates a round trip", () => {
    const key = randomBytes(32);
    const first = encryptCredentials(key, "account", credentials);
    const second = encryptCredentials(key, "account", credentials);
    expect(first).not.toEqual(second);
    expect(first.includes(Buffer.from(credentials.refreshToken))).toBe(false);
    expect(decryptCredentials(key, "account", first)).toEqual(credentials);
  });

  it("rejects wrong keys and moving a credential blob to a different account", () => {
    const key = randomBytes(32);
    const encrypted = encryptCredentials(key, "account", credentials);
    for (const [candidate, accountId] of [[randomBytes(32), "account"], [key, "other"]] as const) {
      expect(() => decryptCredentials(candidate, accountId, encrypted)).toThrow(expect.objectContaining({ code: "CREDENTIAL_DECRYPTION_FAILED" }));
    }
  });

  it("rejects damaged ciphertext, authentication tags and unsupported envelopes", () => {
    const key = randomBytes(32);
    const encrypted = encryptCredentials(key, "account", credentials);
    for (const offset of [0, 1, 13, 29, encrypted.length - 1]) {
      const damaged = Buffer.from(encrypted);
      damaged[offset] = damaged[offset]! ^ 0xff;
      expect(() => decryptCredentials(key, "account", damaged)).toThrow(expect.objectContaining({ code: "CREDENTIAL_DECRYPTION_FAILED" }));
    }
    expect(() => decryptCredentials(key, "account", Buffer.alloc(0))).toThrow(expect.objectContaining({ code: "CREDENTIAL_DECRYPTION_FAILED" }));
  });
});
