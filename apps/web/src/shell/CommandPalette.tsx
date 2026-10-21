import type { Matter, Person, TrustLevel } from "@passport/types";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { Dialog } from "../components/Dialog";
import { Icon, Kbd, mod } from "../components/ui";
import { settingsSections } from "../settings/SettingsDialog";
import { useResource, useWorkspace } from "../state";
import { useUi } from "../ui-state";
import { modes } from "../views/Trust";

export interface Command {
  id: string;
  group: "Actions" | "Go to" | "Matters" | "People" | "Settings";
  label: string;
  hint?: string;
  icon: string;
  shortcut?: string;
  keywords?: string;
  run: () => void;
}

/** Every token must appear in the label, hint or keywords; earlier label matches rank first. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return commands;
  }
  return commands
    .map((command) => {
      const haystack =
        `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`.toLowerCase();
      if (!tokens.every((t) => haystack.includes(t))) {
        return null;
      }
      const at = command.label.toLowerCase().indexOf(tokens[0]!);
      return { command, score: at < 0 ? 1000 : at };
    })
    .filter((x): x is { command: Command; score: number } => !!x)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.command);
}

function useCommands(close: () => void): Command[] {
  const navigate = useNavigate(),
    ui = useUi(),
    { notify } = useWorkspace();
  const matters = useResource<Matter[]>("/matters"),
    people = useResource<Person[]>("/people?limit=200");
  return useMemo(() => {
    const go = (path: string) => () => {
      close();
      navigate(path);
    };
    const act = (fn: () => void) => () => {
      close();
      fn();
    };
    const list: Command[] = [
      {
        id: "ask",
        group: "Actions",
        label: "Ask Passport to do something",
        icon: "sparkle",
        shortcut: "/",
        keywords: "instruct agent composer",
        run: act(() => {
          if (!ui.composer.current) {
            navigate("/");
          }
          setTimeout(ui.focusComposer, 50);
        }),
      },
      {
        id: "connect",
        group: "Actions",
        label: "Connect an account",
        icon: "plus",
        keywords: "gmail outlook microsoft google imap add mailbox",
        run: act(() => ui.setConnecting(true)),
      },
      {
        id: "review",
        group: "Actions",
        label: "Review active matters now",
        icon: "agent",
        keywords: "run agent next steps",
        run: act(() => {
          notify("Reviewing your active matters…");
          api
            .runAgent()
            .then((run) =>
              notify(
                run.actionIds.length
                  ? `Review done: ${run.actionIds.length} actions.`
                  : "Review done. Nothing new needs you.",
              ),
            )
            .catch((e: Error) => notify(e.message));
        }),
      },
      ...modes.map((mode) => ({
        id: `mode-${mode.id}`,
        group: "Actions" as const,
        label: `Permission mode: ${mode.label}`,
        hint: mode.description,
        icon: mode.icon,
        keywords: "trust ladder autonomy",
        run: act(() => {
          api
            .setTrust({ globalMode: mode.id as TrustLevel })
            .then(() => notify(`Permission mode set to ${mode.label}.`))
            .catch((e: Error) => notify(e.message));
        }),
      })),
      {
        id: "queue",
        group: "Go to",
        label: "Queue",
        icon: "queue",
        keywords: "decisions home inbox",
        run: go("/"),
      },
      {
        id: "activity",
        group: "Go to",
        label: "Activity",
        icon: "activity",
        keywords: "log history undo outbox",
        run: go("/activity"),
      },
      { id: "matters", group: "Go to", label: "All matters", icon: "matters", run: go("/matters") },
      {
        id: "people",
        group: "Go to",
        label: "All people",
        icon: "people",
        keywords: "contacts",
        run: go("/people"),
      },
      ...settingsSections.map((s) => ({
        id: `settings-${s.id}`,
        group: "Settings" as const,
        label: `Settings: ${s.label}`,
        hint: s.description,
        icon: s.icon,
        shortcut: s.id === "model" ? `${mod},` : undefined,
        run: act(() => ui.openSettings(s.id)),
      })),
      {
        id: "theme-system",
        group: "Settings",
        label: "Theme: match system",
        icon: "system",
        keywords: "appearance dark light",
        run: act(() => ui.setTheme("system")),
      },
      {
        id: "theme-light",
        group: "Settings",
        label: "Theme: light",
        icon: "light",
        keywords: "appearance",
        run: act(() => ui.setTheme("light")),
      },
      {
        id: "theme-dark",
        group: "Settings",
        label: "Theme: dark",
        icon: "dark",
        keywords: "appearance",
        run: act(() => ui.setTheme("dark")),
      },
      {
        id: "sidebar",
        group: "Settings",
        label: "Toggle sidebar",
        icon: "sidebar",
        shortcut: `${mod}B`,
        run: act(ui.toggleSidebar),
      },
      {
        id: "details",
        group: "Settings",
        label: "Toggle details panel",
        icon: "panel",
        shortcut: `${mod}.`,
        run: act(ui.toggleDetails),
      },
      ...(matters.data ?? []).map((m) => ({
        id: `matter-${m.id}`,
        group: "Matters" as const,
        label: m.title,
        hint: m.nextStep ?? undefined,
        icon: "matters",
        keywords: `${m.kind ?? ""} ${m.status}`,
        run: go(`/matters/${m.id}`),
      })),
      ...(people.data ?? []).map((p) => ({
        id: `person-${p.id}`,
        group: "People" as const,
        label: p.displayName,
        hint: p.primaryEmail,
        icon: "people",
        keywords: p.emails.join(" "),
        run: go(`/people/${p.id}`),
      })),
    ];
    return list;
  }, [matters.data, people.data, close, navigate, ui, notify]);
}

const groupOrder: Command["group"][] = ["Actions", "Go to", "Matters", "People", "Settings"];

export function CommandPalette() {
  const { palette, setPalette } = useUi();
  if (!palette) {
    return null;
  }
  return <PaletteBody onClose={() => setPalette(false)} />;
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const commands = useCommands(onClose),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0);
  const results = useMemo(() => {
    const filtered = filterCommands(commands, query).slice(0, 60);
    return query
      ? filtered
      : groupOrder.flatMap((g) =>
          filtered
            .filter((c) => c.group === g)
            .slice(0, g === "People" || g === "Matters" ? 5 : 20),
        );
  }, [commands, query]);
  const current = Math.min(active, Math.max(0, results.length - 1));
  const move = (delta: number) => {
    const next = (current + delta + results.length) % Math.max(1, results.length);
    setActive(next);
    document.getElementById(`cmd-${results[next]?.id}`)?.scrollIntoView?.({ block: "nearest" });
  };
  let lastGroup = "";
  return (
    <Dialog title="Command palette" onClose={onClose} size="palette" hideTitle className="palette">
      <div className="palette-input">
        <Icon name="search" size={16} />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={results[current] ? `cmd-${results[current].id}` : undefined}
          aria-label="Search commands, matters and people"
          placeholder="Search commands, matters and people"
          value={query}
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              results[current]?.run();
            }
          }}
        />
      </div>
      <ul id="palette-list" role="listbox" aria-label="Results" className="palette-list">
        {results.map((command, i) => {
          const header = command.group !== lastGroup ? command.group : null;
          lastGroup = command.group;
          return (
            <li key={command.id} role="presentation">
              {header && (
                <div className="palette-group" role="presentation">
                  {header}
                </div>
              )}
              <div
                id={`cmd-${command.id}`}
                role="option"
                aria-selected={i === current}
                className="palette-item"
                onMouseMove={() => setActive(i)}
                onClick={() => command.run()}
              >
                <Icon name={command.icon} size={15} />
                <span className="palette-label">{command.label}</span>
                {command.hint && <span className="palette-hint">{command.hint}</span>}
                {command.shortcut && <Kbd>{command.shortcut}</Kbd>}
              </div>
            </li>
          );
        })}
        {!results.length && <li className="palette-empty">No matches for “{query}”.</li>}
      </ul>
      <div className="palette-foot" aria-hidden="true">
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span>
          <Kbd>↵</Kbd> open
        </span>
        <span>
          <Kbd>esc</Kbd> close
        </span>
      </div>
    </Dialog>
  );
}
