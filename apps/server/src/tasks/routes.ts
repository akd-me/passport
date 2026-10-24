import {
  TASK_STATUSES,
  type TaskInteractionMode,
  type TaskKind,
  type TaskMessageMode,
  TRUST_LEVELS,
  type TrustLevel,
} from "@passport/types";
import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError } from "../errors.js";
import { readEmail } from "../ondemand-wiring.js";
import { csv, jsonBody, limit } from "../route-input.js";
import { integer, member, string } from "../validation.js";
import { installTaskLifecycleRoutes } from "./routes-lifecycle.js";
import type { TaskSystem } from "./wiring.js";

const MESSAGE_MAX = 20_000;
const KINDS: TaskKind[] = ["task", "inbox", "routine"];
const INTERACTION: TaskInteractionMode[] = ["default", "plan"];

export function system(backend: Backend): TaskSystem {
  if (!backend.tasks) {
    throw new ApiError("TASKS_UNAVAILABLE", "Tasks need the real backend (passport serve)", 501);
  }
  return backend.tasks;
}

export function text(value: unknown, name: string, max = MESSAGE_MAX): string {
  const result = string(value, name).trim();
  if (!result || result.length > max) {
    throw new ApiError("INVALID_FIELD", `${name} must contain 1–${max} characters`);
  }
  return result;
}

export function only(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new ApiError("INVALID_FIELD", `Unknown field ${unknown}`);
  }
}

const mode = (value: unknown) =>
  value === undefined
    ? undefined
    : (member(string(value, "permissionMode"), TRUST_LEVELS, "permissionMode") as TrustLevel);
const interaction = (value: unknown) =>
  value === undefined
    ? undefined
    : member(string(value, "interactionMode"), INTERACTION, "interactionMode");
const ids = (value: unknown, name: string) => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string") || value.length > 100) {
    throw new ApiError("INVALID_FIELD", `${name} must be up to 100 strings`);
  }
  return value as string[];
};

/**
 * Composer context for `POST /api/tasks`: known accounts, an existing matter, and messages by
 * ULID or mail handle (an uncached handle is fetched and cached, like explicit triage). Returns
 * the email ULIDs the run receives.
 */
async function composerContext(backend: Backend, body: Record<string, unknown>) {
  const accountIds = ids(body.accountIds, "accountIds");
  for (const id of accountIds ?? []) {
    if (!(await backend.store.accounts.get(id))) {
      throw new ApiError("UNKNOWN_ACCOUNT", `Unknown account ${id}`);
    }
  }
  const matterId = body.matterId === undefined ? undefined : text(body.matterId, "matterId", 200);
  if (matterId && !(await backend.store.matters.get(matterId))) {
    throw new ApiError("UNKNOWN_MATTER", "Unknown matterId");
  }
  const emailIds: string[] = [];
  for (const id of ids(body.emailIds, "emailIds") ?? []) {
    const email = id.trim() ? await readEmail(backend.store, backend.readers, id) : null;
    if (!email) {
      throw new ApiError("UNKNOWN_EMAIL", `Unknown email ${id}`);
    }
    if (accountIds?.length && !accountIds.includes(email.accountId)) {
      throw new ApiError("ACCOUNT_MISMATCH", "An email belongs to an account outside accountIds");
    }
    if (!(await backend.store.emails.get(email.id, { cacheOnly: true }))) {
      await backend.store.emails.upsertMany([email]);
    }
    emailIds.push(email.id);
  }
  return {
    accountIds,
    ...(matterId ? { matterId } : {}),
    ...(emailIds.length ? { emailIds: [...new Set(emailIds)] } : {}),
  };
}

