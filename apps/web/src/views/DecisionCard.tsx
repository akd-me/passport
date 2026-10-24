import type { ActionRecord, Page } from "@passport/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AccountDot, useAccountScopeLink } from "../accounts/AccountFilter";
import { type ApproveScope, api, queryString } from "../api";
import { Feedback, Icon, Kbd, relativeTime } from "../components/ui";
import { actionLabel } from "../labels";
import { useResource, useTask } from "../state";
import { useDecision } from "../tasks/actions-store";
import { ProfileProposal } from "../tasks/ProfileProposal";
import { draftOf, recipients } from "./decision-model";

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
  return (
    <span className="num">
      {seconds
        ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
        : "Releasing soon"}
    </span>
  );
}

/** One proposal: what the agent wants to do, the draft if there is one, and the decision. */
export function DecisionCard({
  action,
  selected = false,
  fresh = false,
  onSelect,
}: {
  action: ActionRecord;
  selected?: boolean;
  fresh?: boolean;
  onSelect?: () => void;
}) {
  const draft = draftOf(action);
  const [editing, setEditing] = useState(false),
    [body, setBody] = useState(draft?.textBody ?? ""),
    textarea = useRef<HTMLTextAreaElement>(null);
  const task = useTask(),
    decision = useDecision(action.id),
    busy = task.busy || decision.busy,
    held = action.status === "held";
  useEffect(() => {
    if (editing) {
      textarea.current?.focus();
    }
  }, [editing]);
  const approve = (scope: ApproveScope = "once") =>
    decision.decide(
      {
        kind: "approve",
        scope,
        edited:
          editing && draft
            ? {
                ...action.request,
                params: { ...action.request.params, draft: { ...draft, textBody: body } },
              }
            : undefined,
      },
      action.request.type === "send"
        ? "Approved. It waits in the outbox before sending."
        : scope === "task"
          ? "Approved for this task."
          : scope === "always"
            ? "Approved. Passport won’t ask about this again."
            : "Approved.",
    );
  return (
    <article
      className={`proposal ${selected ? "selected" : ""} ${held ? "held" : ""} ${fresh ? "fresh" : ""}`}
      data-decision={action.id}
      tabIndex={0}
      onFocus={onSelect}
      onClick={onSelect}
      aria-label={action.request.reason}
      aria-current={selected || undefined}
    >
      <div className="proposal-head">
        <AccountDot id={action.request.accountId} />
        <span className="proposal-kind">{actionLabel(action.request.type)}</span>
        {draft && <span className="proposal-to">to {recipients(draft)}</span>}
        <time dateTime={action.createdAt}>{relativeTime(action.createdAt)}</time>
      </div>
      <h3 className="proposal-reason">{action.request.reason}</h3>
      {draft ? (
        <div className="draft">
          <div className="draft-subject">{draft.subject}</div>
          {editing ? (
            <textarea
              ref={textarea}
              aria-label="Draft body"
              className="draft-editor"
              rows={Math.min(14, Math.max(5, body.split("\n").length + 1))}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(false);
                  setBody(draft.textBody ?? "");
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (body.trim()) {
                    void approve();
                  }
                }
              }}
            />
          ) : (
            <p className="draft-body">{draft.textBody}</p>
          )}
        </div>
      ) : (
        <p className="proposal-detail">{action.decision.reason}</p>
      )}
      <Feedback error={task.error || decision.error} />
      <ProfileProposal action={action} />
      <div className="proposal-actions">
        {held ? (
          <>
            <span className="hold-note">
              <Icon name="clock" size={14} />
              {action.holdUntil ? (
                <>
                  Sends in <Countdown until={action.holdUntil} />
                </>
              ) : (
                "Waiting in the outbox"
              )}
            </span>
            <button
              className="btn btn-sm"
              data-action="cancel"
              disabled={busy}
              onClick={() =>
                task.run(() => api.cancel(action.id), "Send cancelled. Nothing left your outbox.")
              }
            >
              Cancel send
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-sm btn-primary"
              data-action="approve"
              disabled={busy || (editing && !body.trim())}
              onClick={() => void approve()}
            >
              <Icon name="check" size={14} />
              {busy ? "Saving…" : editing ? "Edit & approve" : "Approve"}
            </button>
            {action.request.category !== "profile_update" && (
              <>
                <button
                  className="btn btn-sm"
                  data-action="approve-task"
                  disabled={busy || (editing && !body.trim())}
                  title="Approve this, and changes like it for the rest of this task"
                  onClick={() => void approve("task")}
                >
                  Approve for this task
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  data-action="approve-always"
                  disabled={busy || (editing && !body.trim())}
                  title="Approve this, and stop asking about changes like it"
                  onClick={() => void approve("always")}
                >
                  Always
                </button>
              </>
            )}
            {draft && (
              <button
                className="btn btn-sm"
                data-action="edit"
                disabled={busy}
                onClick={() => {
                  if (editing) {
                    setBody(draft.textBody ?? "");
                  }
                  setEditing(!editing);
                }}
              >
                <Icon name="pencil" size={13} />
                {editing ? "Keep original" : "Edit"}
              </button>
            )}
            <button
              className="btn btn-sm btn-ghost"
              data-action="reject"
              disabled={busy}
              onClick={() =>
                void decision.decide({ kind: "reject" }, "Rejected. Passport learns from that.")
              }
            >
              Reject
            </button>
            {selected && (
              <span className="key-hints" aria-hidden="true">
                {editing ? (
                  <>
                    <Kbd>⌘↵</Kbd> approve <Kbd>esc</Kbd> discard
                  </>
                ) : (
                  <>
                    <Kbd>a</Kbd> approve <Kbd>e</Kbd> edit <Kbd>r</Kbd> reject
                  </>
                )}
              </span>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function CancelButton({ action }: { action: ActionRecord }) {
  const task = useTask();
  return (
    <>
      <button
        className="btn btn-sm"
        disabled={task.busy}
        aria-label={`Cancel send: ${action.request.reason}`}
        onClick={() => task.run(() => api.cancel(action.id), "Send cancelled.")}
      >
        Cancel send
      </button>
      <Feedback error={task.error} />
    </>
  );
}

export function UndoButton({ action }: { action: ActionRecord }) {
  const task = useTask();
  return (
    <>
      <button
        className="btn btn-sm btn-ghost"
        disabled={task.busy}
        aria-label={`Undo: ${action.request.reason}`}
        onClick={() =>
          task.run(() => api.undo(action.id), "Undone. The reversal is in your activity.")
        }
      >
        <Icon name="undo" size={13} />
        {task.busy ? "Undoing…" : "Undo"}
      </button>
      <Feedback error={task.error} />
    </>
  );
}

export function OutboxStrip({ held }: { held: ActionRecord[] }) {
  return (
    <section className="outbox" aria-labelledby="outbox-title">
      <h2 id="outbox-title">
        <Icon name="send" size={14} />
        Leaving soon
        <span className="count">{held.length}</span>
      </h2>
      <ul>
        {held.map((a) => {
          const draft = draftOf(a);
          return (
            <li key={a.id}>
              <AccountDot id={a.request.accountId} />
              <span className="outbox-what">
                <strong>{draft ? `To ${recipients(draft)}` : actionLabel(a.request.type)}</strong>
                <span>{draft?.subject ?? a.request.reason}</span>
              </span>
              <span className="outbox-time">
                {a.holdUntil && <Countdown until={a.holdUntil} />}
              </span>
              <CancelButton action={a} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function HandledToday({ accountId }: { accountId: string }) {
  const after = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, []);
  const scope = useAccountScopeLink();
  const { data } = useResource<Page<ActionRecord>>(
    `/actions${queryString({ accountId, status: "executed", after, limit: 8 })}`,
  );
  if (!data?.items.length) {
    return null;
  }
  return (
    <section className="handled" aria-labelledby="handled-title">
      <div className="group-head">
        <h2 id="handled-title">Handled today</h2>
        <Link to={scope("/activity")} className="quiet-link">
          All activity
        </Link>
      </div>
      <ul>
        {data.items.map((a) => (
          <li key={a.id}>
            <span className="actor" title={a.request.actor.kind === "human" ? "You" : "Passport"}>
              <Icon name={a.request.actor.kind === "human" ? "check" : "sparkle"} size={13} />
            </span>
            <span className="handled-what">
              <strong>{actionLabel(a.request.type)}</strong>
              <span>{a.request.reason}</span>
            </span>
            <time dateTime={a.executedAt ?? a.createdAt}>
              {relativeTime(a.executedAt ?? a.createdAt)}
            </time>
            {a.inverse ? <UndoButton action={a} /> : <span className="undo-gap" />}
          </li>
        ))}
      </ul>
    </section>
  );
}
