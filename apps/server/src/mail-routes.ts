import type { Hono } from "hono";
import type { Backend } from "./backend.js";
import { required } from "./errors.js";
import { emailQuery } from "./route-input.js";

export function installMailRoutes(app: Hono, backend: Backend): void {
  app.get("/api/emails", async (c) =>
    c.json(await backend.store.emails.query(emailQuery(c.req.query()))),
  );
  app.get("/api/emails/:id", async (c) =>
    c.json(
      required(
        await backend.store.emails.get(c.req.param("id"), {
          includeBodies: true,
        }),
        "Email",
      ),
    ),
  );
  app.get("/api/threads/:id", async (c) => {
    const thread = required(await backend.store.threads.get(c.req.param("id")), "Thread");
    return c.json({
      thread,
      emails: await backend.store.emails.query({
        threadId: thread.id,
        includeBodies: true,
        includeDeleted: true,
        limit: 500,
        sort: "receivedAt_asc",
      }),
    });
  });
}
