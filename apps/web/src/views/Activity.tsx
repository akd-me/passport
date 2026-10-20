import { useState } from "react";
import type { ActionRecord, Page } from "@passport/types";
import { api, queryString } from "../api";
import { useResource, useTask } from "../state";
import {
  Badge,
  Empty,
  Feedback,
  humanize,
  Icon,
  Loading,
  PageHeader,
} from "../components/ui";
import { DecisionCard } from "./Decisions";
function UndoButton({ action }: { action: ActionRecord }) {
  const task = useTask();
  return (
    <div>
      <button
        className="button secondary compact"
        disabled={task.busy}
        onClick={() =>
          task.run(
            () => api.undo(action.id),
            "Action undone. The inverse is recorded in your activity.",
          )
        }
      >
        <Icon name="undo" size={14} />
        {task.busy ? "Undoing…" : "Undo"}
      </button>
      <Feedback error={task.error} />
    </div>
  );
}
export function Activity() {
  const today = new Date().toLocaleDateString("en-CA"),
    [date, setDate] = useState(today),
    [status, setStatus] = useState(""),
    [category, setCategory] = useState(""),
    [actorKind, setActor] = useState(""),
    [cursor, setCursor] = useState("");
  const after = date ? new Date(`${date}T00:00:00`).toISOString() : undefined,
    end = date ? new Date(`${date}T00:00:00`) : undefined;
  if (end) end.setDate(end.getDate() + 1);
  const before = end ? new Date(end.getTime() - 1).toISOString() : undefined;
  const { data, error } = useResource<Page<ActionRecord>>(
      `/actions${queryString({ status, category, actorKind, after, before, limit: 30, cursor })}`,
    ),
    outbox = useResource<Page<ActionRecord>>("/actions?status=held&limit=500");
  const reset = (callback: () => void) => {
    callback();
    setCursor("");
  };
  return (
    <>
      <PageHeader
        eyebrow="NOTHING HAPPENS OFF THE RECORD"
        title="A clear trail. A calmer mind."
        description="Every action, every decision, and a way back whenever it’s possible."
      />
      {!!outbox.data?.items.length && (
        <section className="outbox-section">
          <div className="section-heading">
            <h2>
              <Icon name="clock" /> The outbox safety window
            </h2>
            <Badge tone="amber">{outbox.data.items.length} held</Badge>
          </div>
          {outbox.data.items.map((a) => (
            <DecisionCard key={a.id} action={a} />
          ))}
        </section>
      )}
      <div className="section-heading">
        <h2>Your daily activity</h2>
        <span className="subtle">{data?.total ?? "—"} actions</span>
      </div>
      <div className="filter-bar activity-filters">
        <label className="sr-only" htmlFor="activity-date">
          Activity date
        </label>
        <input
          id="activity-date"
          type="date"
          value={date}
          onChange={(e) => reset(() => setDate(e.target.value))}
        />
        <select
          aria-label="Action status"
          value={status}
          onChange={(e) => reset(() => setStatus(e.target.value))}
        >
          <option value="">All statuses</option>
          {["proposed", "held", "executed", "rejected", "undone", "failed"].map(
            (s) => (
              <option key={s}>{s}</option>
            ),
          )}
        </select>
        <select
          aria-label="Action category"
          value={category}
          onChange={(e) => reset(() => setCategory(e.target.value))}
        >
          <option value="">All categories</option>
          {[
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
          ].map((c) => (
            <option value={c} key={c}>
              {humanize(c)}
            </option>
          ))}
        </select>
        <select
          aria-label="Actor"
          value={actorKind}
          onChange={(e) => reset(() => setActor(e.target.value))}
        >
          <option value="">Everyone</option>
          <option value="human">You</option>
          <option value="agent">Passport</option>
          <option value="external-agent">External agents</option>
        </select>
      </div>
      <Feedback error={error ?? outbox.error} />
      {!data ? (
        !error && <Loading />
      ) : !data.items.length ? (
        <Empty title="A quiet day.">No actions match these filters.</Empty>
      ) : (
        <div className="panel activity-list">
          {data.items.map((a) => (
            <article className="activity-row" key={a.id}>
              <span
                className={`activity-icon ${a.status === "executed" ? "green" : ""}`}
              >
                <Icon
                  name={
                    a.status === "undone"
                      ? "undo"
                      : a.request.actor.kind === "human"
                        ? "people"
                        : "sparkle"
                  }
                  size={19}
                />
              </span>
              <div className="activity-main">
                <strong>{a.request.reason}</strong>
                <p>
                  {humanize(a.request.type)} · {humanize(a.request.category)} ·{" "}
                  {a.request.actor.kind === "human" ? "You" : "Passport"}
                </p>
                {a.error && <span className="subtle">{a.error}</span>}
              </div>
              <div className="activity-status">
                <Badge
                  tone={
                    a.status === "executed"
                      ? "green"
                      : a.status === "held"
                        ? "amber"
                        : ""
                  }
                >
                  {humanize(a.status)}
                </Badge>
                <time>
                  {new Date(a.createdAt).toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              {a.status === "executed" && a.inverse && (
                <UndoButton action={a} />
              )}
            </article>
          ))}
        </div>
      )}
      {(cursor || data?.nextCursor) && (
        <div className="pagination">
          <button
            className="button secondary"
            disabled={!cursor}
            onClick={() => setCursor("")}
          >
            First page
          </button>
          <button
            className="button secondary"
            disabled={!data?.nextCursor}
            onClick={() => setCursor(data?.nextCursor ?? "")}
          >
            Next page <Icon name="arrow" size={16} />
          </button>
        </div>
      )}
    </>
  );
}
