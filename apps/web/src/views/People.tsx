import { useState } from "react";
import { Link, useParams } from "react-router";
import type { Person } from "@passport/types";
import { queryString, type PersonDetail } from "../api";
import { useResource } from "../state";
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
export function DowngradeWarning({ person }: { person: Person }) {
  return person.lastSeenBlueAt && person.verification === "green" ? (
    <div className="warning-banner" role="alert">
      <Icon name="trust" size={20} />
      <div>
        <strong>Verification changed for {person.displayName}.</strong>
        <p>
          Previously verified blue. Their latest message is green. Check with
          them through a known channel before sharing sensitive information.
        </p>
      </div>
    </div>
  ) : null;
}
export function People() {
  const [text, setText] = useState(""),
    { data, error } = useResource<Person[]>(`/people${queryString({ text })}`);
  return (
    <>
      <PageHeader
        eyebrow="FAMILIAR FACES, CLEARER CONTEXT"
        title="It starts with people."
        description="The relationships behind the messages, with identity you can see."
      />
      <div className="filter-bar">
        <label className="search-field">
          <Icon name="search" size={18} />
          <input
            aria-label="Search people"
            placeholder="Find a person…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <span className="subtle">{data?.length ?? "—"} people</span>
      </div>
      <Feedback error={error} />
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          {data
            .filter((p) => p.lastSeenBlueAt && p.verification === "green")
            .map((p) => (
              <DowngradeWarning key={p.id} person={p} />
            ))}
          {!data.length ? (
            <Empty title="No one found.">
              Try another name or email address.
            </Empty>
          ) : (
            <div className="people-grid">
              {data.map((p) => (
                <Link to={`/people/${p.id}`} className="person-tile" key={p.id}>
                  <div className="person-tile-top">
                    <Avatar name={p.displayName} />
                    <Verification person={p} />
                  </div>
                  <h2>{p.displayName}</h2>
                  <p className="person-email">{p.primaryEmail}</p>
                  <Badge>{humanize(p.relationship)}</Badge>
                  <p className="person-note">
                    {p.notes ?? "A new connection in your workspace."}
                  </p>
                  <div className="tile-footer">
                    <span>
                      {p.stats.received} received · {p.stats.sent} sent
                    </span>
                    <span>
                      {p.stats.lastContactAt
                        ? relativeTime(p.stats.lastContactAt)
                        : "No contact yet"}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
          <p className="identity-note">
            <Icon name="trust" size={16} />
            Verification comes from signatures and authentication headers.
            Message content never determines a badge.
          </p>
        </>
      )}
    </>
  );
}
export function PersonPage() {
  const { id } = useParams(),
    { data, error } = useResource<PersonDetail>(
      `/people/${encodeURIComponent(id!)}`,
    );
  if (!data)
    return (
      <>
        <Feedback error={error} />
        {!error && <Loading />}
      </>
    );
  return (
    <>
      <Link to="/people" className="back-link">
        ← All people
      </Link>
      <PageHeader
        eyebrow={humanize(data.person.relationship)}
        title={data.person.displayName}
        description={data.person.primaryEmail}
      >
        <Verification person={data.person} />
      </PageHeader>
      <DowngradeWarning person={data.person} />
      <div className="detail-layout">
        <section className="panel">
          <h2>Recent correspondence</h2>
          {data.emails.items.map((email) => (
            <details className="correspondence" key={email.id}>
              <summary>
                <strong>{email.subject}</strong>
                <span className="subtle">{relativeTime(email.receivedAt)}</span>
              </summary>
              <p>{email.preview}</p>
            </details>
          ))}
        </section>
        <aside>
          <section className="rail-card">
            <h2>Relationship notes</h2>
            <p>{data.person.notes ?? "No notes yet."}</p>
            <Badge>{humanize(data.person.relationship)}</Badge>
          </section>
          <section className="rail-card">
            <h2>Shared matters</h2>
            {data.matters.map((m) => (
              <Link to={`/matters/${m.id}`} className="matter-link" key={m.id}>
                {m.title}
                <Icon name="arrow" size={16} />
              </Link>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}
