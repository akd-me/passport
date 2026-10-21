import type { ActionRecord, DraftInput, Email, Matter, Page, TrustState } from "@passport/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { AccountDot, useAccountId, useAccountScopeLink } from "../accounts/AccountFilter";
import { api, type MatterDetail, queryString, type TrustData } from "../api";
import {
  Avatar,
  Empty,
  Feedback,
  Icon,
  Kbd,
  Loading,
  MailVerification,
  relativeTime,
  Verification,
} from "../components/ui";
import { actionLabel, categoryLabel } from "../labels";
import { Composer } from "../shell/Composer";
import { Surface } from "../shell/Surface";
import { useResource, useTask } from "../state";
import { isTyping, useUi } from "../ui-state";
import { modeLabel, PromotionPrompts, TrustLadder } from "./Trust";

export function Countdown({ until }: { until: string }) {
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
const draftOf = (action: ActionRecord) => (action.request.params as { draft?: DraftInput }).draft;
const recipients = (draft: DraftInput) => draft.to.map((p) => p.name ?? p.email).join(", ");

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
    held = action.status === "held";
  useEffect(() => {
    if (editing) {
      textarea.current?.focus();
    }
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
        ? "Approved. It waits in the outbox before sending."
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
      <Feedback error={task.error} />
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
              disabled={task.busy}
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
              disabled={task.busy || (editing && !body.trim())}
              onClick={approve}
            >
              <Icon name="check" size={14} />
              {task.busy ? "Saving…" : editing ? "Edit & approve" : "Approve"}
            </button>
            {draft && (
              <button
                className="btn btn-sm"
                data-action="edit"
                disabled={task.busy}
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
              disabled={task.busy}
              onClick={() =>
                task.run(() => api.reject(action.id), "Rejected. Passport learns from that.")
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

export function CancelButton({ action }: { action: ActionRecord }) {
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

function OutboxStrip({ held }: { held: ActionRecord[] }) {
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

function HandledToday({ accountId }: { accountId: string }) {
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

const reversibilityText: Record<string, string> = {
  reversible: "Can be undone",
  delayed: "Held in the outbox before it sends; cannot be unsent after",
  irreversible: "Cannot be undone",
};

/** Context for the selected proposal: why it asks, the source message, the matter, the people. */
export function ProposalDetails({ action }: { action?: ActionRecord }) {
  const draft = action && draftOf(action);
  const source = useResource<Email>(
    draft?.inReplyToEmailId ? `/emails/${encodeURIComponent(draft.inReplyToEmailId)}` : null,
  );
  const matter = useResource<MatterDetail>(
    action?.request.matterId ? `/matters/${encodeURIComponent(action.request.matterId)}` : null,
  );
  const trust = useResource<TrustData>("/trust"),
    { openSettings } = useUi();
  if (!action) {
    return (
      <p className="details-empty">
        Select a proposal to see the message it answers, its matter and why Passport is asking.
      </p>
    );
  }
  const state: TrustState | undefined = trust.data?.categories.find(
    (c) => c.category === action.request.category,
  );
  return (
    <div className="details-stack">
      <section>
        <h3>Why it’s asking</h3>
        <p>{action.decision.reason}</p>
        <dl className="facts compact">
          <dt>Category</dt>
          <dd>{categoryLabel(action.request.category)}</dd>
          <dt>Risk</dt>
          <dd className={`risk ${action.decision.risk}`}>
            {action.decision.risk[0]!.toUpperCase() + action.decision.risk.slice(1)}
          </dd>
          <dt>Undo</dt>
          <dd>{reversibilityText[action.decision.reversibility]}</dd>
          {state && (
            <>
              <dt>Trust</dt>
              <dd className="trust-line">
                <TrustLadder level={state.pinnedLevel ?? state.level} />
                {modeLabel(state.pinnedLevel ?? state.level)}
                <span className="muted">
                  {state.pinnedLevel ? "pinned" : `${Math.round(state.score * 100)}% earned`}
                </span>
              </dd>
            </>
          )}
        </dl>
        <button type="button" className="link-btn" onClick={() => openSettings("trust")}>
          Adjust trust for this category
        </button>
      </section>
      {source.data && (
        <section>
          <h3>In reply to</h3>
          <div className="source-mail">
            <div className="source-from">
              <strong>{source.data.from[0]?.name ?? source.data.from[0]?.email}</strong>
              <MailVerification email={source.data} />
            </div>
            <div className="source-subject">{source.data.subject}</div>
            <time className="muted" dateTime={source.data.receivedAt}>
              {new Date(source.data.receivedAt).toLocaleString(undefined, {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              })}
            </time>
            <p className="source-body">{source.data.textBody ?? source.data.preview}</p>
          </div>
        </section>
      )}
      {matter.data && (
        <section>
          <h3>Matter</h3>
          <Link className="matter-ref" to={`/matters/${matter.data.matter.id}`}>
            <strong>{matter.data.matter.title}</strong>
            <Icon name="next" size={14} />
          </Link>
          <p className="muted">{matter.data.matter.summary}</p>
          {matter.data.matter.nextStep && (
            <p className="next-step">
              <span className="muted">Next:</span> {matter.data.matter.nextStep}
            </p>
          )}
          {!!matter.data.people.length && (
            <ul className="people-mini">
              {matter.data.people.map((p) => (
                <li key={p.id}>
                  <Link to={`/people/${p.id}`}>
                    <Avatar name={p.displayName} small />
                    <span>{p.displayName}</span>
                  </Link>
                  <Verification person={p} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

type Grouping = "matter" | "newest";
/** Pure grouping so the queue order (and j/k order) is predictable and testable. */
export function groupProposals(
  proposed: ActionRecord[],
  grouping: Grouping,
): Array<[string, ActionRecord[]]> {
  if (grouping === "newest") {
    return [["newest", [...proposed].sort((a, b) => b.createdAt.localeCompare(a.createdAt))]];
  }
  const grouped = new Map<string, ActionRecord[]>();
  for (const action of proposed) {
    const key = action.request.matterId ?? "unassigned";
    grouped.set(key, [...(grouped.get(key) ?? []), action]);
  }
  const unassigned = grouped.get("unassigned");
  grouped.delete("unassigned");
  return [
    ...grouped,
    ...(unassigned ? [["unassigned", unassigned] as [string, ActionRecord[]]] : []),
  ];
}

/** j/k to move, a/r/e to decide on the selected proposal. */
function useQueueKeys(
  ordered: ActionRecord[],
  selected: string | undefined,
  select: (id: string) => void,
) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isTyping(event.target) ||
        document.querySelector('[aria-modal="true"]')
      ) {
        return;
      }
      if (!["j", "k", "a", "r", "e", "ArrowDown", "ArrowUp"].includes(event.key)) {
        return;
      }
      if (
        event.key.startsWith("Arrow") &&
        !(event.target as HTMLElement)?.closest?.("[data-decision]")
      ) {
        return;
      }
      event.preventDefault();
      const index = Math.max(
        0,
        ordered.findIndex((a) => a.id === selected),
      );
      if (["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
        const down = event.key === "j" || event.key === "ArrowDown";
        const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + (down ? 1 : -1)))];
        if (next) {
          select(next.id);
          const element = document.querySelector<HTMLElement>(
            `[data-decision="${CSS.escape(next.id)}"]`,
          );
          element?.focus({ preventScroll: true });
          element?.scrollIntoView?.({ block: "nearest" });
        }
      } else {
        document
          .querySelector<HTMLElement>(`[data-decision="${CSS.escape(selected ?? "")}"]`)
          ?.querySelector<HTMLButtonElement>(
            `[data-action="${{ a: "approve", r: "reject", e: "edit" }[event.key]}"]`,
          )
          ?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ordered, selected, select]);
}

/** The home surface: everything the agent needs a decision on, plus the composer. */
export function WorkQueue() {
  const accountId = useAccountId(),
    scope = useAccountScopeLink();
  const decisions = useResource<Page<ActionRecord>>(`/decisions${queryString({ accountId })}`),
    matters = useResource<Matter[]>(`/matters${queryString({ accountId })}`);
  const [selected, setSelected] = useState<string>(),
    [grouping, setGrouping] = useState<Grouping>("matter"),
    [fresh, setFresh] = useState<string[]>([]);
  const items = decisions.data?.items ?? [],
    proposed = items.filter((a) => a.status === "proposed"),
    held = items.filter((a) => a.status === "held");
  const groups = useMemo(
    () =>
      groupProposals(
        (decisions.data?.items ?? []).filter((a) => a.status === "proposed"),
        grouping,
      ),
    [decisions.data, grouping],
  );
  const ordered = useMemo(() => groups.flatMap(([, list]) => list), [groups]);
  useEffect(() => {
    if (!ordered.some((a) => a.id === selected)) {
      setSelected(ordered[0]?.id);
    }
  }, [ordered, selected]);
  useQueueKeys(ordered, selected, setSelected);
  const current = ordered.find((a) => a.id === selected);
  const matterTitle = (id: string) => matters.data?.find((m) => m.id === id)?.title ?? "Matter";
  return (
    <Surface
      title="Queue"
      details={<ProposalDetails action={current} />}
      detailsLabel="Proposal context"
      composer={
        <>
          <PromotionPrompts />
          <Composer
            showSuggestions={!!decisions.data && !proposed.length}
            context={
              current && draftOf(current)?.inReplyToEmailId
                ? {
                    emailId: draftOf(current)!.inReplyToEmailId!,
                    label: draftOf(current)!.subject,
                  }
                : undefined
            }
            onRun={(run) => {
              setFresh(run.actionIds);
              if (run.actionIds[0]) {
                setSelected(run.actionIds[0]);
              }
            }}
          />
        </>
      }
    >
      <div className="queue-head">
        <h1>
          {decisions.data
            ? proposed.length
              ? `${proposed.length} ${proposed.length === 1 ? "proposal needs" : "proposals need"} you`
              : "Nothing needs you"
            : "Queue"}
        </h1>
        {proposed.length > 1 && (
          <div className="segmented small" role="radiogroup" aria-label="Group proposals">
            {(["matter", "newest"] as Grouping[]).map((g) => (
              <button
                key={g}
                type="button"
                role="radio"
                aria-checked={grouping === g}
                onClick={() => setGrouping(g)}
              >
                {g === "matter" ? "By matter" : "Newest"}
              </button>
            ))}
          </div>
        )}
      </div>
      <Feedback error={decisions.error} />
      {decisions.loading && !decisions.data ? (
        <Loading />
      ) : (
        <>
          {held.length > 0 && <OutboxStrip held={held} />}
          {!proposed.length && (
            <Empty title="You’re clear for now.">
              New proposals land here as mail arrives. Ask Passport for something below, or press{" "}
              <Kbd>/</Kbd> to start typing.
            </Empty>
          )}
          {groups.map(([id, actions]) => (
            <section
              className="group"
              key={id}
              aria-label={
                id === "newest"
                  ? "Newest first"
                  : id === "unassigned"
                    ? "Not in a matter"
                    : matterTitle(id)
              }
            >
              {id !== "newest" && (
                <div className="group-head">
                  <h2>
                    {id === "unassigned" ? (
                      "Not in a matter"
                    ) : (
                      <Link to={scope(`/matters/${id}`)}>{matterTitle(id)}</Link>
                    )}
                  </h2>
                  <span className="count">{actions.length}</span>
                </div>
              )}
              {actions.map((action) => (
                <DecisionCard
                  key={action.id}
                  action={action}
                  selected={selected === action.id}
                  fresh={fresh.includes(action.id)}
                  onSelect={() => setSelected(action.id)}
                />
              ))}
            </section>
          ))}
          <HandledToday accountId={accountId} />
        </>
      )}
    </Surface>
  );
}
/** Kept for callers of the previous name. */
export const Decisions = WorkQueue;
