import { isFinished, type SetupProvider, type SetupTask } from "../setup-api";
export const providerNames: Record<SetupProvider, string> = {
  gmail: "Gmail",
  microsoft: "Outlook",
};

/** Respond and cancel may echo the updated task; apply it without waiting for a poll. */
export const asTask = (value: unknown) =>
  value && typeof value === "object" && "steps" in value ? (value as SetupTask) : undefined;

const statusRank: Record<SetupTask["status"], number> = {
  running: 0,
  waiting_for_user: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

/** The server's per-task revision (0.2.0+); older servers omit it and fall back to the heuristics below. */
function revision(task: SetupTask): number | string | undefined {
  const extra = task as SetupTask & { revision?: unknown; updatedAt?: unknown };
  if (typeof extra.revision === "number") {
    return extra.revision;
  }
  if (typeof extra.updatedAt === "string") {
    return extra.updatedAt;
  }
  return undefined;
}

/** -1, 0 or 1: how far the log of `a` has progressed relative to `b`. */
function compareLogs(a: SetupTask, b: SetupTask) {
  if (a.log.length !== b.log.length) {
    return a.log.length < b.log.length ? -1 : 1;
  }
  // The server keeps the last 300 lines, so at the cap only the newest timestamp moves.
  const lastA = a.log.at(-1)?.at ?? "",
    lastB = b.log.at(-1)?.at ?? "";
  if (lastA === lastB) {
    return 0;
  }
  return lastA < lastB ? -1 : 1;
}

/**
 * True when `next` is an older snapshot of the task already on screen. Polls and WebSocket
 * frames can arrive out of order; tasks carry no revision, so order comes from the log,
 * then the status (a prompt follows the run that asked it, and terminal is final), then the
 * prompt: one that was already answered or replaced never comes back.
 */
export function isStaleSnapshot(
  next: SetupTask,
  current: SetupTask | undefined,
  resolvedPrompts: ReadonlySet<string>,
) {
  if (!current || next.id !== current.id) {
    return false;
  }
  const nextRevision = revision(next),
    currentRevision = revision(current);
  if (nextRevision !== undefined && currentRevision !== undefined) {
    return nextRevision < currentRevision;
  }
  if (isFinished(current) && !isFinished(next)) {
    return true;
  }
  if (next.prompt && resolvedPrompts.has(next.prompt.id)) {
    return true;
  }
  const logs = compareLogs(next, current);
  if (logs !== 0) {
    return logs < 0;
  }
  if (current.prompt && resolvedPrompts.has(current.prompt.id)) {
    return false;
  }
  return statusRank[next.status] < statusRank[current.status];
}
