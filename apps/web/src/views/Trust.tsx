import { useState } from "react";
import type {
  ActionCategory,
  GlobalPolicyConfig,
  TrustLevel,
} from "@passport/types";
import { TRUST_LEVELS } from "@passport/types";
import { api, type TrustData } from "../api";
import { useResource, useTask } from "../state";
import {
  Badge,
  Feedback,
  humanize,
  Icon,
  Loading,
  PageHeader,
} from "../components/ui";
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
      "Reversible changes run freely. Outward-facing actions ask first.",
    icon: "pencil",
  },
  {
    id: "auto",
    label: "Auto",
    description:
      "Passport acts where trust is earned. New territory still asks.",
    icon: "sparkle",
  },
  {
    id: "full_access",
    label: "Full access",
    description: "Passport handles everything within your always-ask rules.",
    icon: "unlock",
  },
];
export function TrustPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: TrustLevel;
  onChange: (value: TrustLevel) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mode-picker" role="radiogroup" aria-label="Permission mode">
      {modes.map((mode) => (
        <button
          type="button"
          role="radio"
          aria-checked={value === mode.id}
          disabled={disabled}
          key={mode.id}
          className={`mode-option ${value === mode.id ? "active" : ""}`}
          onClick={() => onChange(mode.id)}
        >
          <span className="mode-icon">
            <Icon name={mode.icon} />
          </span>
          <span>
            <strong>{mode.label}</strong>
            <small>{mode.description}</small>
          </span>
          <span className="radio-dot">{value === mode.id && <span />}</span>
        </button>
      ))}
    </div>
  );
}
function TrustConfig({ config }: { config: GlobalPolicyConfig }) {
  const [minutes, setMinutes] = useState(config.outboxHoldMinutes),
    [days, setDays] = useState(config.decayAfterDays),
    [alwaysAsk, setAlwaysAsk] = useState(config.alwaysAsk);
  const task = useTask();
  const categories: ActionCategory[] = [
    "triage",
    "newsletters",
    "receipts",
    "notifications",
    "scheduling",
    "replies_known",
    "replies_stranger",
    "money",
    "legal",
    "unsubscribe",
    "matters",
    "other",
  ];
  return (
    <form
      className="panel config-form"
      onSubmit={(e) => {
        e.preventDefault();
        void task.run(
          () =>
            api.setTrust({
              outboxHoldMinutes: minutes,
              decayAfterDays: days,
              alwaysAsk,
            }),
          "Safety settings saved.",
        );
      }}
    >
      <h2>Keep a little breathing room.</h2>
      <p className="subtle">
        Safety windows and standing rules, at every permission level.
      </p>
      <div className="form-columns">
        <label>
          Outbox hold{" "}
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
        <label>
          Trust decay{" "}
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
          <small>Inactivity before earned trust begins to soften.</small>
        </label>
      </div>
      <fieldset>
        <legend>Always ask me about</legend>
        <div className="checkbox-grid">
          {categories.map((category) => (
            <label className="checkbox-label" key={category}>
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
              {humanize(category)}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        External agent ceiling
        <select
          value={config.externalAgentCeiling}
          disabled={task.busy}
          onChange={(e) =>
            task.run(
              () =>
                api.setTrust({
                  externalAgentCeiling: e.target.value as TrustLevel,
                }),
              "External agent ceiling saved.",
            )
          }
        >
          {modes.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      <Feedback error={task.error} />
      <button className="button primary" disabled={task.busy}>
        {task.busy ? "Saving…" : "Save safety settings"}
      </button>
    </form>
  );
}
export function Trust() {
  const { data, error } = useResource<TrustData>("/trust"),
    task = useTask();
  return (
    <>
      <PageHeader
        eyebrow="YOUR AGENT, YOUR CALL"
        title="A little trust goes a long way."
        description="Set the boundaries. Passport earns the room to work within them."
      />
      <Feedback error={error ?? task.error} />
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <div className="trust-intro">
            <section>
              <div className="section-heading">
                <h2>Permission mode</h2>
                <Badge tone="green">You’re in control</Badge>
              </div>
              <TrustPicker
                value={data.config.globalMode}
                disabled={task.busy}
                onChange={(mode) =>
                  task.run(
                    () => api.setTrust({ globalMode: mode }),
                    "Permission mode updated.",
                  )
                }
              />
            </section>
            <div className="trust-explainer">
              <span className="orbit">
                <Icon name="trust" size={38} />
              </span>
              <h2>
                Confidence is earned,
                <br />
                one decision at a time.
              </h2>
              <p>
                Approvals build trust. Edits teach nuance. Rejections draw a
                clearer line.
              </p>
              <p>
                Your mode sets the ceiling. Each category learns at its own
                pace, and you can pin a level at any time.
              </p>
              <span className="subtle">
                Always-ask rules apply in every mode.
              </span>
            </div>
          </div>
          {data.promotionOffers
            .filter(
              (offer) =>
                !data.categories.find((c) => c.category === offer.category)
                  ?.pinnedLevel,
            )
            .map((offer) => (
              <div className="promotion-banner" key={offer.category}>
                <Icon name="sparkle" size={25} />
                <div>
                  <strong>
                    A little more room for{" "}
                    {humanize(offer.category).toLowerCase()}?
                  </strong>
                  <p>
                    {offer.message} {offer.evidence.approvalsUnchanged} of{" "}
                    {offer.evidence.approvals} approvals unchanged.
                  </p>
                </div>
                <button
                  className="button secondary"
                  disabled={task.busy}
                  onClick={() =>
                    task.run(
                      () => api.pin(offer.category, offer.to),
                      "Category pinned. Your global mode still sets the ceiling.",
                    )
                  }
                >
                  Pin to {modes.find((m) => m.id === offer.to)?.label}
                </button>
              </div>
            ))}
          <section className="panel trust-table-panel">
            <div className="panel-heading">
              <h2>Trust, by category</h2>
              <span className="subtle">Learned from your decisions</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Stage</th>
                    <th>Earned confidence</th>
                    <th>Approvals / edits / rejections</th>
                    <th>Permission pin</th>
                  </tr>
                </thead>
                <tbody>
                  {data.categories.map((state) => (
                    <tr key={state.category}>
                      <td className="table-title">
                        {humanize(state.category)}
                      </td>
                      <td>
                        <Badge tone={state.stage === "learning" ? "" : "green"}>
                          {humanize(state.stage)}
                        </Badge>
                      </td>
                      <td>
                        <div className="score-cell">
                          <span
                            className="score-track"
                            role="meter"
                            aria-label={`${humanize(state.category)} confidence`}
                            aria-valuenow={Math.round(state.score * 100)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                          >
                            <span style={{ width: `${state.score * 100}%` }} />
                          </span>
                          <span>{Math.round(state.score * 100)}%</span>
                        </div>
                      </td>
                      <td className="trust-counts">
                        <span>{state.approvals}</span>
                        <span>{state.edits}</span>
                        <span>{state.rejections}</span>
                      </td>
                      <td>
                        <select
                          aria-label={`Pin ${humanize(state.category)}`}
                          disabled={task.busy}
                          value={state.pinnedLevel ?? ""}
                          onChange={(e) =>
                            task.run(
                              () =>
                                api.pin(
                                  state.category,
                                  e.target.value
                                    ? (e.target.value as TrustLevel)
                                    : null,
                                ),
                              "Category pin updated.",
                            )
                          }
                        >
                          <option value="">
                            Earned ·{" "}
                            {modes.find((m) => m.id === state.level)?.label}
                          </option>
                          {TRUST_LEVELS.map((level) => (
                            <option value={level} key={level}>
                              {modes.find((m) => m.id === level)?.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <TrustConfig key={JSON.stringify(data.config)} config={data.config} />
        </>
      )}
    </>
  );
}
