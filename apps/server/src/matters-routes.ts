import type { Matter, Person } from "@passport/types";
import type { Hono } from "hono";
import type { Backend } from "./backend.js";
import { ApiError, required } from "./errors.js";
import { csv, jsonBody, limit, timestamp } from "./route-input.js";
import { member, string } from "./validation.js";

export function installMattersRoutes(app: Hono, backend: Backend): void {
  app.get("/api/matters", async (c) =>
    c.json(
      await backend.store.matters.list({
        status: csv(c.req.query("status"))?.map((s) =>
          member(s, ["active", "waiting", "snoozed", "done"], "matter status"),
        ),
        personId: c.req.query("personId"),
        text: c.req.query("text"),
        limit: limit(c.req.query("limit")),
      }),
    ),
  );
  app.get("/api/matters/:id", async (c) => {
    const matter = required(await backend.store.matters.get(c.req.param("id")), "Matter");
    const [emails, events, actions, people] = await Promise.all([
      backend.store.emails.query({
        matterId: matter.id,
        includeBodies: true,
        includeDeleted: true,
        limit: 500,
      }),
      backend.store.events.query({ matterId: matter.id }),
      backend.store.actions.query({ matterId: matter.id, limit: 500 }),
      Promise.all(matter.personIds.map((id) => backend.store.people.get(id))),
    ]);
    return c.json({
      matter,
      emails,
      events,
      actions,
      people: people.filter((p): p is Person => !!p),
    });
  });
  app.patch("/api/matters/:id", async (c) => {
    const matter = required(await backend.store.matters.get(c.req.param("id")), "Matter"),
      body = await jsonBody(c.req.raw),
      patch: Partial<Matter> = {};
    for (const key of Object.keys(body)) {
      if (!["title", "summary", "nextStep", "status", "dueAt", "snoozedUntil"].includes(key)) {
        throw new ApiError("INVALID_FIELD", `Matter field ${key} is not editable here`);
      }
    }
    for (const key of ["title", "summary", "nextStep"] as const) {
      if (body[key] !== undefined) {
        patch[key] = string(body[key], key);
      }
    }
    if (body.status !== undefined) {
      patch.status = member(body.status, ["active", "waiting", "snoozed", "done"], "matter status");
    }
    for (const key of ["dueAt", "snoozedUntil"] as const) {
      if (body[key] !== undefined) {
        patch[key] = body[key] === null ? null : timestamp(string(body[key], key));
      }
    }
    const accountId =
      (matter.emailIds[0] ? await backend.store.emails.get(matter.emailIds[0]) : null)?.accountId ??
      (await backend.store.accounts.list())[0]?.id;
    if (!accountId) {
      throw new ApiError("ACCOUNT_REQUIRED", "Add an account first");
    }
    return c.json(
      await backend.executor.submit({
        type: "matter_update",
        accountId,
        params: { matterId: matter.id, patch },
        actor: { kind: "human", id: "user" },
        category: "matters",
        matterId: matter.id,
        reason: "You updated this matter.",
      }),
    );
  });
  app.get("/api/people", async (c) =>
    c.json(
      await backend.store.people.list({
        text: c.req.query("text"),
        limit: limit(c.req.query("limit")),
        relationship: c.req.query("relationship")
          ? member(
              c.req.query("relationship"),
              ["self", "known", "stranger", "service"],
              "relationship",
            )
          : undefined,
      }),
    ),
  );
  app.get("/api/people/:id", async (c) => {
    const person = required(await backend.store.people.get(c.req.param("id")), "Person");
    return c.json({
      person,
      emails: await backend.store.emails.query({
        personId: person.id,
        limit: 100,
      }),
      matters: await backend.store.matters.list({ personId: person.id }),
    });
  });
  app.get("/api/events", async (c) => {
    const start = timestamp(c.req.query("start")),
      end = timestamp(c.req.query("end"));
    if (!!start !== !!end) {
      throw new ApiError("INVALID_QUERY", "Supply both start and end");
    }
    return c.json(
      await backend.store.events.query({
        accountId: c.req.query("accountId"),
        matterId: c.req.query("matterId"),
        range: start && end ? { start, end } : undefined,
        limit: limit(c.req.query("limit")),
      }),
    );
  });
}
