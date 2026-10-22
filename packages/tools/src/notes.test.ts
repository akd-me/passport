import type { MailRef } from "@passport/types";
import { describe, expect, it } from "vitest";
import { NOTES_UNTRUSTED_NOTICE } from "./notes.js";
import * as f from "./testing/fixtures.js";
import { onDemandHarness } from "./testing/ondemand.js";

const sam = f.person({
  id: "person-sam",
  displayName: "Sam $Rivera",
  emails: ["sam@example.com"],
  primaryEmail: "sam@example.com",
  notes: "Runs the design review.\n- 2026-01-16: sent invitations",
});
const ref = (providerId: string, patch: Partial<MailRef> = {}): MailRef => ({
  account: "account-1",
  providerId,
  rfc822Id: `<${providerId}@mock.passport>`,
  date: "2026-01-16T22:00:00.000Z",
  subject: "Invitation: Design review 3",
  ...patch,
});

describe("notes_read / notes_search", () => {
  it("renders a person's security state as a header and the notes as the body", async () => {
    const { call, store } = await onDemandHarness();
    await store.people.upsert(sam);
    const result = await call("notes_read", { kind: "person", email: "sam@example.com" });
    expect(result).toMatchObject({
      kind: "person",
      id: "person-sam",
      fields: {
        displayName: "Sam $​Rivera",
        relationship: "known",
        verification: "green",
        verifiedSelf: null,
        lastSeenBlueAt: null,
        stats: { sent: 3, received: 5 },
      },
      notes: sam.notes,
      source: "cache",
      untrusted: NOTES_UNTRUSTED_NOTICE,
    });
    const markdown = result.markdown as string;
    expect(markdown.startsWith("---\n# relationship, verification")).toBe(true);
    expect(markdown).toContain('relationship: "known"');
    expect(markdown.endsWith("---\nRuns the design review.\n- 2026-01-16: sent invitations")).toBe(
      true,
    );
    expect(await call("notes_read", { kind: "person", id: "x", email: "a@b.c" })).toMatchObject({
      isError: true,
      error: "INVALID_INPUT",
    });
  });

  it("renders a matter header with refs (newest first), watch and notes", async () => {
    const { call, store } = await onDemandHarness();
    await store.people.upsert(sam);
    await store.matters.upsert(
      f.matter({
        personIds: ["person-sam"],
        notes: "## Next step\nConfirm the room.",
        watch: "from:sam@example.com newer_than:30d",
        refs: [ref("fixture-36", { date: "2026-01-16T20:00:00.000Z" }), ref("fixture-38")],
      }),
    );
    const result = await call("notes_read", { kind: "matter", matterId: "matter-1" });
    expect(result.fields).toMatchObject({
      title: "Launch",
      people: ["sam@example.com"],
      watch: "from:sam@example.com newer_than:30d",
      refsTotal: 2,
      refs: [
        { id: "account-1:email:fixture-38", date: "2026-01-16T22:00:00.000Z" },
        { id: "account-1:email:fixture-36" },
      ],
    });
    expect(result.notes).toBe("## Next step\nConfirm the room.");
  });

  it("searches names, addresses and notes by substring or regular expression", async () => {
    const { call, store } = await onDemandHarness();
    await store.people.upsert(sam);
    await store.matters.upsert(f.matter({ notes: "- 2026-01-17: Sam confirmed" }));
    const substring = await call("notes_search", { pattern: "design review" });
    expect(substring.items).toEqual([
      expect.objectContaining({ kind: "person", id: "person-sam", field: "notes" }),
    ]);
    const regex = await call("notes_search", {
      pattern: "^- 2026-01-1\\d: sam",
      regex: true,
      kind: "matter",
    });
    expect(regex.items).toEqual([
      expect.objectContaining({
        kind: "matter",
        id: "matter-1",
        snippet: "- 2026-01-17: Sam confirmed",
      }),
    ]);
  });
});

