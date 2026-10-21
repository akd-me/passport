import type { GlobalPolicyConfig, TrustLevel } from "@passport/types";
import { TRUST_LEVELS } from "@passport/types";
import { useState } from "react";
import { api, type TrustData } from "../api";
import { Feedback } from "../components/ui";
import { CATEGORIES, categoryLabel } from "../labels";
import { useTask } from "../state";
import { modeLabel, modes } from "./trust-modes";

export function SafetyForm({ config }: { config: GlobalPolicyConfig }) {
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

export function CategoryTable({ data }: { data: TrustData }) {
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
