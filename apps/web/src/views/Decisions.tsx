import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type {
  ActionRecord,
  DraftInput,
  Email,
  Matter,
  Page,
} from "@passport/types";
import { api } from "../api";
import { useResource, useTask } from "../state";
import {
  Badge,
  Empty,
  Feedback,
  Icon,
  Loading,
  PageHeader,
  relativeTime,
} from "../components/ui";

export function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000));
  return (
    <span>
      {seconds
        ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
        : "Releasing soon"}
    </span>
  );
}
export function DecisionCard({
  action,
  selected = false,
  onSelect,
}: {
  action: ActionRecord;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const draft = (action.request.params as { draft?: DraftInput }).draft;
  const source = useResource<Email>(
    draft?.inReplyToEmailId
      ? `/emails/${encodeURIComponent(draft.inReplyToEmailId)}`
      : null,
  );
  const [editing, setEditing] = useState(false),
    [body, setBody] = useState(draft?.textBody ?? ""),
    textarea = useRef<HTMLTextAreaElement>(null);
  const task = useTask(),
    held = action.status === "held";
  useEffect(() => {
    if (editing) textarea.current?.focus();
  }, [editing]);
  const approve = () =>
    task.run(
      () =>
        api.approve(
          action.id,
          editing && draft
            ? {
                ...action.request,
                params: {
                  ...action.request.params,
                  draft: { ...draft, textBody: body },
                },
              }
            : undefined,
        ),
      action.request.type === "send"
        ? "Approved. The outbox safety window applies before sending."
        : "Action approved.",
    );
  return (
    <article
      className={`decision-card ${selected ? "selected" : ""} ${held ? "held" : ""}`}
      data-decision={action.id}
      tabIndex={0}
      onFocus={onSelect}
      onClick={onSelect}
      aria-label={action.request.reason}
    >
      <div className="card-topline">
        <span className="agent-label">
          <Icon name={held ? "clock" : "sparkle"} size={15} />
          {held ? "In your outbox" : "Passport suggests"}
        </span>
        <span className="subtle">{relativeTime(action.createdAt)}</span>
      </div>
      <h3>{action.request.reason}</h3>
      {source.data && (
        <details className="source-email">
          <summary>
            <span>
              {source.data.from[0]?.name ?? source.data.from[0]?.email}
            </span>
            <span>{source.data.subject}</span>
          </summary>
          <p>{source.data.textBody ?? source.data.preview}</p>
        </details>
      )}
      {draft && (
        <div className="draft-preview">
          <div className="draft-meta">
            <span>
              To{" "}
              <strong>
                {draft.to.map((p) => p.name ?? p.email).join(", ")}
              </strong>
            </span>
            <Badge>{held ? "Ready to send" : "Draft reply"}</Badge>
          </div>
          <div className="draft-subject">{draft.subject}</div>
          {editing ? (
            <textarea
              ref={textarea}
              aria-label="Draft body"
              className="draft-editor"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          ) : (
            <p className="draft-body">{draft.textBody}</p>
          )}
        </div>
      )}
      {!draft && (
        <div className="action-preview">
          <Icon name="activity" />
          {action.request.type.replaceAll("_", " ")}
          <span>{action.decision.reason}</span>
        </div>
      )}
      <Feedback error={task.error} />
      <div className="card-footer">
        <span className="policy-note">
          <Icon name={held ? "clock" : "trust"} size={15} />
          {held && action.holdUntil ? (
            <>
              Sends in{" "}
              <strong>
                <Countdown until={action.holdUntil} />
              </strong>
            </>
          ) : (
            "Your approval keeps you in control"
          )}
        </span>
        <div className="button-row">
          {held ? (
            <button
              className="button secondary"
              data-action="cancel"
              disabled={task.busy}
              onClick={() =>
                task.run(
                  () => api.cancel(action.id),
                  "Send cancelled. Nothing left your outbox.",
                )
              }
            >
              Cancel send
            </button>
          ) : (
            <>
              <button
                className="button text"
                data-action="reject"
                disabled={task.busy}
                onClick={() =>
                  task.run(
                    () => api.reject(action.id),
                    "Rejected. Passport will learn from your choice.",
                  )
                }
              >
                Reject
              </button>
              {draft && (
                <button
                  className="button secondary"
                  data-action="edit"
                  disabled={task.busy}
                  onClick={() => setEditing(!editing)}
                >
                  <Icon name="pencil" size={14} />
                  {editing ? "Keep original" : "Edit"}
                </button>
              )}
              <button
                className="button primary"
                data-action="approve"
                disabled={task.busy || (editing && !body.trim())}
                onClick={approve}
              >
                <Icon name="check" size={16} />
                {task.busy ? "Saving…" : editing ? "Edit & approve" : "Approve"}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
export function Decisions() {
  const decisions = useResource<Page<ActionRecord>>("/decisions"),
    matters = useResource<Matter[]>("/matters");
  const [selected, setSelected] = useState<string>(),
    task = useTask();
  const items = decisions.data?.items ?? [],
    proposed = items.filter((a) => a.status === "proposed"),
    held = items.filter((a) => a.status === "held");
  const grouped = new Map<string, ActionRecord[]>();
  for (const action of proposed) {
    const key = action.request.matterId ?? "unassigned";
    grouped.set(key, [...(grouped.get(key) ?? []), action]);
  }
  const ordered = [...grouped.values()].flat();
  useEffect(() => {
    if (!ordered.some((a) => a.id === selected)) setSelected(ordered[0]?.id);
  }, [decisions.data, selected]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A", "SUMMARY"].includes(
            event.target.tagName,
          ) ||
            event.target.isContentEditable))
      )
        return;
      if (!["j", "k", "a", "r", "e"].includes(event.key)) return;
      event.preventDefault();
      const index = Math.max(
        0,
        ordered.findIndex((a) => a.id === selected),
      );
      if (event.key === "j" || event.key === "k") {
        const next =
          ordered[
            Math.max(
              0,
              Math.min(
                ordered.length - 1,
                index + (event.key === "j" ? 1 : -1),
              ),
            )
          ];
        if (next) {
          setSelected(next.id);
          const element = document.querySelector<HTMLElement>(
            `[data-decision="${CSS.escape(next.id)}"]`,
          );
          element?.focus({ preventScroll: true });
          element?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
        }
      } else {
        const element = document.querySelector<HTMLElement>(
          `[data-decision="${CSS.escape(selected ?? "")}"]`,
        );
        element
          ?.querySelector<HTMLButtonElement>(
            `[data-action="${{ a: "approve", r: "reject", e: "edit" }[event.key]}"]`,
          )
          ?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decisions.data, selected]);
  return (
    <>
      <PageHeader
        eyebrow={new Date().toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        })}
        title="A little attention. A lot in motion."
        description="Passport has done the sorting. These are the things that need you."
      >
        <button
          className="button secondary"
          disabled={task.busy}
          onClick={() =>
            task.run(
              api.runAgent,
              "Review complete. Your decisions are up to date.",
            )
          }
        >
          <Icon name="sparkle" size={16} />
          {task.busy ? "Reviewing…" : "Run a review"}
        </button>
      </PageHeader>
      <Feedback error={decisions.error ?? task.error} />
      {decisions.loading && !decisions.data ? (
        <Loading />
      ) : (
        <div className="decisions-layout">
          <div>
            <div className="section-heading">
              <h2>
                For your decision{" "}
                <span className="count">{proposed.length}</span>
              </h2>
              <span className="subtle">A human touch, where it matters.</span>
            </div>
            {!proposed.length && (
              <Empty title="You’re all caught up.">
                A little room to breathe. New decisions will appear here.
              </Empty>
            )}
            {[...grouped].map(([id, actions]) => (
              <section className="matter-group" key={id}>
                <div className="matter-group-title">
                  <Icon name="matters" size={16} />
                  {id === "unassigned" ? (
                    "Your workspace"
                  ) : (
                    <Link to={`/matters/${id}`}>
                      {matters.data?.find((m) => m.id === id)?.title ??
                        "Matter"}
                    </Link>
                  )}
                  <span>
                    {actions.length}{" "}
                    {actions.length === 1 ? "decision" : "decisions"}
                  </span>
                </div>
                {actions.map((action) => (
                  <DecisionCard
                    key={action.id}
                    action={action}
                    selected={selected === action.id}
                    onSelect={() => setSelected(action.id)}
                  />
                ))}
              </section>
            ))}
          </div>
          <aside className="right-rail">
            <div className="rail-card overview">
              <span className="eyebrow">QUIETLY MOVING FORWARD</span>
              <div className="stat">
                <strong>
                  {matters.data?.filter((m) => m.status === "active").length ??
                    "—"}
                </strong>
                <span>active matters</span>
              </div>
              <div className="stat">
                <strong>{held.length}</strong>
                <span>
                  {held.length === 1 ? "send" : "sends"} in the safety window
                </span>
              </div>
              <Link className="inline-link" to="/activity">
                See what’s been handled <Icon name="arrow" size={16} />
              </Link>
            </div>
            {held.length > 0 && (
              <div className="rail-card">
                <div className="section-heading">
                  <h2>
                    <Icon name="clock" size={17} /> Outbox
                  </h2>
                  <Badge tone="amber">{held.length} held</Badge>
                </div>
                <p className="subtle">
                  A moment to change your mind before anything leaves.
                </p>
                {held.map((a) => (
                  <div className="held-summary" key={a.id}>
                    <strong>
                      {(a.request.params as { draft?: DraftInput }).draft?.to[0]
                        ?.name ?? "Outgoing message"}
                    </strong>
                    <p>{a.request.reason}</p>
                    <div className="outbox-time">
                      <Countdown until={a.holdUntil!} />
                      <CancelButton action={a} />
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="rail-card trust-note">
              <Icon name="trust" size={25} />
              <h3>Trust grows at your pace.</h3>
              <p>
                Every approval, edit, and rejection helps Passport understand
                how you work.
              </p>
              <Link to="/trust" className="inline-link">
                Your trust settings <Icon name="arrow" size={16} />
              </Link>
            </div>
            <div className="keyboard-hints">
              <span>
                <kbd>j</kbd>
                <kbd>k</kbd> move
              </span>
              <span>
                <kbd>a</kbd> approve
              </span>
              <span>
                <kbd>r</kbd> reject
              </span>
              <span>
                <kbd>e</kbd> edit
              </span>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
export function CancelButton({ action }: { action: ActionRecord }) {
  const task = useTask();
  return (
    <div>
      <button
        className="button text"
        disabled={task.busy}
        onClick={() => task.run(() => api.cancel(action.id), "Send cancelled.")}
      >
        Cancel
      </button>
      <Feedback error={task.error} />
    </div>
  );
}
