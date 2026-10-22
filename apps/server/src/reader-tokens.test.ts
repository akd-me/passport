import { describe, expect, it } from "vitest";
import { deriveReaderTokenSecret } from "./reader-tokens.js";

describe("reader token secret", () => {
  it("derives a stable 32-byte key from the master key and differs per key", () => {
    const a = deriveReaderTokenSecret("master-a");
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(deriveReaderTokenSecret("master-a")))).toBe(true);
    expect(Buffer.from(a).equals(Buffer.from(deriveReaderTokenSecret("master-b")))).toBe(false);
    expect(Buffer.from(a).toString("hex")).not.toContain(Buffer.from("master-a").toString("hex"));
  });
});
