import type { Task } from "@passport/types";
import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { Icon, mod, relativeTime } from "../components/ui";
import {
  groupTasks,
  isFresh,
  jumpOrder,
  kindLabel,
  returnedOf,
  SECTIONS,
  type SectionId,
  taskState,
} from "../tasks/model";
import { useTasks } from "../tasks/store";
import { StateGlyph } from "../tasks/TaskGlyph";
import { TaskMenu } from "../tasks/TaskMenu";
import { isTyping } from "../ui-state";

/**
 * j/k move between task rows, Enter opens the focused one. The list in the main column wins over
 * the sidebar; the decisions queue keeps its own j/k. Mounted by the shell, so it works with the
 * sidebar hidden (R5-10).
 */
export function useTaskListKeys() {
  const { pathname } = useLocation();
  const queue = pathname === "/needs-you";
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.key !== "j" && event.key !== "k") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target) ||
        document.querySelector('[aria-modal="true"]') ||
        // Only the queue moves between decision cards; a card in a task timeline does not.
        (queue && document.querySelector("main [data-decision]"))
      ) {
        return;
      }
      const inMain = [...document.querySelectorAll<HTMLElement>("main [data-task-row]")];
      const rows = inMain.length
        ? inMain
        : [...document.querySelectorAll<HTMLElement>("[data-task-row]")];
      if (!rows.length) {
        return;
      }
      event.preventDefault();
      const focused = rows.indexOf(document.activeElement as HTMLElement);
      const at = focused >= 0 ? focused : rows.findIndex((r) => r.getAttribute("aria-current"));
      const next =
        at < 0
          ? event.key === "j"
            ? 0
            : rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, at + (event.key === "j" ? 1 : -1)));
      rows[next]?.focus();
      rows[next]?.scrollIntoView?.({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [queue]);
}

/** "Wakes in 20h", or "Wakes soon" once the time has passed and the server has not caught up. */
export function wakeText(until: string, now = Date.now()) {
  return Date.parse(until) - now < 60_000 ? "Wakes soon" : `Wakes ${relativeTime(until)}`;
}

/** ⌘1–⌘9 (Ctrl elsewhere) open the first nine tasks in sidebar order, sidebar shown or not. */
export function useTaskJumpKeys() {
  const { tasks } = useTasks(),
    navigate = useNavigate();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;
      if (
        !command ||
        event.altKey ||
        event.shiftKey ||
        !/^[1-9]$/.test(event.key) ||
        document.querySelector('[aria-modal="true"]')
      ) {
        return;
      }
      const target = jumpOrder(tasks)[Number(event.key) - 1];
      if (target) {
        event.preventDefault();
        navigate(`/tasks/${encodeURIComponent(target.id)}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tasks, navigate]);
}

export function TaskRow({
  task,
  running,
  shortcut,
}: {
  task: Task;
  running: boolean;
  /** 1–9 when ⌘N opens this row. */
  shortcut?: number;
}) {
  const pending = task.pendingActionIds?.length ?? 0,
    kind = kindLabel(task),
    state = taskState(task, running);
  const forward = isFresh(task) || state === "working";
  return (
    <li className="task-row">
      <NavLink
        to={`/tasks/${encodeURIComponent(task.id)}`}
        data-task-row={task.id}
        aria-keyshortcuts={shortcut ? `Meta+${shortcut} Control+${shortcut}` : undefined}
        title={shortcut ? `${task.title} (${mod}${shortcut})` : undefined}
        className={({ isActive }) =>
          `side-row task-link ${isActive ? "active" : ""} ${forward ? "fresh" : "recede"}`
        }
      >
        <StateGlyph state={state} />
        <span className="side-label">
          <span className="task-title">{task.title}</span>
          {kind && <span className={`kind-badge ${task.kind}`}>{kind}</span>}
        </span>
        <span className="task-trail">
          {pending > 0 ? (
            <span className="side-count strong" title={`${pending} waiting for approval`}>
              {pending}
              <span className="sr-only"> waiting for approval</span>
            </span>
          ) : (
            <time dateTime={task.snoozedUntil ?? returnedOf(task)}>
              {task.status === "snoozed" && task.snoozedUntil
                ? wakeText(task.snoozedUntil)
                : relativeTime(returnedOf(task))}
            </time>
          )}
        </span>
      </NavLink>
      <TaskMenu task={task} />
    </li>
  );
}

function Section({
  id,
  label,
  tasks,
  running,
  shortcuts,
}: {
  id: SectionId;
  label: string;
  tasks: Task[];
  running: (id: string) => boolean;
  shortcuts: Map<string, number>;
}) {
  const [open, setOpen] = useState(id !== "settled"),
    { settled, loadSettled } = useTasks();
  // Settled tasks page in when the fold opens (R5-3).
  const lazy = id === "settled";
  useEffect(() => {
    if (lazy && open && !settled.loaded && !settled.loading) {
      loadSettled();
    }
  }, [lazy, open, settled.loaded, settled.loading, loadSettled]);
  if (!tasks.length && id !== "inbox" && !(lazy && !settled.loaded)) {
    return null;
  }
  return (
    <section className="side-group task-section" aria-label={label}>
      <div className="side-group-head">
        <h2>
          <button
            type="button"
            className="section-toggle"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Icon name={open ? "chevron" : "next"} size={12} />
            {label}
          </button>
        </h2>
        <span className="side-count">
          {tasks.length ? `${tasks.length}${lazy && settled.more ? "+" : ""}` : ""}
        </span>
      </div>
      {open && (
        <ul>
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              running={running(task.id)}
              shortcut={shortcuts.get(task.id)}
            />
          ))}
          {!tasks.length && !lazy && <li className="side-empty">Nothing has come back to you.</li>}
          {lazy && settled.loading && <li className="side-empty">Loading…</li>}
          {lazy && settled.more && !settled.loading && (
            <li>
              <button type="button" className="link-btn side-more" onClick={loadSettled}>
                Show more
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

/** Pinned, Inbox (came back to you), Working, Snoozed, Settled (collapsed). */
export function TaskList() {
  const { tasks, running, loaded, available, error } = useTasks();
  if (!available) {
    return (
      <p className="side-empty side-note">
        Tasks need the full backend (<code>passport serve</code>). The demo shows the queue.
      </p>
    );
  }
  if (loaded && error && !tasks.length) {
    return <p className="side-empty side-note">Tasks could not load. {error}</p>;
  }
  const groups = groupTasks(tasks),
    shortcuts = new Map(jumpOrder(tasks).map((task, i) => [task.id, i + 1]));
  return (
    <>
      {SECTIONS.map((section) => (
        <Section
          key={section.id}
          id={section.id}
          label={section.label}
          tasks={groups[section.id]}
          running={running}
          shortcuts={shortcuts}
        />
      ))}
    </>
  );
}
