# @passport/policy

The policy gate for Passport mutations: evaluate risk and trust, queue human decisions,
hold outward-facing messages, execute through injected providers, patch the local cache after
successful changes, and undo from captured prior state. Depends only on `@passport/types` and Node built-ins.

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
The executor accepts `fetch?: typeof globalThis.fetch` and `resolveDns?` for unsubscribe
HTTP requests. Defaults are global fetch and `dns.promises.lookup(host, { all: true })`.
Tests inject both collaborators and never perform network or DNS requests.

## Decision matrix

The effective level is `min(globalMode, pinnedLevel ?? earnedLevel)`, additionally capped by
`externalAgentCeiling` for external agents. Human actors follow the same matrix when submitting;
approval/rejection/undo are explicit human operations that the caller must authorize.

| Effective level | Reversible | Delayed | Irreversible |
| --- | --- | --- | --- |
| `supervised` | ask; allow internal work in matters/triage | ask | ask |
| `auto_accept_edits` | allow unless alwaysAsk | ask | ask |
| `auto` | allow unless alwaysAsk | hold at trusted/autonomous; otherwise ask | allow only at autonomous with risk ≤ medium; otherwise ask |
| `full_access` | allow unless alwaysAsk | hold unless alwaysAsk | allow unless critical risk or alwaysAsk; otherwise ask |

Internal work means `matter_create`, `matter_update`, `matter_attach`, `person_update`, or
`snooze`; an archive marked triage still needs approval when supervised. Categories in
`alwaysAsk` require approval for every action, including reversible delete/archive and draft
edits, at every level. Internal bookkeeping (`matter_*`, `person_update`, `snooze`) is exempt from alwaysAsk
and follows the normal matrix. All label/unlabel operations in an always-ask category
require approval. Editing or deleting a draft referenced by a held
send always asks, even at full access.
External agents are always denied `delete`, `unsubscribe`, `calendar_delete`, and
mailbox mutations carrying the shared registry's trusted `destructive` flag.
Destructive mail mutations have at least medium risk and are not bookkeeping.
Self-address/relationship changes and assignments always ask and are denied
externally; known-person address additions always ask. The executor alone sets
`Person.verifiedSelf` after execution of a human-approved self action. Derived
verification cannot be forged by an action patch. Downgrade acknowledgements
always ask and are denied externally.
An external ceiling of supervised denies all non-reversible external actions.
Explicit deny takes precedence over the matrix and alwaysAsk.

Risk starts at `BASE_RISK` and increases one step for strangers; send and calendar actions to
strangers add another step. Deleting any flagged or unread email adds one step, as does
unsubscribe. Risk saturates at critical. Reversibility starts at `BASE_REVERSIBILITY`.
Counterparty classification uses known person identities/relationships and trusted verification
fields; it never inspects message bodies or upgrades verification. The caller must supply
authentic actor identity and counterparty classification rather than trusting client claims.

The additive `profile_update` category always asks for approval, including at full access;
legacy profile actions in `matters` remain readable. A learned whole-profile proposal keeps
USER.md untouched until approval and captures the profile at execution for undo.

`DraftEditingExecutor.editDraft(actionId, textBody)` saves only the pending draft text (clearing
stale HTML) under the executor’s serial approval lock. If a decision already won it returns
`ACTION_DECIDED`. It preserves the first agent draft across repeated saves/restarts; later
approval computes edit distance against that original and records `approved_edited` feedback.

The host can inject a per-request `ceiling`. Task runs use the minimum of their starting
ceiling and the current task/ancestor mode, consulted on each policy decision; lowering reaches
an active run; authority cannot rise above the starting ceiling until a new run.

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
- Approval, rejection, release, cancellation, and undo use optional `Store.actions.claim`
  to atomically change the source status to executing before any dispatch or feedback. The
  SQLite implementation uses a conditional UPDATE returning the changed row, so independent
  executors/processes sharing a database cannot release or approve the same action twice.
  Undo claims the original executed action before creating its inverse record. Stores without
  this method fail these transitions with `ACTION_CLAIM_UNSUPPORTED`; there is no unsafe fallback.
