import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PROFILE, formatDraft, getUserProfile, setUserProfile } from "./profile.js";
import { MemoryStore } from "./testing/memory-store.js";

describe("USER.md and draft attribution", () => {
  it("has a useful default and persists user edits", async () => {
    const store = new MemoryStore();
    expect(await getUserProfile(store)).toBe(DEFAULT_USER_PROFILE);
    expect(DEFAULT_USER_PROFILE).toContain("Name:");
    expect(DEFAULT_USER_PROFILE).toContain("VIPs");
    expect(DEFAULT_USER_PROFILE).toContain("assistant_attribution: false");
    await setUserProfile(store, "# USER.md\nName: Morgan");
    expect(await store.kv.get("user_profile")).toBe("# USER.md\nName: Morgan");
    expect(await getUserProfile(store)).toBe("# USER.md\nName: Morgan");
  });

  it.each([
    [DEFAULT_USER_PROFILE, {}],
    [DEFAULT_USER_PROFILE, { attribution: true }],
    ["assistant_attribution: true", {}],
  ])(
    "leaves attribution off unless both configuration and profile allow it",
    (profile, settings) => {
      expect(formatDraft("Hello.\n\n(drafted by my assistant)", profile, settings)).toBe("Hello.");
    },
  );

  it("adds the configured attribution exactly once when permitted", () => {
    expect(
      formatDraft("Hello.\n(custom assistant line)", "assistant_attribution: true", {
        attribution: true,
        attributionLine: "(custom assistant line)",
      }),
    ).toBe("Hello.\n\n(custom assistant line)");
  });
});
