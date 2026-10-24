import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { jsonBody } from "../route-input.js";
import { only, system, text } from "./routes.js";

/**
 * v0.4 (W2A) routes: answer or dismiss an `ask_user` question, and the Lineage panel
 * (docs/tasks.md "Questions" and "Subtasks").
 */
export function installTaskOrchestrationRoutes(app: Hono, backend: Backend): void {
  app.post("/api/tasks/:id/questions/:itemId/answer", async (c) => {
    const body = await jsonBody(c.req.raw);
    only(body, ["text"]);
    return c.json(
      await system(backend).questions.answer(
        c.req.param("id"),
        c.req.param("itemId"),
        text(body.text, "text"),
      ),
      202,
    );
  });
  app.post("/api/tasks/:id/questions/:itemId/dismiss", async (c) =>
    c.json(await system(backend).questions.dismiss(c.req.param("id"), c.req.param("itemId"))),
  );
  app.get("/api/tasks/:id/lineage", async (c) =>
    c.json(await system(backend).subtasks.lineage(c.req.param("id"))),
  );
}
