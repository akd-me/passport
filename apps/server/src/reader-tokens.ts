import { hkdfSync } from "node:crypto";
import { setReaderTokenSecret } from "@passport/providers";

const INFO = "passport reader page tokens v1";

/**
 * Page tokens handed to agents are HMAC-sealed (review R1-4). Deriving the sealing key from the
 * master key with HKDF keeps tokens valid across restarts without storing a second secret; the
 * master key itself is never used directly as an HMAC key.
 */
export function deriveReaderTokenSecret(masterKey: string): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", masterKey, "", INFO, 32));
}

export function installReaderTokenSecret(masterKey: string): void {
  setReaderTokenSecret(deriveReaderTokenSecret(masterKey));
}
