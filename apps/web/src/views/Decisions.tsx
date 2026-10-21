import type { ActionRecord, Matter, Page } from "@passport/types";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useAccountId, useAccountScopeLink } from "../accounts/AccountFilter";
import { queryString } from "../api";
import { Empty, Feedback, Kbd, Loading } from "../components/ui";
import { Composer } from "../shell/Composer";
import { Surface } from "../shell/Surface";
import { useResource } from "../state";
import { DecisionCard, HandledToday, OutboxStrip } from "./DecisionCard";
import { draftOf, type Grouping, groupProposals, useQueueKeys } from "./decision-model";
import { ProposalDetails } from "./ProposalDetails";
import { PromotionPrompts } from "./Trust";

export { DecisionCard, UndoButton } from "./DecisionCard";
export { groupProposals } from "./decision-model";

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
/** @compatibility Retain the former view name for existing imports. */
export const Decisions = WorkQueue;
