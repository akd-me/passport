import { type DraftEditingExecutor, PolicyError } from "@passport/policy";
import { renderHeight, sanitizeRenderHtml } from "@passport/tools";
import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError } from "../errors.js";
import { jsonBody } from "../route-input.js";
import { integer, string } from "../validation.js";

/** Preview and save share the approval editor's validation; neither executes the proposal. */
export function installRenderRoutes(app: Hono, backend: Backend): void {
  app.post("/api/render/preview", async (c) => {
    const body = await jsonBody(c.req.raw);
    if (Object.keys(body).some((key) => key !== "html" && key !== "height")) {
      throw new ApiError("INVALID_FIELD", "Preview accepts html and optional height.");
    }
    try {
      const html = sanitizeRenderHtml(string(body.html, "html"));
      const height =
        body.height === undefined ? undefined : integer(body.height, "height", 80, 1200);
      return c.json({ html, height: renderHeight(html, height) });
    } catch (error) {
      if (error instanceof Error && "code" in error) {
        throw new ApiError(String(error.code), error.message, 400);
      }
      throw error;
    }
  });
  app.patch("/api/actions/:id/draft", async (c) => {
    const body = await jsonBody(c.req.raw);
    if (Object.keys(body).some((key) => key !== "textBody")) {
      throw new ApiError("INVALID_FIELD", "Only the draft body is editable.");
    }
    const executor = backend.executor as Partial<DraftEditingExecutor>;
    if (!executor.editDraft) {
      throw new ApiError("NOT_IMPLEMENTED", "Draft editing needs the real action executor.", 501);
    }
    try {
      return c.json(
        await executor.editDraft(c.req.param("id"), string(body.textBody, "draft.textBody")),
      );
    } catch (error) {
      if (error instanceof PolicyError) {
        const status =
          error.code === "ACTION_DECIDED" ? 409 : error.code === "ACTION_NOT_FOUND" ? 404 : 400;
        throw new ApiError(error.code, error.message, status);
      }
      throw error;
    }
  });
}
