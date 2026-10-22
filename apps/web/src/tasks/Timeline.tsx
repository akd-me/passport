import type { ActionRecord, Task, TaskItem, TaskRun } from "@passport/types";
import { useEffect, useMemo, useRef } from "react";
import { Feedback, Loading } from "../components/ui";
import { ApprovalItem } from "./ApprovalItem";
import type { LoadState } from "./actions-store";
import { RunHeader } from "./RunHeader";
import { TimelineItem } from "./TimelineItems";
import { ToolGroup } from "./ToolGroup";
import { buildTimeline } from "./timeline-model";

/** Keep the newest item in view while the reader is already at the bottom. */
function useStickToBottom(count: number) {
  const end = useRef<HTMLDivElement>(null),
    seen = useRef(0);
  useEffect(() => {
    const scroller = end.current?.closest(".surface-scroll");
    if (!scroller || count === seen.current) {
      return;
    }
    const first = seen.current === 0;
    seen.current = count;
    const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
    if (first || near) {
      end.current?.scrollIntoView?.({ block: "end" });
    }
  }, [count]);
  return end;
}

/** Pages older items in when the top of the timeline scrolls into view, or on click. */
function Older({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
  const ref = useRef<HTMLDivElement>(null),
    latest = useRef(onLoad);
  latest.current = onLoad;
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        latest.current();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="timeline-older" ref={ref}>
      <button type="button" className="link-btn" disabled={loading} onClick={onLoad}>
        {loading ? "Loading earlier items…" : "Show earlier items"}
      </button>
    </div>
  );
}

export function Timeline({
  task,
  items,
  runs,
  records,
  pending,
  onRetry,
  loaded,
  error,
  older = false,
  loadingOlder = false,
  onOlder,
  selected,
  onSelect,
}: {
  task: Task;
  items: TaskItem[];
  runs: TaskRun[];
  records: Map<string, ActionRecord>;
  /** The open decisions' request, for approvals whose record has not loaded. */
  pending: LoadState | "idle";
  onRetry: () => void;
  loaded: boolean;
  error?: string;
  /** Earlier items exist (the timeline opened at its newest page). */
  older?: boolean;
  loadingOlder?: boolean;
  onOlder?: () => void;
  selected?: string;
  onSelect: (actionId: string) => void;
}) {
  const since = older ? items[0]?.at : undefined;
  const entries = useMemo(() => buildTimeline(items, runs, since), [items, runs, since]);
  const end = useStickToBottom(entries.length);
  if (!loaded) {
    return <Loading label="Loading the timeline…" />;
  }
  return (
    <>
      <Feedback error={error} />
      {older && onOlder && <Older loading={loadingOlder} onLoad={onOlder} />}
      {/* The log wraps the list so the entries keep list semantics (R5-17). */}
      <div role="log" aria-label="Timeline" aria-live="polite">
        <ol className="task-timeline">
          {entries.map((entry) => (
            <li key={entry.key} className={`tl-entry tl-${entry.kind}`}>
              {entry.kind === "run" ? (
                <RunHeader run={entry.run} />
              ) : entry.kind === "tools" ? (
                <ToolGroup calls={entry.calls} />
              ) : entry.item.kind === "approval_request" ? (
                <ApprovalItem
                  item={entry.item}
                  task={task}
                  record={records.get(entry.item.payload.actionId)}
                  load={pending}
                  onRetry={onRetry}
                  selected={selected === entry.item.payload.actionId}
                  onSelect={() =>
                    entry.item.kind === "approval_request" && onSelect(entry.item.payload.actionId)
                  }
                />
              ) : (
                <TimelineItem item={entry.item} />
              )}
            </li>
          ))}
          {!entries.length && <li className="tl-empty muted">Nothing has happened yet.</li>}
        </ol>
      </div>
      <div ref={end} />
    </>
  );
}
