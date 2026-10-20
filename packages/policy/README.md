# @passport/policy

The policy gate for Passport mutations: evaluate risk and trust, queue human decisions,
hold outward-facing messages, execute through injected providers, mirror successful changes,
and undo from captured prior state. Depends only on `@passport/types` and Node built-ins.

## Usage

```ts
import { createPolicyEngine, createActionExecutor } from '@passport/policy';

// store, bus, and connected provider resolvers are supplied by the composition root.
const policy = createPolicyEngine({ store, bus });
const executor = createActionExecutor({
  store, bus, policy, mailProviderFor, calendarProviderFor,
});
const action = await executor.submit({
  type: 'archive', accountId, params: { emailIds: [emailId] },
  actor: { kind: 'agent', id: runId }, category: 'triage',
  reason: 'This notification needs no reply.',
});
if (action.status === 'proposed') await executor.approve(action.id);
// Scheduler entry points:
await executor.releaseDue();
await policy.applyDecay();
```

All public exports come from the package root. `createMemoryStore()` and
`createMemoryEventBus()` are reusable, isolated test fakes; the bus includes an `events` log.
The Store fake implements the complete interface, returns copies, and supports simple text
matching rather than SQLite FTS syntax. Its credentials are in-memory test data, not encrypted.
`classifyCounterparty(person, emails, selfAddresses)`, `editDistanceRatio(a, b)`, and
`describeDecision(decision)` are pure helpers. Both factories accept `now: () => Timestamp`
for deterministic ISO UTC clocks. Provider resolvers may return a provider or a Promise.

## Decision matrix

The effective level is `min(globalMode, pinnedLevel ?? earnedLevel)`, additionally capped by
`externalAgentCeiling` for external agents. Human actors follow the same matrix when submitting;
approval/rejection/undo are explicit human operations that the caller must authorize.

| Effective level | Reversible | Delayed | Irreversible |
| --- | --- | --- | --- |
| `supervised` | ask; allow internal work in matters/triage | ask | ask |
| `auto_accept_edits` | allow | ask | ask |
| `auto` | allow | hold at trusted/autonomous; otherwise ask | allow only at autonomous with risk ≤ medium; otherwise ask |
| `full_access` | allow | hold | allow unless critical risk or alwaysAsk; otherwise ask |

Internal work means `matter_create`, `matter_update`, `matter_attach`, `person_update`, or
`snooze`; an archive marked triage still needs approval when supervised. Categories in
`alwaysAsk` require approval for delayed and irreversible actions at every level.
External agents are always denied `delete`, `unsubscribe`, and `calendar_delete`.
An external ceiling of supervised denies all non-reversible external actions.
Explicit deny takes precedence over the matrix and alwaysAsk.

Risk starts at `BASE_RISK` and increases one step for strangers; send and calendar actions to
strangers add another step. Deleting any flagged or unread email adds one step, as does
unsubscribe. Risk saturates at critical. Reversibility starts at `BASE_REVERSIBILITY`.
Counterparty classification uses known person identities/relationships and trusted verification
fields; it never inspects message bodies or upgrades verification. The caller must supply
authentic actor identity and counterparty classification rather than trusting client claims.

## Trust and promotions

New categories start at score 0.3. Unchanged approvals add 0.08; edited approvals subtract
`max(0.01, 0.04 × editDistance)`; rejections subtract 0.15. Scores clamp to [0, 1].
Approvals include edited approvals; unchanged approvals are a subset. The total human decisions
used for novelty is approvals + rejections; fewer than three always means learning.

| Stage | Score (after novelty) | Earned level |
| --- | --- | --- |
| learning | < 0.5 | supervised |
| trusted | ≥ 0.5 and < 0.85 | auto_accept_edits |
| autonomous | ≥ 0.85 | auto |

Full access requires an explicit pin. Pins override the earned level, while the stage still
controls the auto row. `pinLevel(category, null)` resumes the earned level. The global dial
always caps the result. Defaults are the shared `DEFAULT_POLICY_CONFIG`.

Decay begins one whole additional day after `decayAfterDays` of inactivity, subtracting 0.02
per additional day. A KV cursor makes repeated/scheduler/restarted calls idempotent. Categories
that were autonomous have a decay floor of 0.3; decay never raises a score lowered by rejection.
Feedback resets the inactivity clock. Changes emit `trust.changed`.

At least ten approvals in the current category level, with at least 90% unchanged, qualify for
an offer to the next level if below the global dial. Evidence counters reset whenever the level
changes. Evaluation attaches the offer and emits `trust.promotion_offered` exactly once per
category/from-level, persisted across restarts; returning to a level does not offer again.
Offers never change the pin or global mode. Feedback is recorded at most once per ActionRecord.

String edit distance is Unicode-code-point Levenshtein distance divided by the longer length;
draft/send approvals compare subject plus textBody. Other actions compare the fraction of changed
JSON leaves (including added/removed leaves), independent of object key order.

