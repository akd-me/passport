import type { ActionRecord, Email, TrustState } from "@passport/types";
import { Link } from "react-router";
import type { MatterDetail, TrustData } from "../api";
import { Avatar, Icon, MailVerification, Verification } from "../components/ui";
import { categoryLabel } from "../labels";
import { useResource } from "../state";
import { useUi } from "../ui-state";
import { draftOf } from "./decision-model";
import { modeLabel, TrustLadder } from "./Trust";

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
