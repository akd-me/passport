import type { ActionRecord, Matter, Page } from "@passport/types";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAccountId, useAccountScopeLink } from "../accounts/AccountFilter";
import { queryString } from "../api";
import { Empty, Feedback, Kbd, Loading } from "../components/ui";
import { Composer } from "../shell/Composer";
import { Surface } from "../shell/Surface";
import { useResource } from "../state";
import { useUi } from "../ui-state";
import { DecisionCard, HandledToday, OutboxStrip } from "./DecisionCard";
import { draftOf, type Grouping, groupProposals, useQueueKeys } from "./decision-model";
import { ProposalDetails } from "./ProposalDetails";
import { TasksNeedingYou, useTasksNeedingYou } from "./TasksNeedingYou";
import { PromotionPrompts } from "./Trust";

export { DecisionCard, UndoButton } from "./DecisionCard";
export { groupProposals } from "./decision-model";

/**
 * "Needs you": tasks waiting on the person, then every open proposal across tasks (the v0.2
 * queue), plus the composer.
 */
export function WorkQueue() {
  const accountId = useAccountId(),
    scope = useAccountScopeLink();
  const decisions = useResource<Page<ActionRecord>>(`/decisions${queryString({ accountId })}`),
    matters = useResource<Matter[]>(`/matters${queryString({ accountId })}`);
  const [params] = useSearchParams(),
    deepLink = params.get("decision") ?? undefined;
  const ui = useUi(),
    waiting = useTasksNeedingYou();
  const [selected, setSelected] = useState<string | undefined>(deepLink),
    [grouping, setGrouping] = useState<Grouping>("matter");
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
    if (deepLink && ordered.some((a) => a.id === deepLink)) {
      setSelected(deepLink);
      document
        .querySelector(`[data-decision="${CSS.escape(deepLink)}"]`)
        ?.scrollIntoView?.({ block: "center" });
    }
  }, [deepLink, ordered]);
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
      title="Needs you"
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
          />
        </>
      }
    >
      <div className="queue-head">
        {/* The page names itself; each group below carries its own count (R2-28). */}
        <h1>Needs you</h1>
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
      <TasksNeedingYou />
      <Feedback error={decisions.error} />
      {decisions.loading && !decisions.data ? (
        <Loading />
      ) : (
        <>
          {held.length > 0 && <OutboxStrip held={held} />}
          {!proposed.length && !waiting.length && (
            <Empty title="Nothing needs you right now.">
              <button type="button" className="btn btn-sm" onClick={ui.focusComposer}>
                Ask Passport something <Kbd>/</Kbd>
              </button>
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
              <div className="group-head">
                <h2>
                  {id === "newest" ? (
                    "Proposals"
                  ) : id === "unassigned" ? (
                    "Not in a matter"
                  ) : (
                    <Link to={scope(`/matters/${id}`)}>{matterTitle(id)}</Link>
                  )}
                </h2>
                <span className="count">{actions.length}</span>
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
          <HandledToday accountId={accountId} />
        </>
      )}
    </Surface>
  );
}

/** Kept for callers of the previous name. */
/** @compatibility Retain the former view name for existing imports. */
export const Decisions = WorkQueue;
