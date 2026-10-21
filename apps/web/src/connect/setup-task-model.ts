import type { SetupProvider, SetupTask } from "../setup-api";
export const providerNames: Record<SetupProvider, string> = {
  gmail: "Gmail",
  microsoft: "Outlook",
};

/** Respond and cancel may echo the updated task; apply it without waiting for a poll. */
export const asTask = (value: unknown) =>
  value && typeof value === "object" && "steps" in value ? (value as SetupTask) : undefined;