- Labels resolve existing mailboxes by local id, provider id, or name. Missing
  labels on label-capable accounts are created through optional
  `MailProvider.createMailbox`, in the same action, with IDs recorded in the
  inverse snapshot. Undo restores message membership and retains the created
  label. Folder-only providers do not auto-create triage labels. For accounts with labels,
  archive removes inbox and adds an archive mailbox when present. Folder accounts archive by
  moving to the archive-role mailbox, then the all-role mailbox, then a folder named Archive;
  missing destinations fail with `ARCHIVE_MAILBOX_MISSING` before changing mail. Folder unarchive
  moves to the requested mailbox or inbox, and undo moves each message to its captured prior folder.
  Move replaces mailbox membership. Delete moves to trash; it never purges. Mail changes map local
  ids to provider ids and patch the cached keywords and mailboxes only after provider success.
  IMAP and Graph report replacement identities through `MailChangeResult`; moves persist the
  new provider id in both the local email and its inverse snapshot. Undo uses the current id
  and persists any replacement returned by the reverse move. Copies retain the source identity.
- Drafts use create/update/deleteDraft. At approval/hold time, send and calendar proposals
  save resolved recipients, subject, bodies, and attachment blob ids in `approvedSnapshot` on
  the action record, preserving the original request params. Release rereads the draft and
  compares it to the snapshot. Changed/missing drafts (and legacy holds without snapshots)
  return to proposed with `DRAFT_CHANGED_SINCE_APPROVAL` and emit `action.proposed`; no mail
  leaves until reapproval creates a fresh snapshot and hold. Feedback is counted once per record.
  Saved draft sends submit the approved content, then remove the original provider draft,
  preventing a concurrent draft edit from replacing the authorized content. Saved reply drafts
  resolve their In-Reply-To message within the stored thread to retain threading; an unavailable
  reply source must be readable from the provider before approval. Calendar
  proposals send their supplied draft through the outbox; slots are context, not automatically
  converted to an iCalendar attachment. Event create/update/respond/delete use CalendarProvider
  and cache the result. Sent mail is fetched through `getEmail`; if a provider cannot expose
  the sent email yet, the action retains SendResult and the email is read on demand later.
- Matters, people, and snooze use only Store. Email snooze state is under
  `policy:snooze:<emailId>` because Email has no snooze field. Matter snooze updates
  status/snoozedUntil. Matter attachments update the matter and email/event backlinks.
  Partial person patches cannot edit verification; only humans can change relationships
  through partial patches. Complete person snapshots follow the agent convention below.
- Exact inverse snapshots are computed immediately before execution, persisted in
  `ActionRecord.inverse.params.__passportPolicyInverse`, and interpreted by the same dispatch.
  Treat inverses as opaque executor data: submit/approve reject this private field. No shared
  action types were changed. Deleted drafts are recreated with their prior local id and a new provider id.
  `undo(id)` retains the authenticated human API behavior. Tool callers pass
  `undo(id,{actor,reason})` so the executor evaluates the current actor and ceiling.
  Below effective full access, external agents may undo only their own external
  actor IDs; destructive or protected identity restores remain denied. Proposed
  undos persist their original-action reference under `policy:undo:<inverseId>`
  for later human approval. Undo creates its own ActionRecord before dispatch and
  then marks the original undone. Private inverse snapshots cannot be edited.
- Every action domain event is emitted: proposed, decided, held, executed, undone, failed.
  Cache patches also emit email.updated and matter.updated. `PolicyError` has a `code`;
  provider errors are persisted as failed and rethrown unchanged, except `SUBMISSION_ACCEPTED`:
  SMTP already accepted that message, so the send is executed with `result.warning` and is
  never retried. Sent-copy/local draft cleanup failures after a successful send also become warnings.
- Each executor serializes its own operations; Store claims coordinate independent writers.
  Claims are not automatically recovered after a process crash because a provider may already
  have accepted an operation. There is no provider idempotency interface. A provider-success /
  local-write failure can leave a partial remote change; re-read the message from the provider
  before retrying.
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

Shared additions are optional `ActionRecord.approvedSnapshot`, optional `Store.actions.claim`,
and `MailChangeResult` with a widened `MailProvider.applyChanges` result. The review
fixes append optional Person identity/downgrade fields, ActionRequest.destructive,
MailProvider.createMailbox, and optional actor/reason context on undo. Existing
void-returning providers and one-argument human undo callers remain compatible.

