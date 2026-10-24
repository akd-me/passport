import type { Task, TaskItem, TaskQueue, TaskRestoreState, TaskRun } from "@passport/types";
import { vi } from "vitest";
import { stubApi } from "../test-utils";
import { FakeSocket, minutesAgo } from "./test-fixtures";

/** A request the fake backend saw. */
export interface Seen {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/**
 * An in-memory task server for lifecycle tests: lists, detail, items, PATCH, and the v0.4
 * routes (seen, mark-unread, settle/snooze/archive with `previous`, reopen, queue, resume).
 * `fail` answers a path with an error body instead.
 */
export function lifecycleBackend(initial: Task[], options: { items?: TaskItem[] } = {}) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const tasks = new Map(initial.map((t) => [t.id, { ...t }]));
  const calls: Seen[] = [];
  const fail = new Map<string, { status: number; code: string }>();
  let revision = 100;
  const now = minutesAgo(0);
  const save = (task: Task) => {
    const next = { ...task, revision: ++revision };
    tasks.set(task.id, next);
    return next;
  };
  const restore = (task: Task): TaskRestoreState => ({
    status: task.status,
    snoozedUntil: task.snoozedUntil ?? null,
    settledAt: task.settledAt ?? null,
  });
  const queueOf = (task: Task): TaskQueue => ({
    taskId: task.id,
    held: !!task.queueHeld,
    entries: task.queue ?? [],
  });
  const run = (taskId: string, id = "run-new"): TaskRun => ({
    id,
    taskId,
    status: "queued",
    trigger: { kind: "message", itemId: "", mode: "steer" },
    priority: "interactive",
    agentRunId: id,
    createdAt: now,
    actionIds: [],
  });

  const route = async (url: URL, init?: RequestInit) => {
    const path = url.pathname.replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const failure = fail.get(path);
    if (failure) {
      return Response.json(
        { error: { code: failure.code, message: `Refused: ${failure.code}` } },
        { status: failure.status },
      );
    }
    if (path === "/tasks") {
      const items = [...tasks.values()].filter((t) => t.status !== "archived");
      return { items, total: items.length, nextCursor: null };
    }
    const [, , id = "", ...rest] = path.split("/");
    const task = tasks.get(id);
    if (!task) {
      return Response.json({ error: { code: "NOT_FOUND", message: "No task" } }, { status: 404 });
    }
    const tail = rest.join("/");
    if (!tail) {
      if (method === "PATCH") {
        return save({ ...task, ...body, ...(body?.title ? { titleGenerated: false } : {}) });
      }
      return { task, runs: [] };
    }
    if (tail === "items") {
      const items = (options.items ?? []).filter(
        (i) => i.seq > Number(url.searchParams.get("afterSeq")),
      );
      return { items, lastSeq: items.at(-1)?.seq ?? 0 };
    }
    switch (tail) {
      case "seen":
        return save({ ...task, seenAt: now, unseenOutcome: null });
      case "mark-unread":
        return save({ ...task, seenAt: null, unseenOutcome: task.unseenOutcome ?? "done" });
      case "settle":
        return {
          ...save({ ...task, status: "settled", needsUser: null, settledAt: now }),
          previous: restore(task),
        };
      case "archive":
        return { ...save({ ...task, status: "archived" }), previous: restore(task) };
      case "snooze":
        return {
          ...save({ ...task, status: "snoozed", snoozedUntil: body.until }),
          previous: restore(task),
        };
      case "unsettle":
      case "unsnooze":
      case "unarchive": {
        const from = { unsettle: "settled", unsnooze: "snoozed", unarchive: "archived" }[tail];
        const next =
          task.status === from
            ? save({ ...task, status: "inbox", snoozedUntil: null, returnedAt: now })
            : task;
        return { ...next, previous: restore(task) };
      }
      case "resume":
        return Response.json(
          { task: save({ ...task, needsUser: null, limited: null }), run: run(id) },
          { status: 202 },
        );
      case "resume-at-reset":
        return save({
          ...task,
          limited: task.limited ? { ...task.limited, autoResume: true } : null,
        });
      case "queue":
        return queueOf(task);
      case "queue/reorder": {
        const byId = new Map((task.queue ?? []).map((e) => [e.runId, e]));
        const queue = (body.runIds as string[]).map((r) => byId.get(r)).filter((e) => !!e);
        return queueOf(save({ ...task, queue }));
      }
      case "queue/resume":
        return queueOf(save({ ...task, queueHeld: false }));
    }
    const entry = tail.match(/^queue\/([^/]+)(\/promote-to-steer)?$/);
    if (entry) {
      const [, runId, promote] = entry;
      const queue = task.queue ?? [];
      if (promote) {
        const next = save({ ...task, queue: queue.filter((e) => e.runId !== runId) });
        return Response.json({ task: next, run: run(id, runId) }, { status: 202 });
      }
      if (method === "DELETE") {
        return queueOf(save({ ...task, queue: queue.filter((e) => e.runId !== runId) }));
      }
      if (method === "PATCH") {
        return queueOf(
          save({
            ...task,
            queue: queue.map((e) => (e.runId === runId ? { ...e, text: body.text } : e)),
          }),
        );
      }
    }
    return task;
  };
  stubApi({
    "/tasks": route,
    "/decisions": { items: [], total: 0 },
    "/actions": { items: [] },
    "/trust": {
      config: { globalMode: "supervised", alwaysAsk: [] },
      categories: [],
      promotionOffers: [],
    },
  });
  /** Requests other than the reads every page makes. */
  const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
  return { tasks, calls, writes, fail, save };
}
