import { type ReactNode, useEffect, useId, useRef, useState } from "react";

/**
 * A disclosure-style popover anchored to its trigger. Closes on outside click and Escape,
 * returning focus to the trigger.
 */
export function Popover({
  trigger,
  label,
  children,
  placement = "below",
  align = "start",
  className = "",
  triggerClassName = "",
}: {
  trigger: ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  placement?: "above" | "below";
  align?: "start" | "end";
  className?: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null),
    button = useRef<HTMLButtonElement>(null),
    id = useId();
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    const popover = root.current?.querySelector<HTMLElement>(".popover");
    (
      popover?.querySelector<HTMLElement>('[aria-checked="true"]') ??
      popover?.querySelector<HTMLElement>("button, input")
    )?.focus();
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div
      className={`popover-root ${className}`}
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={id}
          role="dialog"
          aria-label={label}
          className={`popover popover-${placement} popover-${align}`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
