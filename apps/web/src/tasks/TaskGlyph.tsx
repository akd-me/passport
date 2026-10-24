import type { Task } from "@passport/types";
import type { ReactNode } from "react";
import { stateLabel, stateText, type TaskState, taskState } from "./model";

/**
 * One family of 14 px marks drawn on the same circle. Filled means it waits on you (Approval),
 * a ring with a centre means it asks (Input), a broken ring means it waits on someone else, an
 * arc turns while it works. Colour comes from the state class: accent for what needs you, amber
 * for Limited, red for Failed, green for Done.
 */
const marks: Record<TaskState, ReactNode> = {
  approval: <circle cx="7" cy="7" r="5.5" fill="currentColor" />,
  input: (
    <>
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </>
  ),
  waiting: (
    <circle
      cx="7"
      cy="7"
      r="5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeDasharray="2.4 2.83"
    />
  ),
  working: (
    <>
      <circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        opacity="0.25"
      />
      <path
        d="M7 2a5 5 0 0 1 5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </>
  ),
  limited: (
    <>
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.6 7h4.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  failed: (
    <>
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 4.4v3.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="7" cy="9.6" r="0.85" fill="currentColor" />
    </>
  ),
  woke: (
    <>
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 2a5 5 0 0 0 0 10z" fill="currentColor" />
    </>
  ),
  done: (
    <>
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M4.7 7.2l1.6 1.6 3-3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  idle: <circle cx="7" cy="7" r="2.75" fill="none" stroke="currentColor" strokeWidth="1.5" />,
};

/** A state's mark, with its meaning for screen readers. */
export function StateGlyph({ state }: { state: TaskState }) {
  const text = stateText[state];
  return (
    <span className={`task-glyph ${state}`} title={text || undefined}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        {marks[state]}
      </svg>
      {text && <span className="sr-only">{text}</span>}
    </span>
  );
}

/** The task's status mark. */
export function TaskGlyph({ task, running = false }: { task: Task; running?: boolean }) {
  return <StateGlyph state={taskState(task, running)} />;
}

/** The mark with its badge word, for the task header and Needs you. */
export function StateWord({ state }: { state: TaskState }) {
  if (state === "idle") {
    return null;
  }
  return (
    <span className={`state-word ${state}`}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" className="state-mark">
        {marks[state]}
      </svg>
      <span title={stateText[state]}>{stateLabel[state]}</span>
    </span>
  );
}
