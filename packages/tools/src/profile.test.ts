import { DEFAULT_USER_PROFILE } from "@passport/types";
import { expect, it } from "vitest";
import { learnedProfile } from "./profile.js";

it("learns Voice, Signature and VIPs together while preserving other instructions", () => {
  const profile = `${DEFAULT_USER_PROFILE}\n## Private preferences\nLeave this alone.\n`;
  const next = learnedProfile(profile, "Short paragraphs; direct requests.", "Regards, Alex", [
    "Dana <dana@example.com>",
  ]);
  expect(next).toContain("## Voice\nShort paragraphs; direct requests.");
  expect(next).toContain("Signature: Regards, Alex");
  expect(next).toContain("## VIPs\n- Dana <dana@example.com>");
  expect(next).toContain(
    profile.slice(profile.indexOf("## Standing rules"), profile.indexOf("## VIPs")),
  );
  expect(next).toContain("## Private preferences\nLeave this alone.");
  expect(next).toContain("assistant_attribution: false");
});

it("adds missing knowledge sections without replacing the profile", () => {
  const next = learnedProfile(
    "# USER.md\n\n## Standing rules\n- Ask me.\n",
    "Concise.",
    "Alex",
    [],
  );
  expect(next).toContain("## Standing rules\n- Ask me.");
  expect(next).toContain("## Signature\nAlex");
  expect(next).toContain("No VIPs inferred");
});
