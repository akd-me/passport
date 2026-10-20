import type { ReactNode } from "react";
import type { Person } from "@passport/types";
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    decisions: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="4" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    matters: (
      <>
        <rect x="3" y="6" width="18" height="15" rx="3" />
        <path d="M3 10h18M8 6V3h8v3" />
      </>
    ),
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5" />
      </>
    ),
    trust: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    activity: (
      <>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </>
    ),
    accounts: (
      <>
        <rect x="3" y="5" width="18" height="15" rx="3" />
        <path d="m3 7 9 7 9-7" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="3" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
      </>
    ),
    pencil: (
      <>
        <path d="m16 3 5 5L8 21H3v-5L16 3Zm-3 3 5 5" />
      </>
    ),
    sparkle: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4" />
      </>
    ),
    unlock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="3" />
        <path d="M9 10V7a4 4 0 0 1 8 0m-5 8v2" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    undo: (
      <>
        <path d="M8 4 3 9l5 5M3 9h11a6 6 0 0 1 0 12" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 6 6" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.decisions}
    </svg>
  );
}
export const humanize = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Verification({
  person,
}: {
  person: Pick<Person, "verification">;
}) {
  return (
    <Badge
      tone={
        person.verification === "blue"
          ? "blue"
          : person.verification === "green"
            ? "green"
            : "muted"
      }
    >
      <span className="verification-dot" />
      {humanize(person.verification)}
    </Badge>
  );
}
export function Avatar({
  name,
  small = false,
}: {
  name: string;
  small?: boolean;
}) {
  return (
    <span className={`avatar ${small ? "small" : ""}`}>
      {name
        .split(" ")
        .map((n) => n[0])
        .slice(0, 2)
        .join("")}
    </span>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {children && <div className="header-actions">{children}</div>}
    </header>
  );
}
export function Feedback({ error }: { error?: string }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="pulse-dot" />
      Getting your workspace ready…
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol">
        <Icon name="check" size={28} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function relativeTime(at: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(at)) / 60000),
  );
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          });
}