/** Task API (docs/tasks.md). Approvals stay on `/api/actions/:id/{approve,reject}`. */
export function installTaskRoutes(app: Hono, backend: Backend): void {
  app.get("/api/tasks", async (c) => {
    const q = c.req.query();
    return c.json(
      await system(backend).service.list({
        status: csv(q.status)?.map((s) => member(s, TASK_STATUSES, "status")),
        kind: csv(q.kind)?.map((k) => member(k, KINDS, "kind")),
        pinned: q.pinned === undefined ? undefined : q.pinned === "true",
        limit: limit(q.limit),
        cursor: q.cursor,
      }),
    );
  });
  app.post("/api/tasks", async (c) => {
    const body = await jsonBody(c.req.raw);
    only(body, [
      "title",
      "accountIds",
      "permissionMode",
      "interactionMode",
      "message",
      "parentTaskId",
      "matterId",
      "emailIds",
    ]);
    const tasks = system(backend);
    const message = text(body.message, "message");
    const title = body.title === undefined ? undefined : text(body.title, "title", 200);
    const { task, run } = await tasks.service.create({
      message,
      title,
      ...(await composerContext(backend, body)),
      permissionMode: mode(body.permissionMode),
      interactionMode: interaction(body.interactionMode),
      parentTaskId:
        body.parentTaskId === undefined ? undefined : string(body.parentTaskId, "parentTaskId"),
    });
    return c.json({ task, run }, 201);
  });
  app.get("/api/tasks/by-action/:actionId", async (c) =>
    c.json(await system(backend).service.byAction(c.req.param("actionId"))),
  );
  app.get("/api/tasks/:id", async (c) =>
    c.json(await system(backend).service.get(c.req.param("id"))),
  );
  app.get("/api/tasks/:id/items", async (c) => {
    const q = c.req.query();
    const afterSeq =
      q.afterSeq === undefined
        ? undefined
        : integer(Number(q.afterSeq), "afterSeq", 0, Number.MAX_SAFE_INTEGER);
    const items = await system(backend).service.items(c.req.param("id"), afterSeq, limit(q.limit));
    return c.json({ items, lastSeq: items.at(-1)?.seq ?? afterSeq ?? 0 });
  });
  app.post("/api/tasks/:id/messages", async (c) => {
    const body = await jsonBody(c.req.raw);
    only(body, ["text", "mode"]);
    const messageMode =
      body.mode === undefined
        ? "queue"
        : (member(string(body.mode, "mode"), ["queue", "steer"], "mode") as TaskMessageMode);
    return c.json(
      await system(backend).queue.send(c.req.param("id"), {
        text: text(body.text, "text"),
        mode: messageMode,
      }),
      202,
    );
  });
  app.post("/api/tasks/:id/interrupt", async (c) =>
    c.json(await system(backend).queue.interrupt(c.req.param("id"))),
  );
  app.post("/api/tasks/:id/snooze", async (c) => {
    const body = await jsonBody(c.req.raw);
    only(body, ["until"]);
    return c.json(
      await system(backend).lifecycle.snooze(c.req.param("id"), string(body.until, "until")),
    );
  });
  app.post("/api/tasks/:id/settle", async (c) =>
    c.json(await system(backend).lifecycle.settle(c.req.param("id"))),
  );
  app.post("/api/tasks/:id/archive", async (c) =>
    c.json(await system(backend).lifecycle.archive(c.req.param("id"))),
  );
  app.post("/api/tasks/:id/pin", async (c) =>
    c.json(await system(backend).service.pin(c.req.param("id"), true)),
  );
  app.post("/api/tasks/:id/unpin", async (c) =>
    c.json(await system(backend).service.pin(c.req.param("id"), false)),
  );
  app.post("/api/tasks/:id/unwatch", async (c) => {
    const body = await jsonBody(c.req.raw, true);
    only(body, ["threadHandle"]);
    return c.json(
      await system(backend).service.unwatch(
        c.req.param("id"),
        body.threadHandle === undefined ? undefined : string(body.threadHandle, "threadHandle"),
      ),
    );
  });
  app.patch("/api/tasks/:id", async (c) => {
    const body = await jsonBody(c.req.raw);
    only(body, ["title", "permissionMode", "interactionMode"]);
    return c.json(
      await system(backend).service.patch(c.req.param("id"), {
        title: body.title === undefined ? undefined : text(body.title, "title", 200),
        permissionMode: mode(body.permissionMode),
        interactionMode: interaction(body.interactionMode),
      }),
    );
  });
  installTaskLifecycleRoutes(app, backend);
}
