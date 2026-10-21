import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type SettingsSection =
  | "model"
  | "accounts"
  | "trust"
  | "routines"
  | "advanced";
export type ThemePreference = "system" | "light" | "dark";

interface UiState {
  settings: SettingsSection | null;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  connecting: boolean;
  setConnecting: (open: boolean) => void;
  palette: boolean;
  setPalette: (open: boolean) => void;
  sidebar: boolean;
  toggleSidebar: () => void;
  details: boolean;
  toggleDetails: () => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  /** The docked composer registers itself so shortcuts and the palette can focus it. */
  composer: React.MutableRefObject<HTMLTextAreaElement | null>;
  focusComposer: () => void;
}

const Ui = createContext<UiState | null>(null);

function stored<T extends string>(key: string, fallback: T, allowed: T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Private windows may refuse storage; the preference lasts for the session. */
  }
}

/** Phones and narrow windows start with the sidebar tucked away. */
const narrow = (width = 860) =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia(`(max-width: ${width}px)`).matches;

export function applyTheme(theme: ThemePreference) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsSection | null>(null),
    [connecting, setConnecting] = useState(false),
    [palette, setPalette] = useState(false),
    [sidebar, setSidebar] = useState(
      () =>
        !narrow() &&
        stored("passport.sidebar", "open", ["open", "closed"]) === "open",
    ),
    [details, setDetails] = useState(
      () =>
        !narrow(1180) &&
        stored("passport.details", "open", ["open", "closed"]) === "open",
    ),
    [theme, setThemeState] = useState<ThemePreference>(() =>
      stored("passport.theme", "system", ["system", "light", "dark"]),
    ),
    composer = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => applyTheme(theme), [theme]);
  const openSettings = useCallback(
      (section: SettingsSection = "model") => setSettings(section),
      [],
    ),
    closeSettings = useCallback(() => setSettings(null), []),
    toggleSidebar = useCallback(
      () =>
        setSidebar((open) => {
          persist("passport.sidebar", open ? "closed" : "open");
          return !open;
        }),
      [],
    ),
    toggleDetails = useCallback(
      () =>
        setDetails((open) => {
          persist("passport.details", open ? "closed" : "open");
          return !open;
        }),
      [],
    ),
    setTheme = useCallback((next: ThemePreference) => {
      persist("passport.theme", next);
      setThemeState(next);
    }, []),
    focusComposer = useCallback(() => composer.current?.focus(), []);
  const value = useMemo(
    () => ({
      settings,
      openSettings,
      closeSettings,
      connecting,
      setConnecting,
      palette,
      setPalette,
      sidebar,
      toggleSidebar,
      details,
      toggleDetails,
      theme,
      setTheme,
      composer,
      focusComposer,
    }),
    [
      settings,
      openSettings,
      closeSettings,
      connecting,
      palette,
      sidebar,
      toggleSidebar,
      details,
      toggleDetails,
      theme,
      setTheme,
      focusComposer,
    ],
  );
  return <Ui.Provider value={value}>{children}</Ui.Provider>;
}

const fallback: UiState = {
  settings: null,
  openSettings: () => {},
  closeSettings: () => {},
  connecting: false,
  setConnecting: () => {},
  palette: false,
  setPalette: () => {},
  sidebar: true,
  toggleSidebar: () => {},
  details: true,
  toggleDetails: () => {},
  theme: "system",
  setTheme: () => {},
  composer: { current: null },
  focusComposer: () => {},
};
/** Components rendered outside the shell (unit tests) get inert defaults. */
export const useUi = () => useContext(Ui) ?? fallback;

/** True when a keystroke belongs to a text field rather than to a global shortcut. */
export function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      target.isContentEditable)
  );
}
