import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Store } from "@passport/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, matter, person } from "./fixtures.js";
import { openStore } from "./index.js";
import { MATTER_REFS_MIGRATION, migrations } from "./migrations.js";
import { notesRegexLimits } from "./notes-regex.js";
import { TASKS_MIGRATION } from "./store-tasks-migration.js";

let store: Store;
beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  await store.migrate();
});
afterEach(async () => {
  notesRegexLimits.timeoutMs = 2000;
  await store.close();
});

describe("R4-6: notes_search regexes", () => {
  it("rejects long patterns, backreferences and nested quantifiers", async () => {
    for (const pattern of ["(a+)+$", "(\\w+\\s?)*$", "(a|aa)*b", "(a)\\1", "(?<x>a)\\k<x>"]) {
      await expect(store.notes!.search({ pattern })).rejects.toMatchObject({
        code: "INVALID_QUERY",
        message: expect.stringContaining("too complex"),
      });
    }
    await expect(store.notes!.search({ pattern: "a".repeat(201) })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("matches off the main thread and stops a slow pattern after the time limit", async () => {
    // Display names come from From headers: the attacker controls the haystack.
    await store.people.upsert(person("mallory", { displayName: `${"a".repeat(3000)}!` }));
    notesRegexLimits.timeoutMs = 300;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    try {
      // Polynomial (passes the lint), far longer than the limit on this input.
      await expect(
        store.notes!.search({ pattern: "^\\w*\\w*\\w*\\w*\\w*\\w*$", kind: "person" }),
      ).rejects.toMatchObject({ code: "PATTERN_TIMEOUT" });
    } finally {
      clearInterval(timer);
    }
    expect(Date.now() - started).toBeLessThan(2000);
    // The event loop kept running while the worker matched.
    expect(ticks).toBeGreaterThan(5);
  });

  it("still finds matches through the worker and keeps plain text inline", async () => {
    await store.people.upsert(person("dana", { notes: "Leasing manager\nRenewal due 2026-11-01" }));
    expect(await store.notes!.search({ pattern: "^renewal due \\d{4}" })).toEqual([
      expect.objectContaining({ id: "dana", field: "notes", snippet: "Renewal due 2026-11-01" }),
    ]);
    expect(await store.notes!.search({ text: "leasing" })).toEqual([
      expect.objectContaining({ id: "dana", field: "notes", snippet: "Leasing manager" }),
    ]);
  });
});

describe("R4-27: migration order", () => {
  it("repairs a data dir first migrated by the task-model branch build", async () => {
    const directory = await mkdtemp(join(tmpdir(), "passport-r4-27-"));
    const path = join(directory, "store.sqlite");
    try {
      // That build applied migrations #1, #2 and then the tasks migration as #3.
      const raw = new DatabaseSync(path);
      raw.exec(
        "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      [migrations[0]!, migrations[1]!, TASKS_MIGRATION].forEach((sql, index) => {
        raw.exec(sql);
        raw.prepare("INSERT INTO schema_version VALUES (?, ?)").run(index + 1, at);
      });
      raw.close();
      const opened = openStore({ path, masterKey: "test-key" });
      try {
        await opened.migrate();
        await opened.matters.upsert(
          matter("lease", {
            refs: [{ account: "account", providerId: "p1", date: at, subject: "Lease" }],
          }),
        );
        expect(
          (await opened.notes!.mattersByRef!({ account: "account", providerId: "p1" })).map(
            (found) => found.id,
          ),
        ).toEqual(["lease"]);
      } finally {
        await opened.close();
      }
      const check = new DatabaseSync(path);
      expect(
        check.prepare("SELECT name FROM sqlite_master WHERE name = 'matter_refs'").get(),
      ).toEqual({ name: "matter_refs" });
      check.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-applies the matter_refs migration last and fails loudly on a missing table", async () => {
    expect(migrations.at(-1)).toBe(MATTER_REFS_MIGRATION);
    const directory = await mkdtemp(join(tmpdir(), "passport-r4-27-"));
    const path = join(directory, "store.sqlite");
    try {
      const first = openStore({ path, masterKey: "test-key" });
      await first.migrate();
      await first.close();
      // Every version is recorded, yet a table is missing (a reordered migration list).
      const raw = new DatabaseSync(path);
      raw.exec("DROP TABLE task_items");
      raw.close();
      const reopened = openStore({ path, masterKey: "test-key" });
      try {
        await expect(reopened.migrate()).rejects.toMatchObject({
          code: "SCHEMA_VERSION",
          message: expect.stringContaining("task_items"),
        });
      } finally {
        await reopened.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("task runs by action", () => {
  it("finds the run whose actionIds lists the action, optionally within one agent run", async () => {
    const tasks = store.tasks!;
    await tasks.insert({
      id: "t1",
      title: "T",
      accountIds: [],
      status: "inbox",
      pinned: false,
      permissionMode: "supervised",
      interactionMode: "default",
      createdBy: "user",
      kind: "task",
      needsUser: null,
      lastActivityAt: at,
      createdAt: at,
      watches: [],
    });
    for (const [id, agentRunId, actionIds] of [
      ["r1", "arrival:e1", ["a1"]],
      ["r2", "arrival:e1", ["a2"]],
    ] as const) {
      await tasks.runs.insert({
        id,
        taskId: "t1",
        status: "completed",
        trigger: { kind: "arrival", emailId: "e1" },
        priority: "background",
        agentRunId,
        createdAt: at,
        actionIds: [...actionIds],
      });
    }
    expect((await tasks.runs.byActionId!("a1"))?.id).toBe("r1");
    expect((await tasks.runs.byActionId!("a2", "arrival:e1"))?.id).toBe("r2");
    expect(await tasks.runs.byActionId!("a1", "other")).toBeNull();
    expect(await tasks.runs.byActionId!("missing")).toBeNull();
  });
});
