import type { Email, Person } from "@passport/types";
import {
  Activity,
  ArrowRight,
  ArrowUp,
  Bot,
  Briefcase,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock,
  Command,
  ExternalLink,
  HardDrive,
  Inbox,
  KeyRound,
  LoaderCircle,
  Lock,
  LockOpen,
  type LucideIcon,
  Mail,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Pencil,
  PenLine,
  Plus,
  RefreshCw,
  Repeat,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

const icons: Record<string, LucideIcon> = {
  decisions: Inbox,
  queue: Inbox,
  matters: Briefcase,
  people: Users,
  trust: ShieldCheck,
  activity: Activity,
  accounts: Mail,
  mail: Mail,
  lock: Lock,
  unlock: LockOpen,
  pencil: Pencil,
  edits: PenLine,
  sparkle: Sparkles,
  arrow: ArrowRight,
  up: ArrowUp,
  clock: Clock,
  plus: Plus,
  check: Check,
  undo: Undo2,
  search: Search,
  close: X,
  settings: Settings,
  sidebar: PanelLeft,
  panel: PanelRight,
  chevron: ChevronDown,
  next: ChevronRight,
  alert: CircleAlert,
  sync: RefreshCw,
  trash: Trash2,
  calendar: Calendar,
  routine: Repeat,
  agent: Bot,
  key: KeyRound,
  disk: HardDrive,
  external: ExternalLink,
  send: Send,
  command: Command,
  spinner: LoaderCircle,
  light: Sun,
  dark: Moon,
  system: Monitor,
};
export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const Glyph = icons[name] ?? Inbox;
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      className={`icon ${name === "spinner" ? "spin" : ""} ${className ?? ""}`}
    />
  );
}
export const humanize = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export function Badge({ children, tone = "" }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
const verificationText = {
  blue: ["Verified", "Blue: signed by a Passport identity Passport can verify."],
  green: ["Standard", "Green: ordinary email, checked with DKIM, SPF and DMARC."],
  unknown: ["Unknown", "Not enough signed mail to tell yet."],
  downgraded: [
    "Downgraded",
    "This sender used to be verified and this message is not. Confirm through a known channel.",
  ],
} as const;
/** Blue and green come from signatures and authentication headers, never content. */
export function Verification({
  person,
}: {
  person: { verification: Person["verification"] | "downgraded" };
}) {
  const [label, explanation] = verificationText[person.verification];
  return (
    <span className={`verification ${person.verification}`} title={explanation}>
      <span className="verification-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
export function MailVerification({ email }: { email: Email }) {
  return <Verification person={{ verification: email.verification.passport }} />;
}
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={`avatar ${small ? "small" : ""}`} aria-hidden="true">
      {name
        .split(/\s+/)
        .map((n) => n[0])
        .slice(0, 2)
        .join("")
        .toUpperCase()}
    </span>
  );
}
export function Feedback({ error }: { error?: string }) {
  return error ? (
    <p className="error" role="alert">
      <Icon name="alert" size={14} />
      {error}
    </p>
  ) : null;
}
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Icon name="spinner" size={14} />
      {label}
    </div>
  );
}
export function Empty({
  title,
  children,
  icon = "check",
}: {
  title: string;
  children?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="empty">
      <Icon name={icon} size={18} />
      <div>
        <h2>{title}</h2>
        {children && <p>{children}</p>}
      </div>
    </div>
  );
}
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
const isMac = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform);
export const mod = isMac ? "⌘" : "Ctrl+";
export function relativeTime(at: string) {
  const delta = Math.floor((Date.now() - Date.parse(at)) / 60000);
  if (delta < -1) {
    return -delta < 60
      ? `in ${-delta}m`
      : -delta < 1440
        ? `in ${Math.round(-delta / 60)}h`
        : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  const minutes = Math.max(0, delta);
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  if (minutes < 1440) {
    return `${Math.floor(minutes / 60)}h ago`;
  }
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
