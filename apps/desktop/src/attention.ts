// What needs the person, as the menu bar and notifications see it. Pure: decisions.ts fetches.
import { decisionLink, taskLink } from "./deep-links";

/** The slice of ActionRecord (packages/types) this process reads. */
export interface PendingAction {
  id: string;
  status: string;
  request?: { type?: string; params?: Record<string, unknown> };
}

/** The slice of Task (packages/types/src/tasks.ts) this process reads. */
export interface TaskSummary {
  id: string;
  title?: string;
  status?: string;
  needsUser?: string | null;
  pendingActionIds?: string[];
}

export interface Attention {
  /** The passport:// link a click opens. */
  link: string;
  /** Never message content: an action or task label and, at most, a subject or task title. */
  title: string;
}

/** Ids (decisions) and `task:need` keys (tasks) already counted, so only new ones are announced. */
export type Seen = Set<string>;

export interface Snapshot {
  count: number;
  /** Empty when there was no previous snapshot: the first one is the baseline. */
  fresh: Attention[];
  seen: Seen;
}

const LABELS: Record<string, string> = {
  send: "Send a message",
  draft_create: "Save a draft",
  draft_update: "Update a draft",
  draft_delete: "Delete a draft",
  delete: "Delete mail",
  move: "Move mail",
  archive: "Archive mail",
  label: "Label mail",
  unsubscribe: "Unsubscribe",
  calendar_propose: "Propose a meeting",
  calendar_create: "Create an event",
  calendar_update: "Update an event",
  calendar_respond: "Answer an invitation",
  calendar_delete: "Delete an event",
  profile_update: "Update your profile",
};

const NEEDS: Record<string, string> = {
  approval: "Waiting for your approval",
  failure: "A run failed",
  question: "Has a question for you",
};

function withLine(label: string, line: unknown): string {
  if (typeof line !== "string" || !line.trim()) {
    return label;
  }
  const text = line.replace(/\s+/g, " ").trim();
  return `${label}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
}

export function describeAction(action: PendingAction): string {
  const type = action.request?.type ?? "";
  const label = LABELS[type] ?? `Review: ${type.replaceAll("_", " ") || "action"}`;
  return withLine(label, action.request?.params?.subject);
}

export function describeTask(task: TaskSummary): string {
  return withLine(NEEDS[task.needsUser ?? ""] ?? "Needs you", task.title);
}

const needy = (task: TaskSummary) => !!task.needsUser && task.status !== "archived";

/**
 * With task routes (`tasks` not null), the count is the tasks that need the person plus proposals
 * no task owns (host agents over MCP propose outside tasks), matching the web "Needs you" view.
 * A proposal a task owns is announced as that task. Without task routes (demo), it is the
 * pending decisions, as in v0.2.
 */
export function snapshot(
  decisions: PendingAction[],
  tasks: TaskSummary[] | null,
  previous: Seen | null,
): Snapshot {
  const proposed = decisions.filter((item) => item.status === "proposed");
  const isNew = (key: string) => previous !== null && !previous.has(key);
  if (!tasks) {
    return {
      count: proposed.length,
      fresh: proposed
        .filter((item) => isNew(item.id))
        .map((item) => ({ link: decisionLink(item.id), title: describeAction(item) })),
      seen: new Set(proposed.map((item) => item.id)),
    };
  }
  const waiting = tasks.filter(needy);
  const owner = new Map<string, TaskSummary>();
  for (const task of tasks) {
    for (const id of task.pendingActionIds ?? []) {
      owner.set(id, task);
    }
  }
  const orphans = proposed.filter((item) => !owner.has(item.id));
  const fresh = new Map<string, Attention>();
  const announceTask = (task: TaskSummary) => {
    if (!fresh.has(task.id)) {
      fresh.set(task.id, { link: taskLink(task.id), title: describeTask(task) });
    }
  };
  for (const task of waiting) {
    if (isNew(`${task.id}:${task.needsUser}`)) {
      announceTask(task);
    }
  }
  for (const item of proposed) {
    if (!isNew(item.id)) {
      continue;
    }
    const task = owner.get(item.id);
    if (task) {
      // A further approval in a task that already needed the person still deserves a nudge.
      announceTask(needy(task) ? task : { ...task, needsUser: "approval" });
    } else {
      fresh.set(item.id, { link: decisionLink(item.id), title: describeAction(item) });
    }
  }
  return {
    count: waiting.length + orphans.length,
    fresh: [...fresh.values()],
    seen: new Set([
      ...proposed.map((item) => item.id),
      ...waiting.map((task) => `${task.id}:${task.needsUser}`),
    ]),
  };
}