describe("notes_write", () => {
  it("appends a dated line as a person_update notes patch", async () => {
    const { call, store, executor } = await onDemandHarness();
    await store.people.upsert(sam);
    const result = await call("notes_write", {
      kind: "person",
      id: "person-sam",
      notes: "asked for the​ $​budget  by Friday",
      reason: "Record the request",
    });
    expect(result).toMatchObject({ actionId: expect.any(String) });
    expect(executor.submitted[0]).toMatchObject({
      type: "person_update",
      accountId: "account-1",
      category: "matters",
      params: {
        personId: "person-sam",
        patch: { notes: `${sam.notes}\n- 2026-10-20: asked for the $budget by Friday` },
      },
    });
  });

  it("replaces matter notes and keeps an already dated line as written", async () => {
    const { call, store, executor } = await onDemandHarness();
    await store.matters.upsert(f.matter({ notes: "old" }));
    await call("notes_write", {
      kind: "matter",
      id: "matter-1",
      notes: "## Where things stand\nWaiting on Sam.",
      mode: "replace",
      reason: "Rewrite",
    });
    await call("notes_write", {
      kind: "matter",
      id: "matter-1",
      notes: "- 2026-01-17: Sam confirmed",
      reason: "Log",
    });
    expect(executor.submitted.map((request) => request.params)).toEqual([
      { matterId: "matter-1", patch: { notes: "## Where things stand\nWaiting on Sam." } },
      { matterId: "matter-1", patch: { notes: "old\n- 2026-01-17: Sam confirmed" } },
    ]);
    expect(executor.submitted[0]).toMatchObject({ type: "matter_update", category: "matters" });
  });
});

describe("people_lookup", () => {
  it("combines security state, notes and provider evidence with its cost", async () => {
    const { call, store } = await onDemandHarness();
    await store.people.upsert(sam);
    const result = await call("people_lookup", { query: "sam@example.com" });
    expect(result).toMatchObject({
      person: { id: "person-sam", relationship: "known", verification: "green" },
      notes: sam.notes,
      evidence: {
        received: 3,
        receivedCapped: true,
        sentEver: false,
        newest: { id: "account-1:email:fixture-38", from: "Sam Rivera <sam@example.com>" },
      },
      source: "provider",
      cost: { gmailUnits: expect.any(Number) },
      untrusted: NOTES_UNTRUSTED_NOTICE,
    });
    expect(result.cost).toMatchObject({ gmailUnits: expect.any(Number) });
  });

  it("finds a person by name and reports cached state without a reader", async () => {
    const { call, store } = await onDemandHarness({ noReaders: true });
    await store.people.upsert(sam);
    expect(await call("people_lookup", { query: "rivera" })).toMatchObject({
      person: { id: "person-sam", stats: { sent: 3, received: 5 } },
      evidence: null,
      evidenceUnavailable: expect.any(String),
      source: "cache",
    });
    expect(await call("people_lookup", { query: "nobody@example.com" })).toMatchObject({
      person: null,
      evidence: null,
    });
  });
});

describe("matters with refs", () => {
  it("get_matter resolves refs lazily to rows and keeps unresolvable refs", async () => {
    const { call, store } = await onDemandHarness();
    await store.matters.upsert(
      f.matter({
        emailIds: [],
        eventIds: [],
        personIds: [],
        notes: "## Log",
        refs: [ref("fixture-38"), ref("gone", { date: "2026-01-01T00:00:00.000Z" })],
      }),
    );
    const result = await call("get_matter", { matterId: "matter-1" });
    expect(result.matter).toMatchObject({ notes: "## Log" });
    expect(result.matter).not.toHaveProperty("refs");
    expect(result).toMatchObject({
      refsTotal: 2,
      refs: [
        {
          id: "account-1:email:fixture-38",
          row: { id: "account-1:email:fixture-38", subject: "Invitation: Design review 3" },
        },
        { id: "account-1:email:gone", subject: "Invitation: Design review 3", row: null },
      ],
    });
  });

  it("create_matter and update_matter accept notes, refs and watch; attach takes handles", async () => {
    const { call, store, executor } = await onDemandHarness();
    await store.matters.upsert(f.matter({ emailIds: [], eventIds: [], personIds: [] }));
    await call("create_matter", {
      matter: { title: "Design review", notes: "## Log", watch: "from:sam@example.com" },
      reason: "Track it",
    });
    await call("update_matter", {
      matterId: "matter-1",
      patch: { refs: [ref("fixture-38")], watch: null },
      reason: "Refs",
    });
    await call("attach_to_matter", {
      matterId: "matter-1",
      emailIds: ["account-1:email:fixture-37"],
      reason: "Attach",
    });
    expect(executor.submitted.map((request) => [request.type, request.params])).toEqual([
      [
        "matter_create",
        {
          matter: expect.objectContaining({ notes: "## Log", watch: "from:sam@example.com" }),
        },
      ],
      [
        "matter_update",
        { matterId: "matter-1", patch: { refs: [ref("fixture-38")], watch: null } },
      ],
      [
        "matter_attach",
        expect.objectContaining({ matterId: "matter-1", emailIds: ["account-1:email:fixture-37"] }),
      ],
    ]);
  });
});
