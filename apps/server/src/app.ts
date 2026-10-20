import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import { TRUST_LEVELS } from "@passport/types";
import type {
  ActionQuery,
  EmailQuery,
  Matter,
  Person,
  PromotionOffer,
} from "@passport/types";
import type { Backend } from "./backend.js";
import { llmConfigured } from "./config.js";
import { addAccount } from "./accounts.js";
import { ApiError, required } from "./errors.js";
import {
  categories,
  editedRequest,
  integer,
  member,
  object,
  policyPatch,
  statuses,
  string,
} from "./validation.js";
import { logger } from "./logger.js";
import { getAuth, installAuth, type PassportAuth } from "./auth.js";

const csv = (value?: string) => value?.split(",").filter(Boolean);
const limit = (value?: string) =>
  value === undefined ? undefined : integer(Number(value), "limit", 1, 500);
function timestamp(value: string | undefined): string | undefined {
  if (
    value !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
  )
    throw new ApiError("INVALID_QUERY", "Expected an ISO timestamp");
  return value;
}
function actionQuery(q: Record<string, string>): ActionQuery {
  return {
    status: csv(q.status)?.map((s) => member(s, statuses, "status")),
    category: q.category
      ? member(q.category, categories, "category")
      : undefined,
    actorKind: q.actorKind
      ? member(q.actorKind, ["human", "agent", "external-agent"], "actorKind")
      : undefined,
    runId: q.runId,
    matterId: q.matterId,
    after: timestamp(q.after),
    before: timestamp(q.before),
    limit: limit(q.limit),
    cursor: q.cursor,
  };
}
function emailQuery(q: Record<string, string>): EmailQuery {
  if (q.includeBodies && !["true", "false"].includes(q.includeBodies))
    throw new ApiError("INVALID_QUERY", "includeBodies must be true or false");
  return {
    accountId: q.accountId,
    mailboxId: q.mailboxId,
    threadId: q.threadId,
    matterId: q.matterId === "null" ? null : q.matterId,
    personId: q.personId,
    text: q.text,
    category: q.category
      ? member(q.category, categories, "category")
      : undefined,
    after: timestamp(q.after),
    before: timestamp(q.before),
    limit: limit(q.limit),
    cursor: q.cursor,
    sort: q.sort
      ? member(q.sort, ["receivedAt_desc", "receivedAt_asc"], "sort")
      : undefined,
    includeBodies: q.includeBodies === "true",
    keywords: q.has || q.not ? { has: csv(q.has), not: csv(q.not) } : undefined,
  };
}
async function jsonBody(
  request: Request,
  optional = false,
): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim() && optional) return {};
  try {
    return object(JSON.parse(text));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_JSON", "Expected a JSON object");
  }
}
export function createApp(
  backend: Backend,
  options: { staticDir?: string; auth?: PassportAuth } = {},
) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ApiError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status,
      );
    if (error instanceof HTTPException)
      return c.json(
        { error: { code: "HTTP_ERROR", message: error.message } },
        error.status,
      );
    const code =
      typeof (error as { code?: unknown }).code === "string"
        ? (error as unknown as { code: string }).code
        : "INTERNAL_ERROR";
    // Do not return or log provider error text; it may contain credential-bearing URLs.
    logger.error(`Request failed (${code})`);
    return c.json(
      {
        error: {
          code,
          message:
            "The operation failed. Check your provider connection and retry.",
        },
      },
      500,
    );
  });
  installAuth(app, options.auth ?? getAuth(backend));
  app.get("/api/health", (c) => c.json({ ok: true, mode: backend.mode }));
  app.get("/api/decisions", async (c) =>
    c.json(
      await backend.store.actions.query({
        status: ["proposed", "held"],
        limit: 500,
      }),
    ),
  );
  app.get("/api/actions", async (c) =>
    c.json(await backend.store.actions.query(actionQuery(c.req.query()))),
  );
  app.post("/api/actions/:id/approve", async (c) => {
    const body = await jsonBody(c.req.raw, true),
      original = required(
        await backend.store.actions.get(c.req.param("id")),
        "Action",
      );
    const edited = body.request ?? body.editedRequest;
    return c.json(
      await backend.executor.approve(
        original.id,
        edited === undefined
          ? undefined
          : editedRequest(edited, original.request),
      ),
    );
  });
  app.post("/api/actions/:id/reject", async (c) => {
    const body = await jsonBody(c.req.raw, true);
    return c.json(
      await backend.executor.reject(
        c.req.param("id"),
        body.reason === undefined ? undefined : string(body.reason, "reason"),
      ),
    );
  });
  app.post("/api/actions/:id/cancel-hold", async (c) =>
    c.json(await backend.executor.cancelHold(c.req.param("id"))),
  );
  app.post("/api/actions/:id/undo", async (c) =>
    c.json(await backend.executor.undo(c.req.param("id"))),
  );
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
    const thread = required(
      await backend.store.threads.get(c.req.param("id")),
      "Thread",
    );
    return c.json({
      thread,
      emails: await backend.store.emails.query({
        threadId: thread.id,
        includeBodies: true,
        limit: 500,
        sort: "receivedAt_asc",
      }),
    });
  });
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
    const matter = required(
      await backend.store.matters.get(c.req.param("id")),
      "Matter",
    );
    const [emails, events, actions, people] = await Promise.all([
      backend.store.emails.query({
        matterId: matter.id,
        includeBodies: true,
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
    const matter = required(
        await backend.store.matters.get(c.req.param("id")),
        "Matter",
      ),
      body = await jsonBody(c.req.raw),
      patch: Partial<Matter> = {};
    for (const key of Object.keys(body))
      if (
        ![
          "title",
          "summary",
          "nextStep",
          "status",
          "dueAt",
          "snoozedUntil",
        ].includes(key)
      )
        throw new ApiError(
          "INVALID_FIELD",
          `Matter field ${key} is not editable here`,
        );
    for (const key of ["title", "summary", "nextStep"] as const)
      if (body[key] !== undefined) patch[key] = string(body[key], key);
    if (body.status !== undefined)
      patch.status = member(
        body.status,
        ["active", "waiting", "snoozed", "done"],
        "matter status",
      );
    for (const key of ["dueAt", "snoozedUntil"] as const)
      if (body[key] !== undefined)
        patch[key] =
          body[key] === null ? null : timestamp(string(body[key], key));
    const accountId =
      (matter.emailIds[0]
        ? await backend.store.emails.get(matter.emailIds[0])
        : null
      )?.accountId ?? (await backend.store.accounts.list())[0]?.id;
    if (!accountId)
      throw new ApiError("ACCOUNT_REQUIRED", "Add an account first");
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
    const person = required(
      await backend.store.people.get(c.req.param("id")),
      "Person",
    );
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
    if (!!start !== !!end)
      throw new ApiError("INVALID_QUERY", "Supply both start and end");
    return c.json(
      await backend.store.events.query({
        accountId: c.req.query("accountId"),
        matterId: c.req.query("matterId"),
        range: start && end ? { start, end } : undefined,
        limit: limit(c.req.query("limit")),
      }),
    );
  });
  app.get("/api/trust", async (c) => {
    const actions = await backend.store.actions.query({ limit: 500 }),
      offers = new Map<string, PromotionOffer>();
    for (const a of actions.items)
      if (a.decision.promotionOffer)
        offers.set(
          a.decision.promotionOffer.category,
          a.decision.promotionOffer,
        );
    return c.json({
      config: await backend.policy.getConfig(),
      categories: await backend.policy.getTrust(),
      promotionOffers: [...offers.values()],
    });
  });
  app.put("/api/trust/config", async (c) =>
    c.json(
      await backend.policy.setConfig(policyPatch(await jsonBody(c.req.raw))),
    ),
  );
  app.put("/api/trust/:category/pin", async (c) => {
    const body = await jsonBody(c.req.raw);
    return c.json(
      await backend.policy.pinLevel(
        member(c.req.param("category"), categories, "category"),
        body.level === null ? null : member(body.level, TRUST_LEVELS, "level"),
      ),
    );
  });
  app.get("/api/user-profile", async (c) =>
    c.json({ markdown: await backend.agent.getUserProfile() }),
  );
  app.put("/api/user-profile", async (c) => {
    const body = await jsonBody(c.req.raw),
      markdown = string(body.markdown, "markdown");
    if (markdown.length > 100000)
      throw new ApiError("INVALID_FIELD", "Profile is too large");
    await backend.agent.setUserProfile(markdown);
    return c.json({ markdown });
  });
  app.get("/api/accounts", async (c) => {
    const { apiKey, ...llm } = backend.config.llm;
    return c.json({
      accounts: await backend.store.accounts.list(),
      llm: {
        ...llm,
        apiKeyConfigured: !!apiKey,
        configured: llmConfigured(backend.config.llm),
      },
      mode: backend.mode,
    });
  });
  app.post("/api/accounts", async (c) =>
    c.json(await addAccount(backend, await jsonBody(c.req.raw)), 201),
  );
  app.post("/api/accounts/:id/sync", async (c) => {
    required(await backend.store.accounts.get(c.req.param("id")), "Account");
    await backend.syncAccount(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/providers", (c) =>
    c.json(
      backend.providerKinds.map((kind) => {
        const { oauth, ...descriptor } = backend.providers.describe(kind);
        return {
          ...descriptor,
          oauth: oauth ? { scopes: oauth.scopes } : undefined,
        };
      }),
    ),
  );
  app.put("/api/settings/llm", async (c) => {
    const body = await jsonBody(c.req.raw);
    for (const key of Object.keys(body))
      if (!["provider", "model", "baseUrl", "fastModel"].includes(key))
        throw new ApiError(
          "INVALID_FIELD",
          `Unknown LLM setting ${key}; API keys use PASSPORT_LLM_API_KEY`,
        );
    const llm = { ...backend.config.llm };
    if (body.provider !== undefined && body.provider !== llm.provider) {
      delete llm.apiKey;
      llm.apiKey =
        process.env.PASSPORT_LLM_API_KEY ||
        (body.provider === "anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : body.provider === "openai" || body.provider === "openai-compatible"
            ? process.env.OPENAI_API_KEY
            : undefined);
    }
    if (body.provider !== undefined)
      llm.provider = member(
        body.provider,
        ["anthropic", "openai", "openai-compatible", "ollama"],
        "LLM provider",
      );
    for (const key of ["model", "baseUrl", "fastModel"] as const)
      if (body[key] !== undefined) llm[key] = string(body[key], key);
    await backend.updateConfig({ llm });
    const { apiKey, ...publicLlm } = llm;
    return c.json({ ...publicLlm, apiKeyConfigured: !!apiKey });
  });
  app.post("/api/agent/run", async (c) => {
    const body = await jsonBody(c.req.raw, true);
    if (
      body.emailIds !== undefined &&
      (!Array.isArray(body.emailIds) ||
        body.emailIds.some((id) => typeof id !== "string"))
    )
      throw new ApiError("INVALID_FIELD", "emailIds must be strings");
    return c.json(
      await backend.agent.run({
        kind: "manual",
        instruction:
          body.instruction === undefined
            ? "Review active matters and prepare next steps."
            : string(body.instruction, "instruction"),
        matterId:
          body.matterId === undefined
            ? undefined
            : string(body.matterId, "matterId"),
        emailIds: body.emailIds as string[] | undefined,
      }),
    );
  });
  app.get("/api/digest/:date", async (c) => {
    const date = c.req.param("date");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    )
      throw new ApiError("INVALID_DATE", "Use YYYY-MM-DD");
    return c.json({
      date,
      markdown: required(
        await backend.store.kv.get(`digest:${date}`),
        "Digest",
      ),
    });
  });
  app.all("/api/*", (c) =>
    c.json({ error: { code: "NOT_FOUND", message: "Unknown API route" } }, 404),
  );
  const staticDir =
    options.staticDir ??
    fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (existsSync(`${staticDir}/index.html`)) {
    app.use("*", serveStatic({ root: staticDir }));
    app.get("*", serveStatic({ path: `${staticDir}/index.html` }));
  } else
    app.get("/", (c) =>
      c.text(
        "Passport API is running. Build @passport/web or start its Vite dev server.",
      ),
    );
  return app;
}
