import type { Email, EmailGetOptions } from "@passport/types";
import { describe, expect, it } from "vitest";
import { email, request, setup } from "./testing/fixtures.js";

/** The in-memory store plus a batched `getMany`, recording every batch. */
async function batched() {
  const fixture = await setup();
  const { store } = fixture;
  const batches: Array<{ ids: string[]; opts?: EmailGetOptions }> = [];
  const singles: string[] = [];
  const overrides = new Map<string, Email | null>();
  const get = store.emails.get.bind(store.emails);
  store.emails.get = async (id, opts) => {
    if (opts?.fresh) {
      singles.push(id);
    }
    return get(id, opts);
  };
  store.emails.getMany = async (ids, opts) => {
    batches.push({ ids, ...(opts ? { opts } : {}) });
    return new Map(
      await Promise.all(
        ids.map(
          async (id) => [id, overrides.has(id) ? overrides.get(id)! : await get(id, opts)] as const,
        ),
      ),
    );
  };
  const ids = ["email", "e2", "e3"];
  await store.emails.upsertMany(
    ids.slice(1).map((id) => email({ id, providerId: `remote-${id}` })),
  );
  return { ...fixture, batches, singles, overrides, ids };
}

describe("R2-7 executor pre-images and undo diffs are batched", () => {
  it("captures every pre-image in one batched read in the request's lane", async () => {
    const env = await batched();
    const action = await env.executor.submit(request("archive", { emailIds: env.ids }));
    expect(action.status).toBe("executed");
    expect(env.batches).toEqual([
      { ids: env.ids, opts: { fresh: true, includeBodies: false, lane: "arrivals" } },
    ]);
    expect(env.singles).toEqual([]);
  });

  it("fails closed when a pre-image could not be confirmed with the provider", async () => {
    const env = await batched();
    const cached = await env.store.emails.get("e2");
    env.overrides.set("e2", { ...cached!, staleAsOf: null });
    await expect(
      env.executor.submit(request("archive", { emailIds: env.ids })),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(env.mail.changes).toEqual([]);
  });

  it("undoes the messages that still exist and skips the ones that are gone", async () => {
    const env = await batched();
    const action = await env.executor.submit(request("archive", { emailIds: env.ids }));
    env.overrides.set("e3", null);
    env.batches.length = 0;
    const undone = await env.executor.undo(action.id);
    expect(undone.status).toBe("undone");
    expect(env.batches).toHaveLength(1);
    expect(env.batches[0]?.opts).toMatchObject({ fresh: true, lane: "interactive" });
    const inverse = (await env.store.actions.query({})).items.find((item) => item.id !== action.id);
    expect(inverse?.result).toMatchObject({ emailIds: ["email", "e2"], skippedEmailIds: ["e3"] });
    expect((await env.store.emails.get("e2"))?.mailboxIds).toEqual(["inbox", "tag"]);
  });

  it("fails the undo when a message it must restore cannot be read from the provider", async () => {
    const env = await batched();
    const action = await env.executor.submit(request("archive", { emailIds: env.ids }));
    const cached = await env.store.emails.get("e2");
    env.overrides.set("e2", { ...cached!, staleAsOf: "2026-10-20T00:00:00.000Z" });
    await expect(env.executor.undo(action.id)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
    });
  });
});
