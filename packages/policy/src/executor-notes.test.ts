import type { MailRef } from "@passport/types";
import { describe, expect, it } from "vitest";
import { at, email, matter, person, request, setup } from "./testing/fixtures.js";

const ref = (providerId: string): MailRef => ({
  account: "account",
  providerId,
  rfc822Id: null,
  date: at,
  subject: "Lease",
});

describe("knowledge writes (notes, refs, watch)", () => {
  it("inverts a person notes write to the prior notes without rolling back security state", async () => {
    const { executor, store } = await setup();
    await store.people.upsert(person({ notes: "Leasing manager." }));
    const written = await executor.submit(
      request(
        "person_update",
        { personId: "person", patch: { notes: "Leasing manager.\n- 2026-10-20: sent PDF" } },
        { category: "matters" },
      ),
    );
    expect(written).toMatchObject({
      status: "executed",
      decision: { risk: "low", reversibility: "reversible" },
      inverse: {
        type: "person_update",
        params: { personId: "person", patch: { notes: "Leasing manager." } },
      },
    });
    // Security state written after the notes (e.g. by an arrival) survives the undo.
    const current = (await store.people.get("person"))!;
    await store.people.upsert({ ...current, lastSeenBlueAt: "2026-10-21T00:00:00.000Z" });
    expect((await executor.undo(written.id)).status).toBe("undone");
    expect(await store.people.get("person")).toMatchObject({
      notes: "Leasing manager.",
      lastSeenBlueAt: "2026-10-21T00:00:00.000Z",
    });
  });

  it("inverts matter notes, refs and watch to their prior values and keeps later status changes", async () => {
    const { executor, store } = await setup();
    await store.matters.upsert(matter({ notes: "old", refs: [ref("p1")] }));
    const written = await executor.submit(
      request(
        "matter_update",
        {
          matterId: "matter",
          patch: { notes: "new", refs: [ref("p1"), ref("p2")], watch: "from:dana@acme.com" },
        },
        { category: "matters" },
      ),
    );
    expect(written.inverse?.params).toEqual({
      matterId: "matter",
      patch: { notes: "old", refs: [ref("p1")], watch: null },
    });
    expect(await store.matters.get("matter")).toMatchObject({
      notes: "new",
      refs: [ref("p1"), ref("p2")],
      watch: "from:dana@acme.com",
    });
    const current = (await store.matters.get("matter"))!;
    await store.matters.upsert({ ...current, status: "waiting" });
    await executor.undo(written.id);
    expect(await store.matters.get("matter")).toMatchObject({
      notes: "old",
      refs: [ref("p1")],
      watch: null,
      status: "waiting",
    });
  });

  it("keeps full-snapshot inverses for mixed patches", async () => {
    const { executor, store } = await setup();
    await store.matters.upsert(matter({ notes: "old" }));
    const written = await executor.submit(
      request("matter_update", { matterId: "matter", patch: { notes: "new", status: "done" } }),
    );
    expect(written.inverse?.params).toHaveProperty("__passportPolicyInverse");
    await executor.undo(written.id);
    expect(await store.matters.get("matter")).toMatchObject({ notes: "old", status: "active" });
  });

  it("writes refs from the cached envelope on attach and create, and undo drops them", async () => {
    const { executor, store } = await setup();
    await store.emails.upsertMany([
      email({
        threadId: "account:thread:t1",
        headers: { messageId: "<m@x>", inReplyTo: null, references: [] },
      }),
    ]);
    await store.matters.upsert(matter({ refs: [ref("p0")] }));
    const attached = await executor.submit(
      request("matter_attach", { matterId: "matter", emailIds: ["email"] }),
    );
    const expected: MailRef = {
      account: "account",
      providerId: "remote-email",
      rfc822Id: "<m@x>",
      threadPid: "t1",
      date: at,
      subject: "Hello",
    };
    expect((await store.matters.get("matter"))?.refs).toEqual([ref("p0"), expected]);
    expect((await store.matters.get("matter"))?.emailIds).toEqual(["email"]);
    await executor.undo(attached.id);
    expect((await store.matters.get("matter"))?.refs).toEqual([ref("p0")]);

    const created = await executor.submit(
      request("matter_create", {
        matter: {
          title: "Lease",
          summary: "",
          status: "active",
          personIds: [],
          emailIds: ["email"],
          eventIds: [],
          notes: "## Log",
          watch: "from:dana@acme.com newer_than:30d",
        },
      }),
    );
    const id = created.result?.matterId as string;
    expect(await store.matters.get(id)).toMatchObject({
      refs: [expected],
      notes: "## Log",
      watch: "from:dana@acme.com newer_than:30d",
    });
  });

  it("rejects malformed knowledge fields before execution", async () => {
    const { executor, store } = await setup();
    await store.matters.upsert(matter());
    await store.people.upsert(person());
    const bad = [
      request("matter_update", {
        matterId: "matter",
        patch: { refs: [{ account: "a" }] as never },
      }),
      request("matter_update", { matterId: "matter", patch: { watch: "x".repeat(501) } }),
      request("person_update", { personId: "person", patch: { notes: 42 as never } }),
    ];
    for (const item of bad) {
      await expect(executor.submit(item)).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    }
  });
});
