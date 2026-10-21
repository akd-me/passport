import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { AccountCredentials } from "@passport/types";
import { StoreError } from "./errors.js";

export function encryptCredentials(
  key: Buffer,
  accountId: string,
  credentials: AccountCredentials,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(accountId));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptCredentials(
  key: Buffer,
  accountId: string,
  blob: Uint8Array,
): AccountCredentials {
  try {
    const encrypted = Buffer.from(blob);
    if (encrypted[0] !== 1 || encrypted.length < 30) {
      throw new Error();
    }
    const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(1, 13));
    decipher.setAAD(Buffer.from(accountId));
    decipher.setAuthTag(encrypted.subarray(13, 29));
    return JSON.parse(
      Buffer.concat([decipher.update(encrypted.subarray(29)), decipher.final()]).toString("utf8"),
    ) as AccountCredentials;
  } catch {
    throw new StoreError(
      "CREDENTIAL_DECRYPTION_FAILED",
      "Cannot decrypt credentials: master key is incorrect or the record is damaged",
    );
  }
}
