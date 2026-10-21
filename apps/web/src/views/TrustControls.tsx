import type { TrustLevel } from "@passport/types";
import { TRUST_LEVELS } from "@passport/types";
import { useRef } from "react";
import { api, type TrustData } from "../api";
import { Popover } from "../components/Popover";
import { Feedback, Icon } from "../components/ui";
import { categoryLabel } from "../labels";
import { useResource, useTask } from "../state";
import { useUi } from "../ui-state";
import { modeLabel, modes } from "./trust-modes";

/** Four rungs filled up to the current level: the ladder at a glance. */
export function TrustLadder({ level }: { level: TrustLevel }) {
  const reached = TRUST_LEVELS.indexOf(level);
  return (
    <span className={`ladder ladder-${level}`} aria-hidden="true">
      {TRUST_LEVELS.map((rung, i) => (
        <span key={rung} className={i <= reached ? "on" : ""} />
      ))}
    </span>
  );
}

export function TrustPicker({
  value,
  onChange,
  disabled = false,
  compact = false,
}: {
  value: TrustLevel;
  onChange: (value: TrustLevel) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={group}
      className={`mode-picker ${compact ? "compact" : ""}`}
      role="radiogroup"
      aria-label="Permission mode"
      onKeyDown={(e) => {
        if (!["ArrowDown", "ArrowUp"].includes(e.key)) {
          return;
        }
        e.preventDefault();
        const radios = [...(group.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
        const index = radios.indexOf(document.activeElement as HTMLElement);
        radios[(index + (e.key === "ArrowDown" ? 1 : -1) + radios.length) % radios.length]?.focus();
      }}
    >
      {modes.map((mode) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === mode.id}
          tabIndex={value === mode.id ? 0 : -1}
          disabled={disabled}
          key={mode.id}
          className={`mode-option ${value === mode.id ? "active" : ""} mode-${mode.id}`}
          onClick={() => onChange(mode.id)}
        >
          <TrustLadder level={mode.id} />
          <span className="mode-text">
            <strong>{mode.label}</strong>
            <small>{mode.description}</small>
          </span>
          {value === mode.id && <Icon name="check" size={15} />}
        </button>
      ))}
    </div>
  );
}

/** The hero control: the global mode, one click away in the sidebar and composer. */
export function ModeMenu({
  placement = "below",
  variant = "sidebar",
}: {
  placement?: "above" | "below";
  variant?: "sidebar" | "composer";
}) {
  const trust = useResource<TrustData>("/trust"),
    task = useTask(),
    { openSettings } = useUi();
  const level = trust.data?.config.globalMode;
  if (!level) {
    return (
      <span className={`mode-trigger in-${variant} placeholder`} aria-hidden="true">
        <TrustLadder level="supervised" />
      </span>
    );
  }
  const current = modes.find((m) => m.id === level)!;
  return (
    <Popover
      label={`Permission mode: ${current.label}`}
      placement={placement}
      className={`mode-menu in-${variant}`}
      triggerClassName={`mode-trigger in-${variant} mode-${level}`}
      trigger={
        <>
          <TrustLadder level={level} />
          <span className="mode-trigger-label">{current.label}</span>
          <Icon name="chevron" size={14} className="chevron" />
        </>
      }
    >
      {(close) => (
        <>
          <div className="popover-title">How much Passport does without asking</div>
          <TrustPicker
            compact
            value={level}
            disabled={task.busy}
            onChange={(mode) => {
              if (mode === level) {
                return close();
              }
              void task
                .run(
                  () => api.setTrust({ globalMode: mode }),
                  `Permission mode set to ${modeLabel(mode)}.`,
                )
                .then((ok) => ok && close());
            }}
          />
          <Feedback error={task.error} />
          <div className="popover-footer">
            <span>
              Always asks about{" "}
              {trust.data!.config.alwaysAsk.length
                ? trust.data!.config.alwaysAsk.map((c) => categoryLabel(c).toLowerCase()).join(", ")
                : "nothing in particular"}
              .
            </span>
            <button
              type="button"
              className="link-btn"
              onClick={() => {
                close();
                openSettings("trust");
              }}
            >
              Trust & rules
            </button>
          </div>
        </>
      )}
    </Popover>
  );
}
