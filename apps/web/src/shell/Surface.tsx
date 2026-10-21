import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { useUi } from "../ui-state";
import { useAccounts, AccountDot } from "../accounts/AccountFilter";
import { Icon, mod } from "../components/ui";

export interface Crumb {
  label: string;
  to?: string;
}

/** Account scope shown in the topbar; clearing it returns to all accounts. */
function ScopeChip() {
  const [params, setParams] = useSearchParams(),
    { accounts } = useAccounts();
  const id = params.get("accountId");
  if (!id) return null;
  const account = accounts.find((a) => a.id === id);
  return (
    <span className="scope-chip">
      <AccountDot id={id} />
      {account?.emailAddress ?? "One account"}
      <button
        type="button"
        aria-label="Show all accounts"
        onClick={() => {
          const next = new URLSearchParams(params);
          next.delete("accountId");
          setParams(next);
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}

/**
 * One work surface: a slim topbar, a centred scrolling column, an optional docked composer
 * and an optional details panel on the right (toggled with ⌘. ).
 */
export function Surface({
  title,
  crumbs,
  actions,
  details,
  detailsLabel = "Details",
  composer,
  children,
  wide = false,
}: {
  title: string;
  crumbs?: Crumb[];
  actions?: ReactNode;
  details?: ReactNode;
  detailsLabel?: string;
  composer?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const { sidebar, toggleSidebar, details: detailsOpen, toggleDetails } = useUi();
  const trail = crumbs ?? [{ label: title }];
  return (
    <div className="surface">
      <div className="surface-main">
        <header className="topbar">
          {!sidebar && (
            <button
              type="button"
              className="icon-btn"
              aria-label={`Show sidebar (${mod}B)`}
              title={`Show sidebar (${mod}B)`}
              onClick={toggleSidebar}
            >
              <Icon name="sidebar" />
            </button>
          )}
          <nav className="crumbs" aria-label="Breadcrumb">
            {trail.map((crumb, i) => (
              <span key={i} className="crumb">
                {crumb.to ? (
                  <Link to={crumb.to}>{crumb.label}</Link>
                ) : (
                  <span aria-current={i === trail.length - 1 ? "page" : undefined}>
                    {crumb.label}
                  </span>
                )}
                {i < trail.length - 1 && <Icon name="next" size={13} className="crumb-sep" />}
              </span>
            ))}
          </nav>
          <ScopeChip />
          <div className="topbar-actions">
            {actions}
            {details && (
              <button
                type="button"
                className="icon-btn"
                aria-pressed={detailsOpen}
                aria-label={`${detailsOpen ? "Hide" : "Show"} ${detailsLabel.toLowerCase()} (${mod}.)`}
                title={`${detailsOpen ? "Hide" : "Show"} ${detailsLabel.toLowerCase()} (${mod}.)`}
                onClick={toggleDetails}
              >
                <Icon name="panel" />
              </button>
            )}
          </div>
        </header>
        <div className="surface-scroll" id="main" tabIndex={-1}>
          <div className={`column ${wide ? "wide" : ""}`}>{children}</div>
        </div>
        {composer && <div className="dock">{composer}</div>}
      </div>
      {details && detailsOpen && (
        <aside className="details-panel" aria-label={detailsLabel}>
          <div className="details-head">
            <h2>{detailsLabel}</h2>
            <button
              type="button"
              className="icon-btn"
              aria-label={`Hide ${detailsLabel.toLowerCase()}`}
              onClick={toggleDetails}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          {details}
        </aside>
      )}
    </div>
  );
}
