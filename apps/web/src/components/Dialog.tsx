import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ui";

const focusable =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `container`; returns true when the key was handled. */
function trapTab(event: React.KeyboardEvent, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) {
    return false;
  }
  const items = [...container.querySelectorAll<HTMLElement>(focusable)].filter(
    (item) => !item.closest("[inert]"),
  );
  const first = items[0],
    last = items[items.length - 1];
  if (!first || !last) {
    return false;
  }
  if (
    event.shiftKey &&
    (document.activeElement === first || document.activeElement === container)
  ) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

/**
 * A modal surface: traps focus, closes on Escape or backdrop click, and returns focus to
 * whatever opened it.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  size = "md",
  hideTitle = false,
  className = "",
  initialFocus,
}: {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  size?: "sm" | "md" | "lg" | "palette";
  hideTitle?: boolean;
  className?: string;
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDivElement>(null),
    titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target =
      (initialFocus && ref.current?.querySelector<HTMLElement>(initialFocus)) ||
      ref.current?.querySelector<HTMLElement>("[autofocus], input, textarea") ||
      ref.current;
    target?.focus();
    return () => previous?.focus?.();
  }, [initialFocus]);
  return createPortal(
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`dialog dialog-${size} ${className}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          } else {
            trapTab(e, ref.current);
          }
        }}
      >
        <header className={`dialog-header ${hideTitle ? "floating" : ""}`}>
          <div className={hideTitle ? "sr-only" : undefined}>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
