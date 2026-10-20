import type { Store } from "@passport/types";

import { getEffectiveProfile } from "@passport/types";
export { DEFAULT_USER_PROFILE } from "@passport/types";

/** Compatibility alias for the shared effective-profile accessor. */
export const getUserProfile = getEffectiveProfile;

export async function setUserProfile(store: Store, markdown: string): Promise<void> {
  await store.kv.set("user_profile", markdown);
}

export interface DraftSettings {
  /** Both this switch and USER.md's assistant_attribution must be true. Default: false. */
  attribution?: boolean;
  attributionLine?: string;
}

export function attributionAllowed(profile: string, settings: DraftSettings): boolean {
  return settings.attribution === true && /^\s*assistant_attribution:\s*true\s*$/im.test(profile);
}

export function formatDraft(body: string, profile: string, settings: DraftSettings): string {
  const line = settings.attributionLine ?? "(drafted by my assistant)";
  const cleaned = body.split("\n").filter(part => part.trim() !== line.trim() && part.trim() !== "(drafted by my assistant)").join("\n").trim();
  return attributionAllowed(profile, settings) ? `${cleaned}\n\n${line}` : cleaned;
}
