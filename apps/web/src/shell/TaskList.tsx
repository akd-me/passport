import type { Task } from "@passport/types";
import { useEffect, useState } from "react";
import { NavLink } from "react-router";
import { AccountDot } from "../accounts/AccountFilter";
import { Icon, relativeTime } from "../components/ui";
import { groupTasks, kindLabel, SECTIONS, type SectionId } from "../tasks/model";
import { useTasks } from "../tasks/store";
import { TaskGlyph } from "../tasks/TaskGlyph";
import { TaskMenu } from "../tasks/TaskMenu";
import { isTyping } from "../ui-state";

/**
 * j/k move between task rows, Enter opens the focused one. The list in the main column wins over
 * the sidebar; the decisions queue keeps its own j/k.
 */
export function useTaskListKeys() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        (event.key !== "j" && event.key !== "k") ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isTyping(event.target) ||
        document.querySelector('[aria-modal="true"], [data-decision]')
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
  }, []);
}

export function TaskRow({ task, running }: { task: Task; running: boolean }) {
  const pending = task.pendingActionIds?.length ?? 0,
    kind = kindLabel(task);
  return (
    <li className="task-row">
      <NavLink
        to={`/tasks/${encodeURIComponent(task.id)}`}
        data-task-row={task.id}
        className={({ isActive }) =>
          `side-row task-link ${isActive ? "active" : ""} ${task.needsUser ? "needs-you" : ""}`
        }
      >
        <TaskGlyph task={task} running={running} />
        <span className="side-label">
          {task.title}
          <small>
            {kind && <span className={`kind-badge ${task.kind}`}>{kind}</span>}
            {task.accountIds.slice(0, 3).map((id) => (
              <AccountDot key={id} id={id} />
            ))}
            <span>
              {task.status === "snoozed" && task.snoozedUntil
                ? `Until ${relativeTime(task.snoozedUntil).replace(/^in /, "")}`
                : relativeTime(task.lastActivityAt)}
            </span>
          </small>
        </span>
        {pending > 0 && (
          <span
            className="side-count strong"
            aria-label={`${pending} waiting for approval`}
            title={`${pending} waiting for approval`}
          >
            {pending}
          </span>
        )}
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
}: {
  id: SectionId;
  label: string;
  tasks: Task[];
  running: (id: string) => boolean;
}) {
  const [open, setOpen] = useState(id !== "settled");
  if (!tasks.length && id !== "inbox") {
    return null;
  }
  return (
    <section className="side-group task-section" aria-label={label}>
      <div className="side-group-head">
        <button
          type="button"
          className="section-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "chevron" : "next"} size={12} />
          <h2>{label}</h2>
        </button>
        <span className="side-count">{tasks.length || ""}</span>
      </div>
      {open && (
        <ul>
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} running={running(task.id)} />
          ))}
          {!tasks.length && <li className="side-empty">Nothing has come back to you.</li>}
        </ul>
      )}
    </section>
  );
}

/** Pinned, Inbox (came back to you), Working, Snoozed, Settled (collapsed). */
export function TaskList() {
  const { tasks, running, loaded, available, error } = useTasks();
  useTaskListKeys();
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
  const groups = groupTasks(tasks);
  return (
    <>
      {SECTIONS.map((section) => (
        <Section
          key={section.id}
          id={section.id}
          label={section.label}
          tasks={groups[section.id]}
          running={running}
        />
      ))}
    </>
  );
}
