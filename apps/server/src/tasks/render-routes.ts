import { renderHeight, sanitizeRenderHtml } from "@passport/tools";
import type { Hono } from "hono";
import type { Backend } from "../backend.js";
import { ApiError, required } from "../errors.js";
import { jsonBody } from "../route-input.js";
import { editedRequest, integer, string } from "../validation.js";

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
    const original = required(await backend.store.actions.get(c.req.param("id")), "Action");
    if (original.status !== "proposed") {
      throw new ApiError("ACTION_NOT_PENDING", "This proposal has already been decided.", 409);
    }
    const request = editedRequest(
      {
        ...original.request,
        params: { ...original.request.params, draft: { textBody: body.textBody } },
      },
      original.request,
    );
    const action = await backend.store.actions.update(original.id, { request });
    backend.bus.emit({ type: "action.updated", action });
    return c.json(action);
  });
}
