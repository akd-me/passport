import type { ActionRecord, Matter, MatterStatus, Page } from "@passport/types";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { AccountDot, useAccountId, useAccountScopeLink } from "../accounts/AccountFilter";
import { api, type MatterDetail, queryString } from "../api";
import {
  Avatar,
  Empty,
  Feedback,
  humanize,
  Icon,
  Loading,
  MailVerification,
  relativeTime,
  Verification,
} from "../components/ui";
import { actionLabel } from "../labels";
import { Composer } from "../shell/Composer";
import { Surface } from "../shell/Surface";
import { useResource, useTask } from "../state";
import { DecisionCard } from "./Decisions";

const statuses: MatterStatus[] = ["active", "waiting", "snoozed", "done"];

export function Matters() {
  const accountId = useAccountId(),
    scope = useAccountScopeLink();
  const [text, setText] = useState(""),
    [status, setStatus] = useState("");
  const resource = useResource<Array<Matter & { accountIds?: string[] }>>(
    `/matters${queryString({ text, status, accountId })}`,
  );
  const decisions = useResource<Page<ActionRecord>>("/decisions");
  const pending = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of decisions.data?.items ?? [])
      if (a.status === "proposed" && a.request.matterId)
        map.set(a.request.matterId, (map.get(a.request.matterId) ?? 0) + 1);
    return map;
  }, [decisions.data]);
  return (
    <Surface title="Matters" wide>
      <div className="list-head">
        <h1>Matters</h1>
        <span className="muted num">{resource.data?.length ?? ""}</span>
      </div>
      <div className="toolbar">
        <label className="search-field">
          <Icon name="search" size={14} />
          <input
            aria-label="Search matters"
            placeholder="Search matters"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="segmented small" role="radiogroup" aria-label="Matter status">
          {["", ...statuses].map((s) => (
            <button
              key={s || "all"}
              type="button"
              role="radio"
              aria-checked={status === s}
              onClick={() => setStatus(s)}
            >
              {s ? humanize(s) : "All"}
            </button>
          ))}
        </div>
      </div>
      <Feedback error={resource.error} />
      {!resource.data ? (
        !resource.error && <Loading />
      ) : !resource.data.length ? (
        <Empty title="No matters match." icon="matters">
          Try another search or status.
        </Empty>
      ) : (
        <ul className="rows">
          {resource.data.map((matter) => (
            <li key={matter.id}>
              <Link to={scope(`/matters/${matter.id}`)} className="row matter-row">
                <span className={`matter-glyph ${matter.status}`} aria-hidden="true" />
                <span className="row-main">
                  <strong>{matter.title}</strong>
                  <span className="muted">{matter.nextStep ?? matter.summary}</span>
                </span>
                <span className="row-meta">
                  {!!pending.get(matter.id) && (
                    <span className="badge ink">{pending.get(matter.id)} for you</span>
                  )}
                  <span className={`status-text ${matter.status}`}>{humanize(matter.status)}</span>
                  <span className="dots">
                    {matter.accountIds?.map((id) => (
                      <AccountDot key={id} id={id} />
                    ))}
                  </span>
                  <time className="muted" dateTime={matter.updatedAt}>
                    {relativeTime(matter.updatedAt)}
                  </time>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}

interface TimelineItem {
  id: string;
  at: string;
  icon: string;
  who: string;
  title: string;
  body?: string | null;
  tag: string;
  deleted?: boolean;
  verification?: ReactNode;
}

function MatterContext({ data }: { data: MatterDetail }) {
  return (
    <div className="details-stack">
      <section>
        <h3>People</h3>
        {data.people.length ? (
          <ul className="people-mini">
            {data.people.map((p) => (
              <li key={p.id}>
                <Link to={`/people/${p.id}`}>
                  <Avatar name={p.displayName} small />
                  <span>
                    {p.displayName}
                    <small className="muted">{p.notes ?? p.primaryEmail}</small>
                  </span>
                </Link>
                <Verification person={p} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No one linked yet.</p>
        )}
      </section>
      {data.events.length > 0 && (
        <section>
          <h3>On the calendar</h3>
          <ul className="events-mini">
            {data.events.map((e) => (
              <li key={e.id}>
                <Icon name="calendar" size={14} />
                <span>
                  <strong>{e.title}</strong>
                  <small className="muted">
                    {new Date(e.start).toLocaleString(undefined, {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3>Facts</h3>
        <dl className="facts compact">
          <dt>Kind</dt>
          <dd>{data.matter.kind ? humanize(data.matter.kind) : "Not set"}</dd>
          <dt>Started</dt>
          <dd>{new Date(data.matter.createdAt).toLocaleDateString()}</dd>
          {data.matter.dueAt && (
            <>
              <dt>Due</dt>
              <dd>{new Date(data.matter.dueAt).toLocaleDateString()}</dd>
            </>
          )}
          {data.matter.snoozedUntil && (
            <>
              <dt>Snoozed until</dt>
              <dd>{new Date(data.matter.snoozedUntil).toLocaleDateString()}</dd>
            </>
          )}
          <dt>Messages</dt>
          <dd className="num">{data.emails.items.length}</dd>
        </dl>
      </section>
    </div>
  );
}

export function MatterPage() {
  const { id } = useParams(),
    { data, error } = useResource<MatterDetail>(`/matters/${encodeURIComponent(id!)}`),
    decisions = useResource<Page<ActionRecord>>("/decisions"),
    task = useTask(),
    [selected, setSelected] = useState<string>(),
    [fresh, setFresh] = useState<string[]>([]);
  const timeline = useMemo<TimelineItem[]>(
    () =>
      data
        ? [
            ...data.emails.items.map((e) => ({
              id: `email-${e.id}`,
              at: e.receivedAt,
              icon: e.provenance === "sent" ? "send" : "mail",
              who: e.from[0]?.name ?? e.from[0]?.email ?? "Email",
              title: e.subject,
              body: e.textBody ?? e.preview,
              tag: e.provenance === "sent" ? "Sent" : "Received",
              deleted: !!e.keywords["$deleted" as keyof typeof e.keywords],
              verification: <MailVerification email={e} />,
            })),
            ...data.events.map((e) => ({
              id: `event-${e.id}`,
              at: e.start,
              icon: "calendar",
              who: new Date(e.start).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }),
              title: e.title,
              body: e.description ?? e.location ?? null,
              tag: "Event",
            })),
            ...data.actions.items
              .filter((a) => a.status !== "proposed")
              .map((a) => ({
                id: `action-${a.id}`,
                at: a.executedAt ?? a.createdAt,
                icon: a.request.actor.kind === "human" ? "check" : "sparkle",
                who: a.request.actor.kind === "human" ? "You" : "Passport",
                title: `${actionLabel(a.request.type)}: ${a.request.reason}`,
                body: a.decision.reason,
                tag: humanize(a.status),
              })),
          ].sort((a, b) => b.at.localeCompare(a.at))
        : [],
    [data],
  );
  if (!data)
    return (
      <Surface title="Matter" crumbs={[{ label: "Matters", to: "/matters" }, { label: "…" }]}>
        <Feedback error={error} />
        {!error && <Loading />}
      </Surface>
    );
  const pending = (decisions.data?.items ?? []).filter(
    (a) => a.request.matterId === data.matter.id && a.status === "proposed",
  );
  const current = pending.find((a) => a.id === selected)?.id ?? pending[0]?.id;
  return (
    <Surface
      title={data.matter.title}
      crumbs={[{ label: "Matters", to: "/matters" }, { label: data.matter.title }]}
      details={<MatterContext data={data} />}
      detailsLabel="Matter context"
      actions={
        <select
          className="select-sm"
          aria-label="Matter status"
          value={data.matter.status}
          disabled={task.busy}
          onChange={(e) =>
            task.run(
              () => api.updateMatter(data.matter.id, { status: e.target.value as MatterStatus }),
              "Matter updated. The change is in your activity.",
            )
          }
        >
          {statuses.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
      }
      composer={
        <Composer
          matterId={data.matter.id}
          matterTitle={data.matter.title}
          onRun={(run) => setFresh(run.actionIds)}
        />
      }
    >
      <header className="matter-head">
        <h1>{data.matter.title}</h1>
        <p className="matter-summary">{data.matter.summary}</p>
        <div className="next-step-line">
          <Icon name="arrow" size={14} />
          <span>
            <span className="muted">Next step </span>
            {data.matter.nextStep ?? "Nothing waiting on you."}
          </span>
        </div>
      </header>
      <Feedback error={task.error} />
      {pending.length > 0 && (
        <section className="group" aria-label="Waiting for you">
          <div className="group-head">
            <h2>Waiting for you</h2>
            <span className="count">{pending.length}</span>
          </div>
          {pending.map((a) => (
            <DecisionCard
              key={a.id}
              action={a}
              selected={current === a.id}
              fresh={fresh.includes(a.id)}
              onSelect={() => setSelected(a.id)}
            />
          ))}
        </section>
      )}
      <section className="group" aria-label="History">
        <div className="group-head">
          <h2>History</h2>
        </div>
        <ol className="timeline">
          {timeline.map((item) => (
            <li key={item.id} className={item.deleted ? "deleted" : ""}>
              <span className="timeline-icon">
                <Icon name={item.icon} size={13} />
              </span>
              <details>
                <summary>
                  <span className="timeline-who">{item.who}</span>
                  <span className="timeline-title">{item.title}</span>
                  <time className="muted" dateTime={item.at}>
                    {relativeTime(item.at)}
                  </time>
                </summary>
                <div className="timeline-body">
                  <div className="timeline-tags">
                    <span className="badge">{item.tag}</span>
                    {item.deleted && <span className="badge warn">Deleted at the provider</span>}
                    {item.verification}
                  </div>
                  {item.body && (
                    <p className={item.icon === "mail" || item.icon === "send" ? "mail-text" : ""}>
                      {item.body}
                    </p>
                  )}
                </div>
              </details>
            </li>
          ))}
        </ol>
      </section>
    </Surface>
  );
}
