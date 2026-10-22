import type { ActionRecord, Task, TaskItem, TaskRun } from "@passport/types";
import { useEffect, useMemo, useRef } from "react";
import { Feedback, Loading } from "../components/ui";
import { ApprovalItem } from "./ApprovalItem";
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

export function Timeline({
  task,
  items,
  runs,
  records,
  loaded,
  error,
  selected,
  onSelect,
}: {
  task: Task;
  items: TaskItem[];
  runs: TaskRun[];
  records: Map<string, ActionRecord>;
  loaded: boolean;
  error?: string;
  selected?: string;
  onSelect: (actionId: string) => void;
}) {
  const entries = useMemo(() => buildTimeline(items, runs), [items, runs]);
  const end = useStickToBottom(entries.length);
  if (!loaded) {
    return <Loading label="Loading the timeline…" />;
  }
  return (
    <>
      <Feedback error={error} />
      <ol className="timeline" aria-label="Timeline" role="log" aria-live="polite">
        {entries.map((entry) => (
          <li key={entry.key} className={`tl-entry tl-${entry.kind}`}>
            {entry.kind === "run" ? (
              <RunHeader run={entry.run} records={records} />
            ) : entry.kind === "tools" ? (
              <ToolGroup calls={entry.calls} />
            ) : entry.item.kind === "approval_request" ? (
              <ApprovalItem
                item={entry.item}
                task={task}
                record={records.get(entry.item.payload.actionId)}
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
      <div ref={end} />
    </>
  );
}
