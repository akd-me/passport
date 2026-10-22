import { useId, useState } from "react";
import { Icon } from "../components/ui";
import { milliseconds } from "./model";
import { summarizeTools, type ToolCallItem } from "./timeline-model";

const costText = (cost?: Record<string, number>) =>
  cost
    ? Object.entries(cost)
        .map(([unit, n]) => `${n} ${unit.replace(/([A-Z])/g, " $1").toLowerCase()}`)
        .join(", ")
    : "";

/** Consecutive tool calls as one line; expanding lists each call with its summaries. */
export function ToolGroup({ calls }: { calls: ToolCallItem[] }) {
  const [open, setOpen] = useState(false),
    id = useId();
  const failed = calls.some((call) => call.payload.isError);
  const total = calls.reduce((sum, call) => sum + call.payload.durationMs, 0);
  return (
    <div className={`tool-group ${open ? "open" : ""} ${failed ? "has-error" : ""}`}>
      <button
        type="button"
        className="tool-group-head"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "chevron" : "next"} size={13} />
        <span className="tool-group-summary">{summarizeTools(calls)}</span>
        <span className="tool-group-meta">
          {calls.length === 1 ? "1 step" : `${calls.length} steps`}, {milliseconds(total)}
        </span>
      </button>
      {open && (
        <ol className="tool-calls" id={id}>
          {calls.map((call) => (
            <li key={call.seq} className={call.payload.isError ? "error" : ""}>
              <div className="tool-call-head">
                <code>{call.payload.name}</code>
                {call.payload.planned && <span className="badge">Planned</span>}
                {call.payload.isError && <span className="badge danger">Failed</span>}
                <span className="tool-call-time">{milliseconds(call.payload.durationMs)}</span>
              </div>
              <dl className="tool-call-facts">
                <dt>Input</dt>
                <dd>{call.payload.inputSummary || "None"}</dd>
                <dt>{call.payload.isError ? "Error" : "Result"}</dt>
                <dd>{call.payload.resultSummary || "Nothing returned"}</dd>
                {call.payload.cost && (
                  <>
                    <dt>Cost</dt>
                    <dd>{costText(call.payload.cost)}</dd>
                  </>
                )}
              </dl>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
