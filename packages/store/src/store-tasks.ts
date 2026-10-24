import type { SQLInputValue } from "node:sqlite";
import type { StoreTasks, Task, TaskItem, TaskRun } from "@passport/types";
import { StoreError } from "./errors.js";
import { newId } from "./ids.js";
import type { StoreDatabase } from "./store-database.js";
import { decodeCursor, definedPatch, limitOf, nextCursor } from "./store-query.js";

const OPEN_RUNS = ["queued", "running", "waiting"] as const;

function taskScalars(task: Task): Record<string, SQLInputValue> {
  return {
    status: task.status,
    kind: task.kind,
    pinned: task.pinned ? 1 : 0,
    last_activity_at: task.lastActivityAt,
    inbox_account_id: task.kind === "inbox" ? (task.accountIds[0] ?? null) : null,
    job_id: task.kind === "routine" ? (task.jobId ?? null) : null,
    watching: task.watches.length ? 1 : 0,
  };
}

function runScalars(run: TaskRun): Record<string, SQLInputValue> {
  return {
    task_id: run.taskId,
    agent_run_id: run.agentRunId,
    status: run.status,
    created_at: run.createdAt,
  };
}

/** `Store.tasks`: tasks, their runs and the append-only item timeline. */
export function createTasksRepository(db: StoreDatabase): StoreTasks {
  const getTask = (id: string) => db.get<Task>("tasks", id);
  const getRun = (id: string) => db.get<TaskRun>("task_runs", id);
  const runs: StoreTasks["runs"] = {
    get: async (id) => getRun(id),
    byAgentRunId: async (agentRunId) => {
      const row = db.one(
        "SELECT data FROM task_runs WHERE agent_run_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        [agentRunId],
      );
      return row ? db.parse<TaskRun>(row) : null;
    },
    byActionId: async (actionId, agentRunId) => {
      const row = db.one(
        `SELECT data FROM task_runs WHERE ${agentRunId === undefined ? "" : "agent_run_id = ? AND "}
        EXISTS (SELECT 1 FROM json_each(task_runs.data, '$.actionIds') WHERE value = ?)
        ORDER BY created_at DESC, id DESC LIMIT 1`,
        agentRunId === undefined ? [actionId] : [agentRunId, actionId],
      );
      return row ? db.parse<TaskRun>(row) : null;
    },
    list: async (taskId, limit = 50) =>
      db.rows<TaskRun>(
        "SELECT data FROM task_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        [taskId, limitOf(limit)],
      ),
    unfinished: async () =>
      db.rows<TaskRun>(
        `SELECT data FROM task_runs WHERE status IN (${OPEN_RUNS.map(() => "?").join(",")})
        ORDER BY created_at, id`,
        [...OPEN_RUNS],
      ),
    insert: async (run) => {
      if (!getTask(run.taskId)) {
        throw new StoreError("NOT_FOUND", "Task does not exist");
      }
      db.put("task_runs", run.id, run, runScalars(run));
      return getRun(run.id)!;
    },
    update: async (id, patch) =>
      db.transaction(() => {
        const run = getRun(id);
        if (!run) {
          throw new StoreError("NOT_FOUND", "Task run does not exist");
        }
        const changes = typeof patch === "function" ? patch(run) : patch;
        const updated: TaskRun = { ...run, ...definedPatch(changes), id, taskId: run.taskId };
        db.put("task_runs", id, updated, runScalars(updated));
        return updated;
      }),
  };
  const items: StoreTasks["items"] = {
    append: async (input) =>
      db.transaction(() => {
        const row = db.one(
          "SELECT COALESCE(MAX(seq), 0) AS seq FROM task_items WHERE task_id = ?",
          [input.taskId],
        );
        const item = { ...input, id: newId(), seq: Number(row?.seq ?? 0) + 1 } as TaskItem;
        db.run("INSERT INTO task_items(id, data, task_id, seq, kind) VALUES (?, ?, ?, ?, ?)", [
          item.id,
          JSON.stringify(item),
          item.taskId,
          item.seq,
          item.kind,
        ]);
        return item;
      }),
    list: async ({ taskId, afterSeq = 0, limit = 100 }) =>
      db.rows<TaskItem>(
        "SELECT data FROM task_items WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?",
        [taskId, afterSeq, limitOf(limit)],
      ),
    recent: async (taskId, kinds, limit) =>
      kinds.length
        ? db.rows<TaskItem>(
            `SELECT data FROM task_items WHERE task_id = ? AND kind IN (${kinds.map(() => "?").join(",")})
            ORDER BY seq DESC LIMIT ?`,
            [taskId, ...kinds, limitOf(limit)],
          )
        : [],
  };
  return {
    get: async (id) => getTask(id),
    list: async (q = {}) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      for (const [column, values] of [
        ["status", q.status],
        ["kind", q.kind],
      ] as const) {
        if (values?.length) {
          where.push(`${column} IN (${values.map(() => "?").join(",")})`);
          params.push(...values);
        }
      }
      if (q.pinned !== undefined) {
        where.push("pinned = ?");
        params.push(q.pinned ? 1 : 0);
      }
      if (q.parentTaskId) {
        // Children of one task (v0.4 subtasks); few rows, so no dedicated column.
        where.push("json_extract(data, '$.parentTaskId') = ?");
        params.push(q.parentTaskId);
      }
      const clause = () => (where.length ? `WHERE ${where.join(" AND ")}` : "");
      const total = Number(
        db.one(`SELECT COUNT(*) AS count FROM tasks ${clause()}`, params)!.count,
      );
      if (q.cursor) {
        const cursor = decodeCursor(q.cursor, "lastActivityAt_desc");
        where.push("(last_activity_at, id) < (?, ?)");
        params.push(cursor.at, cursor.id);
      }
      const limit = limitOf(q.limit);
      const rows = db.rows<Task>(
        `SELECT data FROM tasks ${clause()} ORDER BY last_activity_at DESC, id DESC LIMIT ?`,
        [...params, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page,
        total,
        nextCursor:
          rows.length > limit && last
            ? nextCursor("lastActivityAt_desc", last.lastActivityAt, last.id)
            : null,
      };
    },
    insert: async (task) => {
      const saved: Task = { ...task, revision: task.revision ?? 1 };
      db.run(
        `INSERT INTO tasks(id, data, ${Object.keys(taskScalars(saved)).join(",")})
        VALUES (?, ?, ${Object.keys(taskScalars(saved))
          .map(() => "?")
          .join(",")})`,
        [saved.id, JSON.stringify(saved), ...Object.values(taskScalars(saved))],
      );
      return getTask(saved.id)!;
    },
    update: async (id, patch) =>
      db.transaction(() => {
        const task = getTask(id);
        if (!task) {
          throw new StoreError("NOT_FOUND", "Task does not exist");
        }
        const changes = typeof patch === "function" ? patch(task) : patch;
        const updated: Task = {
          ...task,
          ...definedPatch(changes),
          id,
          kind: task.kind,
          revision: (task.revision ?? 0) + 1,
        };
        db.put("tasks", id, updated, taskScalars(updated));
        return updated;
      }),
    inboxFor: async (accountId) => {
      const row = db.one("SELECT data FROM tasks WHERE inbox_account_id = ?", [accountId]);
      return row ? db.parse<Task>(row) : null;
    },
    routineFor: async (jobId) => {
      const row = db.one("SELECT data FROM tasks WHERE job_id = ?", [jobId]);
      return row ? db.parse<Task>(row) : null;
    },
    watching: async () => db.rows<Task>("SELECT data FROM tasks WHERE watching = 1 ORDER BY id"),
    runs,
    items,
  };
}
