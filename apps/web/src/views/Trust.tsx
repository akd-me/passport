import type {
  ActionCategory,
  GlobalPolicyConfig,
  PromotionOffer,
  TrustLevel,
} from "@passport/types";
import { TRUST_LEVELS } from "@passport/types";
import { useRef, useState } from "react";
import { api, type TrustData } from "../api";
import { Popover } from "../components/Popover";
import { Feedback, Icon, Loading } from "../components/ui";
import { CATEGORIES, categoryLabel } from "../labels";
import { ProfileEditor } from "../settings/ProfileEditor";
import { useResource, useTask } from "../state";
import { useUi } from "../ui-state";

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
        if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
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
  if (!level)
    return (
      <span className={`mode-trigger in-${variant} placeholder`} aria-hidden="true">
        <TrustLadder level="supervised" />
      </span>
    );
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
              if (mode === level) return close();
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

const DISMISSED = "passport.dismissedOffers";
const offerKey = (offer: PromotionOffer) => `${offer.category}:${offer.to}`;
function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED) ?? "[]") as string[];
  } catch {
    return [];
  }
}

/** Promotion offers from the policy engine, raised where the work happens. */
export function PromotionPrompts() {
  const trust = useResource<TrustData>("/trust"),
    task = useTask(),
    [dismissed, setDismissed] = useState(readDismissed);
  const offers =
    trust.data?.promotionOffers.filter(
      (offer) =>
        !dismissed.includes(offerKey(offer)) &&
        !trust.data!.categories.find((c) => c.category === offer.category)?.pinnedLevel,
    ) ?? [];
  if (!offers.length) return null;
  const dismiss = (offer: PromotionOffer) => {
    const next = [...dismissed, offerKey(offer)];
    setDismissed(next);
    try {
      localStorage.setItem(DISMISSED, JSON.stringify(next));
    } catch {
      /* Session-only dismissal is acceptable. */
    }
  };
  return (
    <div className="offers">
      {offers.map((offer) => (
        <div className="offer" key={offerKey(offer)} role="status">
          <TrustLadder level={offer.to} />
          <p>
            <strong>{categoryLabel(offer.category)}</strong>: {offer.evidence.approvalsUnchanged} of{" "}
            {offer.evidence.approvals} approved without changes in {offer.evidence.window}. Let
            Passport handle these on {modeLabel(offer.to)}?
          </p>
          <button
            type="button"
            className="btn btn-sm"
            disabled={task.busy}
            onClick={() =>
              task.run(
                () => api.pin(offer.category, offer.to),
                `${categoryLabel(offer.category)} now run on ${modeLabel(offer.to)}, within your global mode.`,
              )
            }
          >
            Allow {modeLabel(offer.to)}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Dismiss the ${categoryLabel(offer.category)} suggestion`}
            onClick={() => dismiss(offer)}
          >
            <Icon name="close" size={14} />
          </button>
          <Feedback error={task.error} />
        </div>
      ))}
    </div>
  );
}

function SafetyForm({ config }: { config: GlobalPolicyConfig }) {
  const [minutes, setMinutes] = useState(config.outboxHoldMinutes),
    [days, setDays] = useState(config.decayAfterDays),
    [alwaysAsk, setAlwaysAsk] = useState(config.alwaysAsk),
    [ceiling, setCeiling] = useState(config.externalAgentCeiling);
  const task = useTask();
  return (
    <form
      className="settings-block"
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(
          () =>
            api.setTrust({
              outboxHoldMinutes: minutes,
              decayAfterDays: days,
              alwaysAsk,
              externalAgentCeiling: ceiling,
            }),
          "Safety rules saved.",
        );
      }}
    >
      <h3>Safety rules</h3>
      <div className="field-row">
        <label className="field">
          <span>Outbox hold</span>
          <span className="input-unit">
            <input
              type="number"
              min="0"
              max="1440"
              required
              value={minutes}
              onChange={(e) => setMinutes(e.target.valueAsNumber)}
            />
            <span>minutes</span>
          </span>
          <small>Time to cancel a send before it leaves.</small>
        </label>
        <label className="field">
          <span>Trust decay</span>
          <span className="input-unit">
            <input
              type="number"
              min="1"
              max="3650"
              required
              value={days}
              onChange={(e) => setDays(e.target.valueAsNumber)}
            />
            <span>days</span>
          </span>
          <small>Inactivity before earned trust starts to fade.</small>
        </label>
        <label className="field">
          <span>External agent ceiling</span>
          <select value={ceiling} onChange={(e) => setCeiling(e.target.value as TrustLevel)}>
            {modes.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.label}
              </option>
            ))}
          </select>
          <small>The most an MCP client such as Claude Code may do.</small>
        </label>
      </div>
      <fieldset className="field">
        <legend>Always ask me about</legend>
        <div className="chip-set">
          {CATEGORIES.map((category) => (
            <label className="chip-toggle" key={category}>
              <input
                type="checkbox"
                checked={alwaysAsk.includes(category)}
                onChange={(e) =>
                  setAlwaysAsk(
                    e.target.checked
                      ? [...alwaysAsk, category]
                      : alwaysAsk.filter((c) => c !== category),
                  )
                }
              />
              {categoryLabel(category)}
            </label>
          ))}
        </div>
      </fieldset>
      <Feedback error={task.error} />
      <div className="form-actions">
        <button className="btn btn-primary" disabled={task.busy}>
          {task.busy ? "Saving…" : "Save safety rules"}
        </button>
      </div>
    </form>
  );
}

function CategoryTable({ data }: { data: TrustData }) {
  const task = useTask();
  return (
    <section className="settings-block">
      <h3>Trust by category</h3>
      <p className="hint">
        Each category earns trust from your decisions. The global mode is always the ceiling; pin a
        level to override what was earned.
      </p>
      <Feedback error={task.error} />
      <table className="data-table trust-table">
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Earned</th>
            <th scope="col" className="num">
              Approved
            </th>
            <th scope="col" className="num">
              Edited
            </th>
            <th scope="col" className="num">
              Rejected
            </th>
            <th scope="col">Runs as</th>
          </tr>
        </thead>
        <tbody>
          {data.categories.map((state) => (
            <tr key={state.category}>
              <th scope="row">
                {categoryLabel(state.category)}
                {data.config.alwaysAsk.includes(state.category) && (
                  <span className="muted"> · always asks</span>
                )}
              </th>
              <td>
                <span className="meter-cell">
                  <span
                    className="meter"
                    role="meter"
                    aria-label={`${categoryLabel(state.category)} confidence`}
                    aria-valuenow={Math.round(state.score * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span style={{ width: `${state.score * 100}%` }} />
                  </span>
                  <span className="num muted">{Math.round(state.score * 100)}%</span>
                </span>
              </td>
              <td className="num">{state.approvals}</td>
              <td className="num">{state.edits}</td>
              <td className="num">{state.rejections}</td>
              <td>
                <select
                  className="select-sm"
                  aria-label={`Pin ${categoryLabel(state.category)}`}
                  disabled={task.busy}
                  value={state.pinnedLevel ?? ""}
                  onChange={(e) =>
                    task.run(
                      () =>
                        api.pin(
                          state.category,
                          e.target.value ? (e.target.value as TrustLevel) : null,
                        ),
                      "Category level updated.",
                    )
                  }
                >
                  <option value="">Earned: {modeLabel(state.level)}</option>
                  {TRUST_LEVELS.map((level) => (
                    <option value={level} key={level}>
                      Pinned: {modeLabel(level)}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Settings → Trust & rules. */
export function TrustSettings() {
  const { data, error } = useResource<TrustData>("/trust"),
    profile = useResource<{ markdown: string }>("/user-profile"),
    task = useTask();
  if (!data) return error ? <Feedback error={error} /> : <Loading />;
  return (
    <>
      <section className="settings-block">
        <h3>Permission mode</h3>
        <p className="hint">
          The same ladder as a coding agent’s permission picker. It is also in the sidebar and under
          the composer.
        </p>
        <TrustPicker
          value={data.config.globalMode}
          disabled={task.busy}
          onChange={(mode) =>
            task.run(
              () => api.setTrust({ globalMode: mode }),
              `Permission mode set to ${modeLabel(mode)}.`,
            )
          }
        />
        <Feedback error={task.error} />
      </section>
      <PromotionPrompts />
      <CategoryTable data={data} />
      <SafetyForm key={JSON.stringify(data.config)} config={data.config} />
      {profile.data ? (
        <ProfileEditor markdown={profile.data.markdown} />
      ) : (
        <Feedback error={profile.error} />
      )}
    </>
  );
}
export type { ActionCategory };
