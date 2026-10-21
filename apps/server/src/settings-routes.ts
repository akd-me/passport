import type { PromotionOffer } from "@passport/types";
import { TRUST_LEVELS } from "@passport/types";
import type { Hono } from "hono";
import { addAccount } from "./accounts.js";
import type { Backend } from "./backend.js";
import { ApiError, required } from "./errors.js";
import { publicLlm } from "./llm-selection.js";
import { jsonBody } from "./route-input.js";
import { categories, member, policyPatch, string } from "./validation.js";

export function installSettingsRoutes(app: Hono, backend: Backend): void {
  app.get("/api/trust", async (c) => {
    const actions = await backend.store.actions.query({ limit: 500 }),
      offers = new Map<string, PromotionOffer>();
    for (const a of actions.items) {
      if (a.decision.promotionOffer) {
        offers.set(a.decision.promotionOffer.category, a.decision.promotionOffer);
      }
    }
    return c.json({
      config: await backend.policy.getConfig(),
      categories: await backend.policy.getTrust(),
      promotionOffers: [...offers.values()],
    });
  });
  app.put("/api/trust/config", async (c) =>
    c.json(await backend.policy.setConfig(policyPatch(await jsonBody(c.req.raw)))),
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
    if (markdown.length > 100000) {
      throw new ApiError("INVALID_FIELD", "Profile is too large");
    }
    return c.json(
      await backend.executor.submit({
        type: "profile_update",
        accountId: (await backend.store.accounts.list())[0]?.id ?? "profile",
        params: { markdown },
        actor: { kind: "human", id: "user" },
        category: "matters",
        reason: "You updated your profile.",
      }),
    );
  });
  app.get("/api/accounts", async (c) => {
    return c.json({
      accounts: await backend.store.accounts.list(),
      llm: publicLlm(backend.config),
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
}
