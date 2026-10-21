import type { Person } from "@passport/types";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { type PersonDetail, queryString } from "../api";
import {
  Avatar,
  Empty,
  Feedback,
  humanize,
  Icon,
  Loading,
  relativeTime,
  Verification,
} from "../components/ui";
import { Surface } from "../shell/Surface";
import { useResource } from "../state";

function DowngradeWarning({ person }: { person: Person }) {
  return person.lastSeenBlueAt && person.verification === "green" ? (
    <div className="warning" role="alert">
      <Icon name="alert" size={16} />
      <div>
        <strong>Verification changed for {person.displayName}.</strong>
        <p>
          Earlier messages were verified blue; the latest is green. Check with them through a
          channel you trust before sharing anything sensitive.
        </p>
      </div>
    </div>
  ) : null;
}

const relationships = ["", "known", "stranger", "service"];
const relationshipLabel: Record<string, string> = {
  "": "All",
  known: "Known",
  stranger: "New",
  service: "Services",
  self: "You",
};

export function People() {
  const [text, setText] = useState(""),
    [relationship, setRelationship] = useState(""),
    { data, error } = useResource<Person[]>(`/people${queryString({ text, relationship })}`);
  return (
    <Surface title="People" wide>
      <div className="list-head">
        <h1>People</h1>
        <span className="muted num">{data?.length ?? ""}</span>
      </div>
      <div className="toolbar">
        <label className="search-field">
          <Icon name="search" size={14} />
          <input
            aria-label="Search people"
            placeholder="Search by name or address"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="segmented small" role="radiogroup" aria-label="Relationship">
          {relationships.map((r) => (
            <button
              key={r || "all"}
              type="button"
              role="radio"
              aria-checked={relationship === r}
              onClick={() => setRelationship(r)}
            >
              {relationshipLabel[r]}
            </button>
          ))}
        </div>
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
            <Empty title="No one found." icon="people">
              Try another name or address.
            </Empty>
          ) : (
            <ul className="rows">
              {data.map((p) => (
                <li key={p.id}>
                  <Link to={`/people/${p.id}`} className="row person-row">
                    <Avatar name={p.displayName} small />
                    <span className="row-main">
                      <strong>{p.displayName}</strong>
                      <span className="muted">{p.notes ?? p.primaryEmail}</span>
                    </span>
                    <span className="row-meta">
                      <span className="muted">
                        {relationshipLabel[p.relationship] ?? humanize(p.relationship)}
                      </span>
                      <Verification person={p} />
                      <span className="muted num" title="Received and sent">
                        {p.stats.received} in, {p.stats.sent} out
                      </span>
                      <time className="muted">
                        {p.stats.lastContactAt ? relativeTime(p.stats.lastContactAt) : "No contact"}
                      </time>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="footnote">
            <Icon name="trust" size={14} />
            Verification comes from signatures and authentication headers. Message content never
            sets it.
          </p>
        </>
      )}
    </Surface>
  );
}

export function PersonPage() {
  const { id } = useParams(),
    { data, error } = useResource<PersonDetail>(`/people/${encodeURIComponent(id!)}`);
  if (!data) {
    return (
      <Surface title="Person" crumbs={[{ label: "People", to: "/people" }, { label: "…" }]}>
        <Feedback error={error} />
        {!error && <Loading />}
      </Surface>
    );
  }
  const { person } = data;
  return (
    <Surface
      title={person.displayName}
      crumbs={[{ label: "People", to: "/people" }, { label: person.displayName }]}
      detailsLabel="About"
      details={
        <div className="details-stack">
          <section>
            <h3>Notes</h3>
            <p>{person.notes ?? "No notes yet."}</p>
            <dl className="facts compact">
              <dt>Relationship</dt>
              <dd>{relationshipLabel[person.relationship] ?? humanize(person.relationship)}</dd>
              <dt>Addresses</dt>
              <dd>{person.emails.join(", ")}</dd>
              <dt>Received</dt>
              <dd className="num">{person.stats.received}</dd>
              <dt>Sent</dt>
              <dd className="num">{person.stats.sent}</dd>
            </dl>
          </section>
          <section>
            <h3>Shared matters</h3>
            {data.matters.length ? (
              <ul className="link-list">
                {data.matters.map((m) => (
                  <li key={m.id}>
                    <Link to={`/matters/${m.id}`}>
                      <span className={`matter-glyph ${m.status}`} aria-hidden="true" />
                      {m.title}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">None yet.</p>
            )}
          </section>
        </div>
      }
    >
      <header className="person-head">
        <Avatar name={person.displayName} />
        <div>
          <h1>{person.displayName}</h1>
          <p className="muted">{person.primaryEmail}</p>
        </div>
        <Verification person={person} />
      </header>
      <DowngradeWarning person={person} />
      <section className="group" aria-label="Recent correspondence">
        <div className="group-head">
          <h2>Recent correspondence</h2>
          <span className="count">{data.emails.items.length}</span>
        </div>
        <ol className="timeline">
          {data.emails.items.map((email) => (
            <li key={email.id}>
              <span className="timeline-icon">
                <Icon name={email.provenance === "sent" ? "send" : "mail"} size={13} />
              </span>
              <details>
                <summary>
                  <span className="timeline-title">{email.subject}</span>
                  <time className="muted" dateTime={email.receivedAt}>
                    {relativeTime(email.receivedAt)}
                  </time>
                </summary>
                <div className="timeline-body">
                  <p className="mail-text">{email.preview}</p>
                </div>
              </details>
            </li>
          ))}
        </ol>
      </section>
    </Surface>
  );
}
