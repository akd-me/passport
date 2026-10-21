import type { TrustLevel } from "@passport/types";

export const modes: {
  id: TrustLevel;
  label: string;
  description: string;
  icon: string;
}[] = [
  {
    id: "supervised",
    label: "Supervised",
    description: "Passport suggests. You approve every action.",
    icon: "lock",
  },
  {
    id: "auto_accept_edits",
    label: "Auto-accept edits",
    description:
      "Reversible changes run on their own. Anything that leaves your mailbox asks first.",
    icon: "edits",
  },
  {
    id: "auto",
    label: "Auto",
    description: "Passport acts where trust is earned. New territory still asks.",
    icon: "sparkle",
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Passport handles everything outside your always-ask rules.",
    icon: "unlock",
  },
];

export const modeLabel = (level: TrustLevel) => modes.find((m) => m.id === level)?.label ?? level;
