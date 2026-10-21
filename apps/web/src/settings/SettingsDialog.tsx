import { Dialog } from "../components/Dialog";
import { Icon } from "../components/ui";
import { type SettingsSection, useUi } from "../ui-state";
import { RoutinesSettings } from "../views/Scheduler";
import { TrustSettings } from "../views/Trust";
import { AccountsSettings } from "./AccountsSettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { ModelSettings } from "./ModelSettings";

export const settingsSections: {
  id: SettingsSection;
  label: string;
  icon: string;
  description: string;
}[] = [
  {
    id: "model",
    label: "Model",
    icon: "agent",
    description: "Which agent does the work.",
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: "mail",
    description: "Mailboxes, calendars and connection health.",
  },
  {
    id: "trust",
    label: "Trust & rules",
    icon: "trust",
    description: "Permission mode, earned trust and standing instructions.",
  },
  {
    id: "routines",
    label: "Routines",
    icon: "routine",
    description: "Scheduled instructions and background jobs.",
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: "settings",
    description: "Appearance, API-key providers, data and access.",
  },
];

/** One dialog, five sections; opened from the sidebar gear, ⌘, or the command palette. */
export function SettingsDialog() {
  const { settings, openSettings, closeSettings } = useUi();
  if (!settings) {
    return null;
  }
  const section = settingsSections.find((s) => s.id === settings)!;
  return (
    <Dialog
      title="Settings"
      onClose={closeSettings}
      size="lg"
      hideTitle
      className="settings-dialog"
      initialFocus='[aria-current="page"]'
    >
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        {settingsSections.map((s) => (
          <button
            type="button"
            key={s.id}
            aria-current={s.id === settings ? "page" : undefined}
            onClick={() => openSettings(s.id)}
          >
            <Icon name={s.icon} size={15} />
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-content" key={settings}>
        <header>
          <h2>{section.label}</h2>
          <p>{section.description}</p>
        </header>
        {settings === "model" && <ModelSettings />}
        {settings === "accounts" && <AccountsSettings />}
        {settings === "trust" && <TrustSettings />}
        {settings === "routines" && <RoutinesSettings />}
        {settings === "advanced" && <AdvancedSettings />}
      </div>
    </Dialog>
  );
}
