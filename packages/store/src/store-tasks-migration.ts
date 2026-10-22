/**
 * Tasks, runs and timeline items (v0.3 wave 2). `IF NOT EXISTS` keeps the migration safe to
 * reorder against other wave-2 migrations merged in parallel.
 */
export const TASKS_MIGRATION = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
    status TEXT NOT NULL, kind TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
    last_activity_at TEXT NOT NULL, inbox_account_id TEXT, job_id TEXT,
    watching INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS tasks_activity ON tasks(last_activity_at, id);
  CREATE INDEX IF NOT EXISTS tasks_status_activity ON tasks(status, last_activity_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS tasks_inbox_account ON tasks(inbox_account_id)
    WHERE inbox_account_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS tasks_job ON tasks(job_id) WHERE job_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS tasks_watching ON tasks(watching) WHERE watching = 1;
  CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_run_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs(task_id, created_at, id);
  CREATE INDEX IF NOT EXISTS task_runs_agent ON task_runs(agent_run_id, created_at);
  CREATE INDEX IF NOT EXISTS task_runs_open ON task_runs(status)
    WHERE status IN ('queued', 'running', 'waiting');
  CREATE TABLE IF NOT EXISTS task_items (
    id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, kind TEXT NOT NULL,
    UNIQUE(task_id, seq)
  );
`;