## Execution and integration details

- `submit`: ask → proposed; deny → rejected with reason; allow → execution;
  delayed work → held when `outboxHoldMinutes > 0`. Approved sends are held too.
  A zero hold setting executes permitted delayed actions immediately.
- `approve`/`reject` accept only proposed actions. Approval edits preserve type, account,
  actor, and category, re-evaluate policy, and record feedback before execution. Rejection
  records negative feedback. `cancelHold` accepts only held actions and records cancellation
  as rejected; it does not treat cancellation as a trust rejection.
- `releaseDue(timestamp?)` executes due held actions, continues after individual failures,
  then rethrows the first error. Failed actions are not automatically retried. For released
  sends/calendar proposals, the persisted decision becomes irreversible and inverse is null:
  cancellation existed before release, but an executed send cannot be undone.
- Labels resolve existing mailboxes by local id, provider id, or name. Archive removes inbox
  and adds an archive mailbox when present. Move replaces mailbox membership. Delete moves to
  trash; it never purges. Mail changes map local ids to provider ids and mirror full keyword
  and mailbox patches only after provider success.
- Drafts use create/update/deleteDraft; `send` resolves draft ids before sending. Calendar
  proposals send their supplied draft through the outbox; slots are context, not automatically
  converted to an iCalendar attachment. Event create/update/respond/delete use CalendarProvider
  and mirror the result. Sent mail is fetched through `getEmail`; if a provider cannot expose
  the sent email yet, the action retains SendResult and the next normal sync imports the email.
- Matters, people, and snooze use only Store. Email snooze state is under
  `policy:snooze:<emailId>` because Email has no snooze field. Matter snooze updates
  status/snoozedUntil. Matter attachments update the matter and email/event backlinks.
  Partial person patches cannot edit verification; only humans can change relationships
  through partial patches. Complete person snapshots follow the agent convention below.
- Exact inverse snapshots are computed immediately before execution, persisted in
  `ActionRecord.inverse.params.__passportPolicyInverse`, and interpreted by the same dispatch.
  Treat inverses as opaque executor data: submit/approve reject this private field. No shared
  action types were changed. Deleted drafts are recreated with their prior local id and a new provider id.
  Undo creates its own ActionRecord before dispatch and then marks the original undone.
- Every action domain event is emitted: proposed, decided, held, executed, undone, failed.
  Mirror changes also emit email.updated and matter.updated. `PolicyError` has a `code`;
  provider errors are persisted as failed and rethrown unchanged.
- Use one executor and policy engine per Store in the composition root. Each serializes its
  writes so concurrent approve/release/cancel calls cannot dispatch an action twice. The Store
  contract has no transaction/CAS or provider idempotency interface: crash recovery and multiple
  independent writer processes require integration-level coordination. A provider-success /
  local-write failure can leave a partial remote change; reconcile through sync before retrying.
  IDs are locally generated ULIDs because the injected Store interface exposes no id allocator.

## Agent conventions honoured

- `person_update` accepts a complete `Person` snapshot with `patch.id === personId` from
  authenticated agent/human callers, including inferred relationships and verification.
  Existing people retain their identity/creation time; undo restores the exact prior snapshot.
  Missing people require a complete patch and `Store.people.delete` so undo removes the person
  and its email/matter joins. Stores without that optional method still support updates and
  snapshot restoration; creation fails before mutation because no prior snapshot exists.
  External agents retain the identity-edit restrictions. The composition root must authenticate
  actors and supply verification derived from trusted headers/signatures.
- `matter_create` and `matter_attach` accept package-local
  `emailPatch: { category?, personIds? }`. Initial/attached emails receive `matterId` plus the
  supplied metadata; omitted fields are preserved. Creation returns both `result.matterId`
  and `result.matter`. Per-email prior matter/category/people metadata is captured before
  the matter upsert, persisted in the inverse, and restored on undo without reverting later
  mailbox/keyword edits. Writes share one logged, serialized action; failures compensate
  from its snapshot because Store has no cross-repository transaction API.

The shared contract only appends optional `Store.people.delete?(id: Id): Promise<void>`;
`ActionParams` and the agent package remain unchanged.

## Explicit unsupported operation

`unsubscribe` is evaluated and logged, but execution throws `NotImplementedError`
(`code: NOT_IMPLEMENTED`), persists failed, and emits action.failed. MailProvider has no
unsubscribe capability for header/link/reply methods. Adding that provider capability is an
integration follow-up; this package performs no implicit HTTP requests. All other ActionTypes
are implemented. There are no other stubbed production paths.

## Validation

```sh
pnpm --filter @passport/types build
pnpm --filter @passport/policy typecheck
pnpm --filter @passport/policy test
pnpm --filter @passport/policy build
```

Tests use the exported in-memory Store/EventBus and recording mail/calendar fakes; no network.
