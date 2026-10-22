import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeCursor, encodeCursor, ProviderError } from "./errors.js";

/**
 * Tamper-proof page tokens (R1-4). Readers hand agents opaque tokens that name provider links and
 * UID anchors; a sealed token carries an HMAC-SHA256 tag so a forged or edited token is rejected
 * with `INVALID_CURSOR` before anything in it is used.
 *
 * The key is random per process unless the composition root sets a persistent one, so page
 * tokens do not survive a restart (agents repeat the search). Change cursors that the watcher
 * persists are not sealed; their readers validate them structurally instead.
 */

let secret: Buffer = randomBytes(32);

/** Replaces the sealing key (at least 32 bytes), e.g. with one kept in the credential store. */
export function setReaderTokenSecret(key: Uint8Array): void {
  if (key.byteLength < 32) {
    throw new ProviderError("CONFIG_INVALID", "The reader token key needs at least 32 bytes");
  }
  secret = Buffer.from(key);
}

function tag(body: string): Buffer {
  return createHmac("sha256", secret).update(body).digest().subarray(0, 16);
}

/** `encodeCursor(value)` plus `.` and a base64url tag over it. */
export function sealToken(value: unknown): string {
  const body = encodeCursor(value);
  return `${body}.${tag(body).toString("base64url")}`;
}

/** Verifies and decodes a `sealToken` value; anything else is `INVALID_CURSOR`. */
export function openToken<T>(token: string): T {
  const dot = token.lastIndexOf(".");
  const body = dot > 0 ? token.slice(0, dot) : "";
  const given = Buffer.from(dot > 0 ? token.slice(dot + 1) : "", "base64url");
  const expected = tag(body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ProviderError("INVALID_CURSOR", "Page token is invalid or expired; search again");
  }
  return decodeCursor<T>(body);
}
