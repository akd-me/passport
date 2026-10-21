import type { ActionRecord, Page } from "@passport/types";
import { useState } from "react";
import { AccountDot, useAccountId } from "../accounts/AccountFilter";
import { queryString } from "../api";
import { Empty, Feedback, humanize, Icon, Loading } from "../components/ui";
import { actionLabel, CATEGORIES, categoryLabel } from "../labels";
import { Surface } from "../shell/Surface";
import { useResource } from "../state";
import { DecisionCard, UndoButton } from "./Decisions";

const statusTone: Record<string, string> = {
  executed: "good",
  held: "warn",
  failed: "danger",
  rejected: "",
  undone: "",
  proposed: "ink",
};

/** The action log: every change, who made it, and a way back where one exists. */
export function Activity() {
  const accountId = useAccountId();
  const today = new Date().toLocaleDateString("en-CA"),
    [date, setDate] = useState(today),
    [status, setStatus] = useState(""),
    [category, setCategory] = useState(""),
    [actorKind, setActor] = useState(""),
    [cursor, setCursor] = useState("");
  const after = date ? new Date(`${date}T00:00:00`).toISOString() : undefined,
    end = date ? new Date(`${date}T00:00:00`) : undefined;
  if (end) {
    end.setDate(end.getDate() + 1);
  }
  const before = end ? new Date(end.getTime() - 1).toISOString() : undefined;
  const { data, error } = useResource<Page<ActionRecord>>(
      `/actions${queryString({ accountId, status, category, actorKind, after, before, limit: 30, cursor })}`,
    ),
    outbox = useResource<Page<ActionRecord>>(
      `/actions${queryString({ accountId, status: "held", limit: 500 })}`,
    );
  const reset = (callback: () => void) => {
    callback();
    setCursor("");
  };
  return (
    <Surface title="Activity" wide>
      <div className="list-head">
        <h1>Activity</h1>
        <span className="muted num">{data?.total ?? ""}</span>
      </div>
      {!!outbox.data?.items.length && (
        <section className="group" aria-label="Outbox">
          <div className="group-head">
            <h2>In the outbox</h2>
            <span className="count">{outbox.data.items.length}</span>
            <span className="muted">You can still cancel these.</span>
          </div>
          {outbox.data.items.map((a) => (
            <DecisionCard key={a.id} action={a} />
          ))}
        </section>
      )}
      <div className="toolbar">
        <label className="sr-only" htmlFor="activity-date">
          Activity date
        </label>
        <input
          id="activity-date"
          className="select-sm"
          type="date"
          value={date}
          onChange={(e) => reset(() => setDate(e.target.value))}
        />
        <select
          className="select-sm"
          aria-label="Action status"
          value={status}
          onChange={(e) => reset(() => setStatus(e.target.value))}
        >
          <option value="">Any status</option>
          {["proposed", "held", "executed", "rejected", "undone", "failed"].map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
        <select
          className="select-sm"
          aria-label="Action category"
          value={category}
          onChange={(e) => reset(() => setCategory(e.target.value))}
        >
          <option value="">Any category</option>
          {CATEGORIES.map((c) => (
            <option value={c} key={c}>
              {categoryLabel(c)}
            </option>
          ))}
        </select>
        <select
          className="select-sm"
          aria-label="Actor"
          value={actorKind}
          onChange={(e) => reset(() => setActor(e.target.value))}
        >
          <option value="">Anyone</option>
          <option value="human">You</option>
          <option value="agent">Passport</option>
          <option value="external-agent">External agents</option>
        </select>
      </div>
      <Feedback error={error ?? outbox.error} />
      {!data ? (
        !error && <Loading />
      ) : !data.items.length ? (
        <Empty title="Nothing recorded for these filters." icon="activity">
          Pick another day or clear a filter.
        </Empty>
      ) : (
        <ul className="rows log">
          {data.items.map((a) => {
            function actionIcon() {
              if (a.status === "undone") {
                return "undo";
              }
              if (a.request.actor.kind === "human") {
                return "check";
              }
              if (a.request.actor.kind === "agent") {
                return "sparkle";
              }
              return "agent";
            }
            return (
              <li key={a.id} className="row log-row">
                <span
                  className="actor"
                  title={
                    a.request.actor.kind === "human"
                      ? "You"
                      : a.request.actor.kind === "agent"
                        ? "Passport"
                        : a.request.actor.id
                  }
                >
                  <Icon name={actionIcon()} size={13} />
                </span>
                <span className="row-main">
                  <strong>
                    <AccountDot id={a.request.accountId} />
                    {a.request.reason}
                  </strong>
                  <span className="muted">
                    {actionLabel(a.request.type)}, {categoryLabel(a.request.category).toLowerCase()}
                    , by{" "}
                    {a.request.actor.kind === "human"
                      ? "you"
                      : a.request.actor.kind === "agent"
                        ? "Passport"
                        : a.request.actor.id}
                  </span>
                  {a.error && <span className="error-text">{a.error}</span>}
                </span>
                <span className="row-meta">
                  <span className={`badge ${statusTone[a.status] ?? ""}`}>
                    {humanize(a.status)}
                  </span>
                  <time className="muted num" dateTime={a.createdAt}>
                    {new Date(a.createdAt).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                  {a.status === "executed" && a.inverse ? (
                    <UndoButton action={a} />
                  ) : (
                    <span className="undo-gap" />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {(cursor || data?.nextCursor) && (
        <div className="pagination">
          <button className="btn btn-sm" disabled={!cursor} onClick={() => setCursor("")}>
            First page
          </button>
          <button
            className="btn btn-sm"
            disabled={!data?.nextCursor}
            onClick={() => setCursor(data?.nextCursor ?? "")}
          >
            Next page
          </button>
        </div>
      )}
    </Surface>
  );
}
