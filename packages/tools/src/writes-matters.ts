/**
 * Matter and person writes: `create_matter`, `update_matter`, `attach_to_matter`,
 * `update_person` and `notes_write`. Every write is an `ActionRecord` through the executor;
 * knowledge-only writes (notes, refs, watch) are low risk and undo to the prior content.
 */
import { appendNoteLine, datedNoteLine, NOTES_MAX_LENGTH } from "@passport/types";
import type { Context } from "./context.js";
import { personFor } from "./notes.js";
import { required, ToolError, writeResult } from "./presentation.js";
import { register } from "./register.js";
import { schema as z } from "./schema.js";
import * as s from "./schemas.js";

const normalize = (email: string) => email.trim().toLowerCase();
/** Invisible marks `neutralize` adds to tool output; never persisted back into notes. */
const NEUTRALIZED = /\u200B/g;
const DATED_LINE = /^- \d{4}-\d{2}-\d{2}: /;

/** The account a knowledge write is logged under: explicit, the matter's newest ref, or the first. */
async function noteAccount(ctx: Context, accountId: string | undefined, refAccount?: string) {
  if (accountId) {
    return (await ctx.account(accountId)).id;
  }
  const accounts = await ctx.accounts();
  const account = accounts.find((item) => item.id === refAccount) ?? accounts[0];
  if (!account) {
    throw new ToolError("ACCOUNT_REQUIRED", "Connect an account before writing notes.");
  }
  return account.id;
}

