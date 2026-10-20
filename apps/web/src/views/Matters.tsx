import { useState } from "react";
import { Link, useParams } from "react-router";
import type { Matter, MatterStatus } from "@passport/types";
import { api, queryString, type MatterDetail } from "../api";
import { useResource, useTask } from "../state";
import { AccountDot, useAccountId } from "../accounts/AccountFilter";
import {
  Avatar,
  Badge,
  Empty,
  Feedback,
  humanize,
  Icon,
  Loading,
  PageHeader,
  relativeTime,
  Verification,
} from "../components/ui";
export function Matters() {
  const accountId = useAccountId();
  const [text, setText] = useState(""),
    [status, setStatus] = useState("");
  const resource = useResource<Array<Matter & { accountIds?: string[] }>>(
    `/matters${queryString({ text, status, accountId })}`,
  );
  return (
    <>
      <PageHeader
        eyebrow="THE BIGGER PICTURE"
        title="Keep the thread of what matters."
        description="Living workspaces for the projects, plans, and people in your life."
      />
      <div className="filter-bar">
        <label className="search-field">
          <Icon name="search" size={18} />
          <input
            aria-label="Search matters"
            placeholder="Find a matter…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <select
          aria-label="Matter status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          {["active", "waiting", "snoozed", "done"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="subtle">{resource.data?.length ?? "—"} matters</span>
      </div>
      <Feedback error={resource.error} />
      {!resource.data ? (
        !resource.error && <Loading />
      ) : !resource.data.length ? (
        <Empty title="Nothing here just yet.">
          Try a different search or status.
        </Empty>
      ) : (
        <div className="matter-grid">
          {resource.data.map((matter, i) => (
            <Link
              to={`/matters/${matter.id}${queryString({ accountId })}`}
              className="matter-tile"
              key={matter.id}
            >
              <div className="matter-tile-top">
                <span>
                  {matter.accountIds?.map((id) => (
                    <AccountDot key={id} id={id} />
                  ))}
                </span>
                <span className={`matter-symbol color-${i % 4}`}>
                  <Icon name="matters" size={23} />
                </span>
                <Badge
                  tone={
                    matter.status === "active"
                      ? "green"
                      : matter.status === "waiting"
                        ? "amber"
                        : ""
                  }
                >
                  {humanize(matter.status)}
                </Badge>
              </div>
              <span className="eyebrow">{matter.kind ?? "MATTER"}</span>
              <h2>{matter.title}</h2>
              <p>{matter.summary}</p>
              {matter.nextStep && (
                <div className="next-step">
                  <Icon name="arrow" size={16} />
                  <span>{matter.nextStep}</span>
                </div>
              )}
              <div className="tile-footer">
                <span>
                  {matter.emailIds.length} emails · {matter.personIds.length}{" "}
                  people
                </span>
                <Icon name="arrow" size={17} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
export function MatterPage() {
  const { id } = useParams(),
    { data, error } = useResource<MatterDetail>(
      `/matters/${encodeURIComponent(id!)}`,
    ),
    task = useTask();
  if (!data)
    return (
      <>
        <Link className="back-link" to="/matters">
          ← All matters
        </Link>
        <Feedback error={error} />
        {!error && <Loading />}
      </>
    );
  const timeline = [
    ...data.emails.items.map((e) => ({
      id: `email-${e.id}`,
      at: e.receivedAt,
      icon: "accounts",
      label: e.from[0]?.name ?? e.from[0]?.email ?? "Email",
      title: e.subject,
      body: e.textBody ?? e.preview,
      badge: "Email",
    })),
    ...data.events.map((e) => ({
      id: `event-${e.id}`,
      at: e.start,
      icon: "clock",
      label: new Date(e.start).toLocaleString(),
      title: e.title,
      body: e.description ?? e.location ?? "Scheduled event",
      badge: "Calendar",
    })),
    ...data.actions.items.map((a) => ({
      id: `action-${a.id}`,
      at: a.executedAt ?? a.createdAt,
      icon: "sparkle",
      label: a.request.actor.kind === "human" ? "You" : "Passport",
      title: a.request.reason,
      body: a.decision.reason,
      badge: humanize(a.status),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <>
      <Link className="back-link" to="/matters">
        ← All matters
      </Link>
      <PageHeader
        eyebrow={data.matter.kind ?? "MATTER"}
        title={data.matter.title}
        description="Everything in context. A clear next step."
      >
        <select
          aria-label="Matter status"
          value={data.matter.status}
          disabled={task.busy}
          onChange={(e) =>
            task.run(
              () =>
                api.updateMatter(data.matter.id, {
                  status: e.target.value as MatterStatus,
                }),
              "Matter updated and recorded in your activity.",
            )
          }
        >
          {["active", "waiting", "snoozed", "done"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </PageHeader>
      <Feedback error={task.error} />
      <div className="detail-layout">
        <div>
          <section className="panel matter-summary">
            <div className="eyebrow">WHERE THINGS STAND</div>
            <p>{data.matter.summary}</p>
            <div className="next-step">
              <Icon name="arrow" />
              <div>
                <strong>Next step</strong>
                <p>{data.matter.nextStep ?? "Nothing waiting on you."}</p>
              </div>
            </div>
          </section>
          <div className="section-heading">
            <h2>The story so far</h2>
            <span className="subtle">Emails, events, and actions</span>
          </div>
          <div className="timeline">
            {timeline.map((item) => (
              <article className="timeline-item" key={item.id}>
                <span className="timeline-icon">
                  <Icon name={item.icon} size={17} />
                </span>
                <div className="timeline-content">
                  <div className="card-topline">
                    <span>{item.label}</span>
                    <span className="subtle">
                      {relativeTime(item.at)} <Badge>{item.badge}</Badge>
                    </span>
                  </div>
                  <details>
                    <summary>{item.title}</summary>
                    <p className="preserve-lines">{item.body}</p>
                  </details>
                </div>
              </article>
            ))}
          </div>
        </div>
        <aside>
          <section className="rail-card">
            <h2>People in this matter</h2>
            {data.people.map((p) => (
              <Link
                to={`/people/${p.id}`}
                className="person-compact"
                key={p.id}
              >
                <Avatar name={p.displayName} small />
                <span>
                  <strong>{p.displayName}</strong>
                  <small>{p.notes ?? p.relationship}</small>
                </span>
                <Verification person={p} />
              </Link>
            ))}
          </section>
          {data.events.length > 0 && (
            <section className="rail-card">
              <h2>On the calendar</h2>
              {data.events.map((e) => (
                <div className="calendar-item" key={e.id}>
                  <Icon name="clock" size={17} />
                  <div>
                    <strong>{e.title}</strong>
                    <p>
                      {new Date(e.start).toLocaleDateString(undefined, {
                        month: "long",
                        day: "numeric",
                      })}{" "}
                      ·{" "}
                      {new Date(e.start).toLocaleTimeString(undefined, {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              ))}
            </section>
          )}
        </aside>
      </div>
    </>
  );
}