## Unsubscribe

`unsubscribe` loads the source email with bodies and uses its normalized List-Unsubscribe
and List-Unsubscribe-Post headers. Header parsing is local to policy to preserve the
types-only dependency boundary. Prefer `method: 'header'`:

- `header`: when List-Unsubscribe-Post contains `List-Unsubscribe=One-Click` and an HTTPS
  target exists, POST `List-Unsubscribe=One-Click` with content type
  `application/x-www-form-urlencoded`. Otherwise send to the header's mailto address using
  its decoded subject/body query fields, each defaulting to `unsubscribe` when absent.
- `link`: GET the first valid HTTPS target from List-Unsubscribe. Use this explicitly when
  one-click and mailto are unavailable; body links are never inferred or visited.
- `reply`: send to reply-to, falling back to from, with subject/body `unsubscribe` and
  `inReplyToEmailId` referencing the source email. Choose this only when a reply is intended.

HTTP requests and DNS resolution share a 10-second deadline across at most three redirects.
Before every request, including same-host redirects, resolve all destination addresses and
reject the entire set if any is loopback, private, link-local, unspecified, multicast, or
reserved. Localhost and `.local`/`.internal` hostnames are blocked before transport, as are
mixed public/private DNS answers and unresolvable/empty answers (`UNSUBSCRIBE_TARGET_BLOCKED`).
Only public IPv4 and global unicast IPv6 are accepted; IPv4-mapped IPv6, documentation, and
transition/reserved ranges are blocked. The default transport uses Node HTTPS `request()`
with a lookup override returning only this hop's validated addresses, a fresh connection,
hostname SNI, and certificate verification enabled. DNS rebinding cannot replace the
validated destination. An explicit `fetch` option remains available for test injection.
Each redirect must
also use HTTPS, and one-click redirects preserve POST and its form body. HTTP targets and
URLs containing credentials are unsupported. Missing targets fail with
`UNSUBSCRIBE_UNSUPPORTED`; HTTP errors, timeout, network failure, and excess redirects also
persist a failed action and emit action.failed. HTTP errors expose only the host and status,
never token-bearing URL queries or response bodies.

HTTP success records `result: { method, target, status }`, where target is the destination
host and status is the HTTP status. One-click POST and link GET run immediately when permitted.
Mailto/reply submits a child `send` action with the original actor, category `unsubscribe`, and
a reason referencing the parent id. Child sends follow policy approval and the normal outbox
hold. The parent remains executing with `result: { method, target, status: 'pending', childActionId }`
until the child executes, then becomes executed with status `sent`. Child failures/rejections/
cancellations propagate to the parent; accepted SMTP warnings also propagate. The durable
parent/child link lets any executor settle the parent when releasing the child. Unsubscribe
is irreversible (`inverse: null`) and retains its existing base risk. It creates no mailbox
changes; the agent must separately decide whether to archive.
All ActionTypes are implemented; there are no stubbed production paths.

## Validation

```sh
pnpm --filter @passport/types build
pnpm --filter @passport/policy typecheck
pnpm --filter @passport/policy test
pnpm --filter @passport/policy build
```

Tests use the exported in-memory Store/EventBus and recording mail/calendar fakes; no network.

Always-ask categories require approval for label/unlabel as well as archive and other mail
edits; internal matter/person bookkeeping retains its existing exemption. USER.md inverses
capture `getEffectiveProfile(store)` from `@passport/types`, so the first edit restores the
complete default template on undo.

## Known limitations

- **R2-14** The policy computes destructive risk (unread / flagged) from the cached row before the
  executor takes its fresh pre-image, and does not re-evaluate afterwards. Only the risk label and the
  `irreversible && riskIndex <= 1` auto path are affected; fixing it means capturing before evaluating.
- **R2-16** Undo diffs the whole pre-image against current provider state. A label the user added
  out of band after the action is removed by undo, and an adapter mailbox id the label cache has not
  seen yet fails the undo with `MAILBOX_NOT_FOUND`. Limiting the diff to what the action changed needs
  a post-image in the inverse.
- **R2-21** Inverses written by v0.2 still hold full `Email` bodies in `actions.data`; no migration
  scrubs them. Only actions created by v0.3 have body-free pre-images.