export function registerMatterWrites(ctx: Context) {
  const { store } = ctx;
  async function validateAttachments(
    input: { emailIds?: string[]; eventIds?: string[]; personIds?: string[] },
    accountId: string,
  ) {
    if (input.emailIds?.length) {
      await ctx.emailBatch(input.emailIds, accountId);
    }
    for (const id of input.eventIds ?? []) {
      const event = required(await store.events.get(id), "Event");
      if (event.accountId !== accountId) {
        throw new ToolError("ACCOUNT_MISMATCH", "Attached event belongs to another account.");
      }
    }
    for (const id of input.personIds ?? []) {
      required(await store.people.get(id), "Person");
    }
  }
  register(
    ctx,
    "create_matter",
    "Create a living workspace under policy. accountId is required when multiple accounts exist. Attached emails become provider refs; notes holds markdown knowledge and watch a saved query triage checks on arrival.",
    {
      accountId: s.id.optional(),
      category: s.category
        .optional()
        .describe("Arrival triage classification; used only by the built-in arrival run."),
      matter: z.strictObject({
        ...s.matterFields,
        summary: s.matterFields.summary.default(""),
        status: s.matterStatus.default("active"),
        personIds: s.matterFields.personIds.default([]),
        emailIds: s.matterFields.emailIds.default([]),
        eventIds: s.matterFields.eventIds.default([]),
      }),
      reason: s.reason,
    },
    true,
    async ({ accountId, matter, reason }, ctx) => {
      const account = await ctx.account(accountId);
      await validateAttachments(matter, account.id);
      const params = {
        matter,
        ...(ctx.actor().kind === "agent" && ctx.callContext.emailPatch
          ? { emailPatch: ctx.callContext.emailPatch }
          : {}),
      };
      return writeResult(
        await ctx.submit("matter_create", account.id, params, reason, {
          personIds: matter.personIds,
        }),
      );
    },
  );
  register(
    ctx,
    "update_matter",
    "Patch a matter's user-editable fields under policy, including notes, refs and watch. IDs and timestamps cannot be changed. A notes/refs/watch-only patch undoes to the prior content.",
    {
      accountId: s.id.optional(),
      matterId: s.id,
      patch: s.matterPatch,
      reason: s.reason,
    },
    true,
    async ({ accountId, matterId, patch, reason }, ctx) => {
      required(await store.matters.get(matterId), "Matter");
      const account = await ctx.account(accountId);
      await validateAttachments(patch, account.id);
      return writeResult(
        await ctx.submit("matter_update", account.id, { matterId, patch }, reason, {
          matterId,
          personIds: patch.personIds,
        }),
      );
    },
  );
  register(
    ctx,
    "attach_to_matter",
    "Attach emails (handles or ids), events or people to a matter through an audited action. Each email is stored as a provider ref (account, providerId, Message-ID, thread, date, subject) that survives cache eviction. Provide at least one attachment.",
    {
      accountId: s.id.optional(),
      category: s.category
        .optional()
        .describe("Arrival triage classification; used only by the built-in arrival run."),
      matterId: s.id,
      emailIds: s.ids.optional(),
      eventIds: s.ids.optional(),
      personIds: s.ids.optional(),
      reason: s.reason,
    },
    true,
    async ({ accountId, matterId, emailIds, eventIds, personIds, reason }, ctx) => {
      required(await store.matters.get(matterId), "Matter");
      if (!emailIds && !eventIds && !personIds) {
        throw new ToolError("INVALID_INPUT", "Provide emailIds, eventIds or personIds.");
      }
      const account = await ctx.account(
        accountId ?? (emailIds ? (await ctx.email(emailIds[0]!)).accountId : undefined),
      );
      await validateAttachments({ emailIds, eventIds, personIds }, account.id);
      const params = {
        matterId,
        emailIds,
        eventIds,
        personIds,
        ...(ctx.actor().kind === "agent" && ctx.callContext.emailPatch
          ? { emailPatch: ctx.callContext.emailPatch }
          : {}),
      };
      return writeResult(
        await ctx.submit("matter_attach", account.id, params, reason, { matterId, personIds }),
      );
    },
  );
  register(
    ctx,
    "update_person",
    "Update contact notes, names, addresses or relationship through policy. Cryptographic verification, stats, IDs and timestamps are not editable.",
    {
      accountId: s.id.optional(),
      personId: s.id,
      patch: s.personPatch,
      reason: s.reason,
    },
    true,
    async ({ accountId, personId, patch, reason }, ctx) => {
      const snapshot = ctx.actor().kind === "agent" ? ctx.callContext.personSnapshot : undefined;
      if (snapshot && snapshot.id !== personId) {
        throw new ToolError("INVALID_INPUT", "Person snapshot ID mismatch.");
      }
      const person = required((await store.people.get(personId)) ?? snapshot, "Person");
      const emails = patch.emails ?? person.emails;
      if (
        !emails.some(
          (email) => normalize(email) === normalize(patch.primaryEmail ?? person.primaryEmail),
        )
      ) {
        throw new ToolError("INVALID_INPUT", "primaryEmail must be included in emails.");
      }
      const account = await ctx.account(accountId);
      return writeResult(
        await ctx.submit(
          "person_update",
          account.id,
          { personId, patch: snapshot ?? patch },
          reason,
          { personIds: [personId] },
        ),
      );
    },
  );
  register(
    ctx,
    "notes_write",
    'Write a person\'s or matter\'s markdown notes under policy (category matters, low risk, undo restores the prior notes). mode "append" adds one dated log line ("- 2026-10-20: …"); "replace" rewrites the whole body. Security state (relationship, verification, stats) is never written here.',
    {
      kind: z.enum(["person", "matter"]),
      id: s.id.describe("Person or matter id."),
      notes: s.notes,
      mode: z.enum(["replace", "append"]).default("append"),
      accountId: s.id.optional().describe("Account the action is logged under; default inferred."),
      reason: s.reason,
    },
    true,
    async ({ kind, id, notes, mode, accountId, reason }, call) => {
      const text = notes.replace(NEUTRALIZED, "");
      const next = (current: string | null | undefined) => {
        if (mode === "replace") {
          return text;
        }
        if (!text.trim()) {
          throw new ToolError("INVALID_INPUT", "Provide the line to append.");
        }
        const line = DATED_LINE.test(text.trim())
          ? text.trim().replace(/\s+/g, " ")
          : datedNoteLine(call.now(), text);
        return appendNoteLine(current, line);
      };
      if (kind === "person") {
        const person = await personFor(call, { id });
        const value = next(person.notes);
        if (value.length > NOTES_MAX_LENGTH) {
          throw new ToolError("INVALID_INPUT", `Notes exceed ${NOTES_MAX_LENGTH} characters.`);
        }
        return writeResult(
          await call.submit(
            "person_update",
            await noteAccount(call, accountId),
            { personId: person.id, patch: { notes: value } },
            reason,
            { personIds: [person.id] },
          ),
        );
      }
      const matter = required(await store.matters.get(id), "Matter");
      const value = next(matter.notes);
      if (value.length > NOTES_MAX_LENGTH) {
        throw new ToolError("INVALID_INPUT", `Notes exceed ${NOTES_MAX_LENGTH} characters.`);
      }
      return writeResult(
        await call.submit(
          "matter_update",
          await noteAccount(call, accountId, matter.refs?.at(-1)?.account),
          { matterId: matter.id, patch: { notes: value } },
          reason,
          { matterId: matter.id },
        ),
      );
    },
  );
}
