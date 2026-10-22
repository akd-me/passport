# Passport audit: everything that assumes a fully ingested local mirror

Repo: `/Volumes/FastBoy/passport` @ `24e5da7` (main, clean). Read-only audit, 2026-10-22.
All paths are repo-relative. Line numbers are from this commit.

---

## 0. Headline findings

1. **The initial sync treats every historical message as a new arrival.** `SyncService` marks a message
   as an arrival when it is not yet stored locally and has no `sync-seen` key
   (`apps/server/src/sync/index.ts:210-220`). `isArrival` excludes only drafts, Sent, and self-sent mail
   outside the Inbox (`apps/server/src/sync/identity.ts:106-133`). So on first connect, every in-window
   message from someone else becomes an arrival: Inbox, archived "All Mail", **Spam and Trash too**
   (Gmail lists with `includeSpamTrash=true`, `packages/providers/src/gmail.ts:324`). Each arrival
   queues a full LLM triage run. A test asserts this: a first sync of 40 fixtures emits 40
   `email.received` (`apps/server/src/sync/index.test.ts:84`). Backfill does the same for every
   newly seen older message.
2. **"Processing the past year" is LLM triage, not ingestion.** For roughly 20k messages, ingestion
   alone takes about 1–3 h of strictly sequential Gmail calls (~20.5k requests, ~102k quota units).
   Triage is the larger cost: about 2–3 host-CLI LLM calls per message, through a single global
   serialized queue. That is roughly 15–18k arrivals × ~10–30 s each, or **2–6 days of continuous
   inference**. It also produces tens of thousands of ActionRecords and proposals about year-old mail.
3. **The string "past year" does not exist in the code.** The default window is 30 days
   (`apps/server/src/config.ts:51`, `apps/server/src/onboarding/config.ts:4`). A year comes either from
   `sync.initialDays` in config or from **Settings › Accounts › Load older mail**, whose input defaults
   to **365** (`apps/web/src/accounts/AccountRow.tsx:44`). I could not see the owner's live config
   (`~/.passport` has no config or DB file).
4. **Every read path depends on the mirror.** That covers all MCP/agent read tools, the HTTP routes,
   the web UI, and the policy executor. The `MailProvider` interface has **no search, list, thread or
   label-list method**. The only on-demand reads are `getEmail(providerId)` and `getBlob(blobId)`.
   Write tools and the executor accept only local ULIDs and reject anything not in the store
   (`EMAIL_NOT_FOUND`).
5. **Relationship and trust classification depend on how much history is mirrored.** `resolvePeople`
   scans every stored email on each arrival to decide `known` vs `stranger`
   (`packages/agent/src/people.ts:46-50,154-169`). That class feeds the policy counterparty. A short
   window turns long-time contacts into strangers.
6. **The agent queue is globally serialized.** Triage, digest, matter review, user routines and the
   **composer** all run through one queue (`apps/server/src/compose.ts:316-322`;
   `packages/agent/src/runtime.ts:46-55`). During a backlog, a user's composer instruction waits
   behind thousands of historical triage runs.

---

## 1. Sync pipeline

### 1.1 What happens after an account connects

**Trigger.** OAuth completes in `connectOAuthAccount`. It persists the account and its companion
calendar account, calls `updateConfig`, then for each linked account calls `accountSync.reconnect()`
and starts `backend.syncAccount(id)` without awaiting it
(`apps/server/src/onboarding/oauth-account.ts:224-235`). The manual `POST /api/accounts` route goes
through `addAccount` (`apps/server/src/accounts.ts:90-110`). The scheduler also discovers the account
through `account.synced` and `accounts.refresh` and registers `sync:<accountId>` every
`syncIntervalSeconds` (default 120 s) with a **5-minute `timeoutMs`**
(`apps/server/src/schedulers/service.ts:154-171`). A fresh job gets a boot run.

**Layering.**

| Layer | File | Role |
|---|---|---|
| `ProviderConnections` | `apps/server/src/sync/connections.ts` | One adapter per account; lazy shared `connect`; proxies every method; normalizes `getEmail`/`createDraft`/`updateDraft` results into local identity (`apps/server/src/compose.ts:122-130`). Since 24e5da7, a failure invalidates the adapter only when no other operation is active (`connections.ts:63-77`). |
| `AccountSyncService` | `apps/server/src/onboarding/sync.ts` | Extends `SyncService`. Wraps `provider.sync(cursor)` to inject `since = now − window` (`sync.ts:31-47`). The window is `windows.get(id)` (backfill) → `account.settings.syncDays` → `config.sync.initialDays` (default 30). Retries the whole pass up to 5× on transient errors (`sync.ts:80-123`). `backfill()` (`sync.ts:126-176`). |
| `SyncService` | `apps/server/src/sync/index.ts` | Durable ingestion: cursors, identity mapping, upserts, threads, tombstones, reconciliation, arrival registration (`sync.ts:86-335`). |
| Provider adapters | `packages/providers/src/{gmail,graph,imap,jmap}.ts` | `sync(cursor, {since, maxEmails})` yields `SyncDelta`s and ends with a `cursor` delta. |

**Order inside one `SyncService.sync(accountId)` pass** (`apps/server/src/sync/index.ts:86-335`):

1. Load cursors from `sync_state`, prefixed `passport-sync-v1:{mail,calendar}` (`index.ts:88-100`).
2. Set kv `sync-in-progress:<id>` (`:103`).
3. **Calendar first** if the account has the calendar capability, so availability exists before
   arrivals schedule anything (`:104-177`). Gmail and Google Calendar are separate accounts; the
   companion has `settings.mailAccountId`.
4. **Mail** (`:178-309`). For each delta:
   - `mailbox` → upsert or delete the mailbox (`:192-202`).
   - `email upsert` → `getByProviderId` → `identities.email()`, which maps provider ids to ULIDs via
     kv and keeps local annotations (`category`, `matterId`, `personIds`) (`identity.ts:40-74`) →
     `isNew = !existing && !kv(sync-seen)` → `isArrival` → if arrival, `persistArrival` **before** the
     upsert (`index.ts:210-221`) → upsert the email → maintain `threads.emailIds` (`:222-240`) → set
     `sync-seen` → emit `email.received` (arrival) or `email.updated` (`:241-246`).
   - `email delete` → collected, then tombstoned after the pass (`:281-286`).
   - `thread` (IMAP/JMAP) → rebuild thread membership (`:250-272`).
5. If the pass ends without a `cursor` delta → `SYNC_INCOMPLETE` (`:274-276`).
6. `CURSOR_EXPIRED` → set kv `sync-reconcile:<id>:mail` → restart from a null cursor → after a
   complete pass, `reconcileMail` tombstones every stored email (inside the snapshot window) that was
   not seen (`:62-78`, `:289-302`).
7. Persist cursors, update `account.lastSyncAt`, emit `account.synced {emailsUpserted}` (`:303-318`).
   On error, store a bounded `lastSyncError` code (`:319-331`).

**The cursor is persisted only after a complete pass.** An interrupted initial sync (null cursor)
keeps its stored rows but restarts from scratch: Gmail lists again and **calls `getEmail` again for
every id**. `sync()` never skips ids already stored (`gmail.ts:340-347`). `sync-seen` only prevents
duplicate arrivals.

### 1.2 Gmail adapter specifics (`packages/providers/src/gmail.ts`)

| Step | Code | Calls | Quota units* |
|---|---|---|---|
| Labels on **every** sync, initial or incremental: `GET /labels` then `GET /labels/{id}` per label, for counts | `:242-258` | 1 + L | 1 each |
| **Initial (cursor null):** `GET /profile` to capture `historyId` before listing | `:315-319` | 1 | 1 |
| List ids: `GET /messages?maxResults=100&includeSpamTrash=true&q=after:<epoch>`. Page size is 100 because AccountSyncService never passes `maxEmails` (`:259`) | `:320-335` | ⌈N/100⌉ | 5 each |
| **All ids are collected before any message is fetched** (in a `Set`, newest first) | `:261, 331-333` | — | — |
| Per message: `GET /messages/{id}?format=full`, sequentially | `:340-347`, `:353-380` | N | 5 each |
| Text parts delivered by `attachmentId`: extra `GET …/attachments/{aid}` | `:367-378` | small % of N | 5 each |
| **Incremental:** `GET /history?startHistoryId=…&maxResults=100`, paged; 404 → `CURSOR_EXPIRED` | `:263-313` | ⌈changes/100⌉ | 2 each |
| Incremental: `messagesAdded`, `labelsAdded` and `labelsRemoved` all cause a **full re-fetch** (`format=full`) of the message | `:296-305`, `:340-347` | 1 per touched msg | 5 each |

\* Gmail API quota units: messages.get/list = 5, history.list = 2, labels.* = 1.

- **No batching** (Gmail's `batch` endpoint is unused), **no concurrency**, no `format=metadata`,
  no `fields=` partial responses.
- Gmail capabilities have `push: false` (`gmail.ts:73-80`), so there is no `users.watch`. Incremental
  sync is a poll every 120 s, and each poll costs 1+L label calls even when nothing changed. With
  40 labels that is ~30k label calls per day.
- `since` applies only to the initial list. Incremental history is account-wide.

### 1.3 Rate-limit handling (commit 24e5da7)

- `packages/providers/src/http.ts:20-91`: 429 responses, and 403 responses whose body contains
  `rateLimitExceeded`, `userRateLimitExceeded` or `RATE_LIMIT_EXCEEDED`, are `RATE_LIMITED`
  (`isRateLimited`, `:23-37`). **GET** requests retry with waits of 2, 4, 8, 16 and 32 s, honouring
  `Retry-After` up to 60 s (`:39-49`, `:57-79`). That is about 62 s of retrying per request.
  Mutations are never replayed.
- `apps/server/src/sync/connections.ts:63-127`: a failing concurrent call (for example an agent's
  `getEmail`) no longer disconnects an in-flight sync.
- Above that, `AccountSyncService.runAccount` retries the **whole pass** up to 5× when the error is
  `RATE_LIMITED`, `HTTP_429` or `HTTP_503`, with jittered waits of about 1, 2, 4, 8 and 16 s
  (`apps/server/src/onboarding/sync.ts:86-101`). For an initial sync **each retry starts again from
  a null cursor**: the full list plus all N `getEmail` calls. After that it sets
  `lastSyncError=SYNC_FAILED` and the scheduler retries on its interval/backoff.
- The scheduler's 5-minute job timeout fires on any long initial sync. The run is recorded as
  `JOB_TIMEOUT` in Routines (`packages/scheduler/src/scheduler-execution.ts:75-89`), but the sync keeps
  running because it ignores the abort signal. Later ticks are `skipped` while the work is still
  active (`:27-30`).

### 1.4 What is stored (`packages/store/src/migrations.ts`, `store-mail.ts`)

- `emails` row: ids, thread, matter, category, `received_at`, subject, from, preview, **`textBody`
  and `html_body` (full bodies)**, plus a JSON `data` blob with addresses, keywords, `mailboxIds`,
  attachment **metadata** (name, type, size, opaque `blobId`; no bytes), normalized `headers`
  (auth results, List-Unsubscribe, Message-ID, In-Reply-To…), verification and size
  (`migrations.ts:11-22`; normalizer `gmail.ts:110-202`).
- **FTS5** `emails_fts(subject, from, preview, textBody)` maintained by triggers (`migrations.ts:35-51`).
  Search runs `MATCH` (`store-mail.ts:209-211`).
- `threads(id, account_id, data{emailIds})`, `email_mailboxes`, `email_people`, `mailboxes` with
  provider counts.
- Attachment bytes are not stored. Graph's `getEmail` lists `/attachments` without `$select` when
  `hasAttachments`, which **transfers `contentBytes`** during sync even though only metadata is kept
  (`graph.ts:375-378`).
- **kv keys written per ingested email:** `sync-provider:…` and `sync-id:…` (identity, 2–3 keys), a
  thread alias, `sync-seen:…`, and for arrivals `arrival:<emailId>` plus a rewrite of the single JSON
  blob `arrival:pending`. That blob holds every pending arrival, so the whole index is re-serialized
  on each write (`apps/server/src/arrivals.ts:42-60`, `apps/server/src/atomic-kv.ts:14-40`). Because
  triage is far slower than ingest, the blob grows to about N entries: O(N²) bytes written over a
  backfill.
- Policy inverse snapshots: when a mail action **executes**, `capture()` stores **full emails
  including bodies** in `ActionRecord.inverse.params.__passportPolicyInverse`
  (`packages/policy/src/executor-context.ts:60-68,194-209`; `executor.ts:134-150`).

### 1.5 Other providers (for completeness)

- **Graph** (`graph.ts:224-355`): drains `messages/delta` **metadata for every folder across all
  history**, whatever the window, because stopping early loses the deltaLink (`:313-334`). It then
  calls `getEmail` for each changed id inside the window (`:337-349`). `since` is frozen into the
  cursor (`:242, 353`). `push: false`.
- **IMAP** (`imap.ts:238-330`): `SEARCH SINCE` per folder, then fetches the matching UIDs. Has
  `waitForChanges` (IDLE, `:601`) and `push: true`.
- **JMAP** (`jmap.ts:262-320`): `Email/query` plus `Email/changes`.
- **Google Calendar** syncs the **complete primary event collection** for a reusable syncToken
  (`google-calendar.ts:192-199`). Graph Calendar syncs 30 days back to 365 days forward
  (`packages/providers/README.md:101-104`).

### 1.6 Quantification: 1-year Gmail mailbox, N ≈ 20,000 messages in window

`includeSpamTrash=true` means N includes Spam and Trash. Assume L ≈ 40 labels.

**Ingest (API):**

| Item | Calls | Units |
|---|---|---|
| profile + labels.list + labels.get×40 | 42 | 42 |
| messages.list (100/page) | 200 | 1,000 |
| messages.get format=full | 20,000 | 100,000 |
| text-part attachments.get (≈0–2%) | 0–400 | 0–2,000 |
| **Total** | **≈20.2–20.6k** | **≈101–103k** |

- **Quota floor.** At the 6,000 units/min the code comment assumes (`http.ts:18-19`), the minimum is
  about 17 min. At Gmail's documented 15,000 units/user/min it is about 7 min. The sequential loop
  hits 6,000/min only when per-request latency falls below about 50 ms (20 req/s × 5 units × 60 s).
  On a fast link with keep-alive that is plausible, and it fits the throttling the commit message
  describes.
- **Latency-bound estimate.** About 150–400 ms per `format=full` request, plus about 10–50 ms of
  local work per message: several SQLite reads and kv writes, the FTS insert, `mailboxes.list` ×2,
  `accounts.list`, `people.list(self)` and the growing `arrival:pending` rewrite. That gives about
  2–6 messages/s, so **≈1–3 hours** for 20k with no interruptions. One `RATE_LIMITED` escalation, or
  a restart during the pass, **repeats all ~20k calls**.
- The first ~200 list calls (about a minute) store nothing. After that, messages appear newest first.

**Triage (the dominant cost):**

- Arrivals ≈ every in-window message except drafts, Sent, and self-sent mail outside the Inbox. That
  includes archived mail, Spam and Trash from others: say **15–18k**.
- Per arrival (`packages/agent/src/triage.ts:352-502`):
  - people step: `resolvePeople` pages **all stored emails** (`allEmails(store, {includeDeleted:true})`,
    100 queries of 200 at 20k) **and all executed actions**, then submits **one `person_update`
    ActionRecord per address** in from, to and cc (`people.ts:46-50,71,207-210`);
  - classify: fast model, unless a sensitive regex matches (`triage.ts:384-414`);
  - matter: main model, **always** (`:161`);
  - plus main-model reply drafting (`replies_known`, `:475-487`) or scheduling (`:277-350`).
- So about 2–3 host-CLI invocations per arrival. Each spawns a Claude Code or Codex session with a
  180 s timeout (`packages/agent/src/host/client.ts:164`). All of them are **serialized**
  (`compose.ts:316-322`, `runtime.ts:46-55`).
- At about 10–30 s per arrival: **≈40–150 hours**, plus subscription rate limits on about 40k CLI calls.
- The people step makes the total quadratic: each arrival rescans a store that is growing, plus an
  action log that grows by about 3–6 records per arrival.
- Side effects per historical email under default `supervised` trust (`packages/policy/src/policy.ts:105,310-319`):
  - matter create or attach and person updates **execute** automatically (logged ActionRecords);
  - label+archive (newsletters, receipts) and mark_read+archive (notifications) become **proposals**;
  - `replies_known` gets a **draft proposal replying to old mail**;
  - scheduling proposes **meeting slots for old invites**;
  - everything else writes a kv decision.
- `/api/decisions` returns at most 500 (`apps/server/src/actions-routes.ts:8-15`).

---

## 2. Consumers of the mirror

Verdict legend: **KEEP** = keep as is; **REWORK** = needs on-demand provider access or a small
cache; **DELETE** = candidate for removal.

### 2.1 Server ingestion and background

| Consumer | Mirror dependency | Verdict | Reason |
|---|---|---|---|
| `SyncService` full snapshot and backfill (`sync/index.ts`, `onboarding/sync.ts:126-176`) | Is the mirror | **REWORK** (shrink) | Keep incremental history/delta to detect new mail. Drop windowed snapshots, backfill and reconciliation. |
| `AccountSyncService.backfill` + `POST /api/accounts/:id/backfill` (`onboarding/routes.ts:131-141`) | Widens the mirror. The HTTP request **awaits the whole re-sync**. Resets the mail cursor to null, so every message is fetched again (`sync.ts:141-151`) | **DELETE** | Exists only to backfill history. |
| `reconcileMail` / `reconcileEvents` + `sync-reconcile` kv (`index.ts:62-84`) | Needs a complete local set to diff | **DELETE** (mail) / REWORK (calendar) | No mirror means nothing to reconcile. Cursor expiry becomes "re-baseline the watermark". |
| `isArrival` + `persistArrival` on **initial/backfill** sync (`index.ts:215-220`) | Uses "not stored locally" as the novelty test | **REWORK** | Arrival should mean received after the account's watermark, not "first time we stored it". |
| `ArrivalQueue` (`arrivals.ts`) | Reads the email from the store (`:204`) | **KEEP** (proactive), REWORK input | Correct shape for new mail. Feed it only post-watermark arrivals and allow a fetch-on-demand email. |
| `agent.arrivals` / `agent.daily_digest` / `agent.matter_review` / `outbox.release` / `trust.decay` jobs (`schedulers/system-jobs.ts`) | Digest and review read local actions and matters | **KEEP** | This is proactive work. |
| `store.maintenance` (VACUUM/FTS optimize) (`system-jobs.ts:74-97`) | FTS over bodies | REWORK | Mostly unnecessary without a body mirror. |
| Gmail label refresh on every poll (`gmail.ts:242-258`) | Mailbox counts | REWORK | Fetch labels on demand or cache with a TTL. |
| `calendarsReady` / `calendarSafeStore` (`apps/server/src/calendar-safety.ts:16-160`) | Requires a **fully synced, fresh local calendar mirror** before arrivals schedule and before a held `calendar_propose` releases | REWORK | Could call provider `freeBusy` at decision time instead. |
| `GET /api/accounts` `messageCount` (`onboarding/routes.ts:61-80`) | Counts local rows | REWORK | Meaningless without a mirror. Use provider counts. |
| Doctor sync-age check (`apps/server/src/doctor.ts:198-220`) | "Initial sync has not completed" | REWORK | Should check connectivity and watermark instead. |
| Calendar sync (`index.ts:104-177`) | Local event mirror | KEEP (bounded) / REWORK | Availability, invites and conflicts read local events. A small forward window is reasonable. See freeBusy below. |

### 2.2 HTTP routes (`apps/server/src/*-routes.ts`)

| Route | Reads | Verdict | Reason |
|---|---|---|---|
| `GET /api/emails` (`mail-routes.ts:7-9`) | `store.emails.query` (FTS, filters) | **REWORK** | Proxy to provider search. **No web view calls it today** (`api.emails` is defined but unused). |
| `GET /api/emails/:id` (`mail-routes.ts:10-19`) | Local email with bodies | **REWORK** | `ProposalDetails` uses it for the draft's source email (`apps/web/src/views/ProposalDetails.tsx:20-22`). Fetch on demand, keyed by provider id. |
| `GET /api/threads/:id` (`mail-routes.ts:20-32`) | Local thread rows | **REWORK** | No provider thread fetch exists. Unused by web. |
| `GET /api/matters`, `/api/matters/:id` (`matters-routes.ts:9-41`; account-filtered variant `onboarding/filters.ts:56-83`) | Matters are local-only domain objects; the timeline joins **local emails with bodies** (limit 500) | **KEEP** matters, REWORK the email join | Matters keep `emailIds`. Bodies could be a cache keyed by provider id. The filtered route loads every email of every matter to compute `accountIds`. |
| `GET /api/people/:id` (`matters-routes.ts:97-107`) | `emails.query({personId})` (100) | REWORK | Provider search `from:addr OR to:addr`. |
| `GET /api/events` (`matters-routes.ts:108-122`) | Local events | KEEP | Bounded calendar cache. |
| `/api/decisions`, `/api/actions`, approve/reject/undo/cancel-hold (`actions-routes.ts`) | ActionRecords only | **KEEP** | Mirror-independent. |
| `POST /api/agent/triage/:id` (`agent-routes.ts:8-11`) | Requires a local email | REWORK | Accept a provider id and fetch it. |
| `GET /api/digest/:date` | kv | KEEP | — |

### 2.3 Agent package (`packages/agent/src`)

| Consumer | Mirror dependency | Verdict | Reason |
|---|---|---|---|
| `triage()` (`triage.ts:352-502`) | `store.emails.get(id, bodies)` (`:358`); candidate matters through **thread rows and an FTS similarity query** (`:104-140`); full-thread bodies for replies (`readThread`, `:247-263`) | **REWORK** | Fine for new mail if given one fetched message plus an on-demand thread fetch. The FTS matter candidates could use local matter titles or provider search. |
| `resolvePeople()` (`people.ts:22-231`) | **Scans all stored emails** each run (`:46-50`) for sent/received counts. `known` requires sent>0 or received≥2 **within mirrored history** (`:161-167`). Writes one `person_update` ActionRecord per address (`:207-210`) | **REWORK** (critical) | O(N) per arrival. The relationship class is only correct with full history. Replace with provider count queries (e.g. Gmail `from:`/`to:` `resultSizeEstimate`) or an incremental counter seeded lazily. |
| `heuristicCategory` / `sensitiveCategory` / `serviceSender` | The email object only | KEEP | Pure functions of one message. |
| `decisions.ts` (`recordDecision`/`pendingDecisions`) | kv index of email ids | KEEP | Not a mirror; holds references. |
| `dailyDigest` (`schedules.ts:40-98`) | Actions, matters, trust | **KEEP** | Mirror-independent. |
| `reviewMatters` (`schedules.ts:100-150`) | `allEmails({matterId})` and bodies for the last 10 | REWORK (light) | Needs only matter emails, which could be cached. |
| `manual()` composer/routines (`manual.ts`) | `store.emails.get` for selected ids; uses the tool registry | REWORK via tools | Inherits the tool rework below. |
| `data.ts` `allEmails` / `allActions` | Unbounded pagination helpers | REWORK | `allEmails` exists mainly for people and review scans. |
| Global serialized run queue (`runtime.ts:46-55`, `compose.ts:316-322`) | — | REWORK | Interactive runs should not wait behind background triage. |

### 2.4 Tools registry: shared by the built-in agent and MCP (`packages/tools/src`, `docs/tools.md`)

`docs/tools.md:3-7` says it outright: "Reads use the local Store". All 44 tools take local ULIDs.

| Tool(s) | Mirror dependency | Verdict | Reason |
|---|---|---|---|
| `search_emails` (`reads.ts:18-31`) | FTS5 over the local window | **REWORK** | Becomes provider search (Gmail `q=`, Graph `$search`, IMAP SEARCH, JMAP `Email/query`) with paging. Today mail outside the window is invisible to agents. |
| `get_email`, `get_email_body` (`reads.ts:32-73`) | Local bodies (`context.ts:45-47`) | **REWORK** | `provider.getEmail` already exists. It needs an id scheme or cache. |
| `get_thread`, `summarize_thread` (`reads.ts:74-98`, `extra.ts:17-81`) | Local `threads` rows | **REWORK** | Needs a provider thread fetch, which is a gap. |
| `list_mailboxes` (`reads.ts:99-113`) | Local mailboxes from sync | REWORK | Needs a provider label/folder list, which is a gap (Gmail's is private, `gmail.ts:217-220`). |
| `list_recent_from_person` (`extra.ts:178-224`) | Scans local email pages filtered by from | **REWORK** | A provider search for `from:`. |
| `batch_archive_by_query`, `apply_label_by_query` (`extra.ts:249-305`) | Local `EmailQuery` (FTS) | **REWORK** | Resolve the query at the provider, then act on provider ids. |
| `archive_emails`, `label_emails`, `mark_read`, `move_emails`, `snooze`, `reply_draft`, `create_draft`, `send(draftEmailId)` (`writes.ts`) | `ctx.emailBatch` / `ctx.email` require local rows (`context.ts:49-60`); policy categorization uses `email.from` plus people (`context.ts:62-136`) | **REWORK** | Must accept provider-addressed messages, fetched or cached at action time. |
| `list_matters`, `get_matter`, `create_matter`, `update_matter`, `attach_to_matter` | Matters are local, but `matterBundle` joins local emails (`context.ts:138-194`); attaching requires local email rows | KEEP matters / REWORK email refs | Matters are Passport's own state. Only the email references need a cache. |
| `list_people`, `get_person`, `search_people`, `update_person` | Local people table | **KEEP** | Passport's own state. Its accuracy depends on how it is populated (§2.3). |
| `list_events`, `free_busy`, `find_free_slots` (`reads.ts:162-192`, `availability.ts:252-304`) | Local events. A `freeBusy` resolver hook exists (`availability.ts:269`) but **is never wired** in `compose.ts` (`createAgentRuntime` and `createMailboxMcpServer` get no `freeBusy`) | REWORK (light) | Wire `CalendarProvider.freeBusy`. Keep a small events cache for invites. |
| `list_pending_decisions`, `list_actions`, `get_daily_log`, `explain_decision`, `undo_action`, `cancel_held_action`, `get_trust`, profile and standing-rules tools | Actions, trust, kv | **KEEP** | Mirror-independent. |
| `preview_unsubscribe`, `unsubscribe` | The email's normalized headers | REWORK (light) | One fetched message is enough. |

### 2.5 MCP package (`packages/mcp/src`)

- `server.ts:23-89` exposes the same registry with an `external-agent` actor, so every row in §2.4
  applies. The server instructions describe mail as local.
- `resources.ts`: `passport://matters/*`, `people/*`, the pending actions list and the USER.md
  profile, all read from the local store (`:53, 80-93, 100-112`). **KEEP**: none read the email
  mirror directly.
- Verdict: **KEEP** the transport, the policy gating and the external-agent ceiling. **REWORK**
  inherits from tools.

### 2.6 Policy executor: inverse computation and undo (`packages/policy/src/executor-*.ts`)

| Piece | Mirror dependency | Verdict |
|---|---|---|
| `emailFor` (`executor-context.ts:60-69`) | **Every mail action resolves `emailIds` from the store** and throws `EMAIL_NOT_FOUND` otherwise | REWORK |
| `capture()` mail snapshot (`executor-context.ts:194-209`) | Prior state = **local** `keywords` and `mailboxIds`, with full bodies, captured at execution time. A stale mirror gives a wrong inverse | REWORK |
| `changeMail` / `applyMailChanges` (`executor-mail.ts:42-222`) | Maps the local mailbox ULID to the provider label via `store.mailboxes` (`:25-34`) and the local email to `providerId`; mirrors the result into the store (`mirrorEmail`, `:7-20`) | REWORK (needs a label map, not a mirror) |
| Undo `restore()` mail (`executor-restoration.ts:31-90`) | Diffs prior vs **current local** email, then issues provider changes | REWORK. It could diff against a fresh `provider.getEmail()` |
| Draft and send (`executor-dispatch.ts:66-120`, `resolvedDraft` `executor-context.ts:89-118`) | Draft must exist locally as `$draft`. Reply resolution scans **local thread rows** for In-Reply-To. After send, `provider.getEmail(sent)` is upserted locally | REWORK |
| Matter, person, profile, snooze snapshots (`executor-context.ts:224-300`) | Local domain objects. `matter_create` requires each attached email to exist locally | KEEP (domain) / REWORK (email refs) |
| ActionRecord, outbox hold, `releaseDue`, claim, external ceiling (`executor.ts`, `policy.ts:290-319`) | None | **KEEP** |

**Does undo need the local copy?** It needs the provider id, the label/folder ids and the prior flag
and label state. **It does not need bodies.** That minimal state can be captured from
`provider.getEmail()` at execution time. The current design also copies full bodies into the
ActionRecord.

### 2.7 Web UI (`apps/web/src`)

There is **no mailbox or inbox list screen anywhere**. Routes are `/` (Queue), `/matters`,
`/matters/:id`, `/people`, `/people/:id` and `/activity`; `/accounts`, `/trust` and `/scheduler`
redirect into Settings (`apps/web/src/App.tsx:125-150`). `api.emails`, `api.email` and `api.thread`
are defined (`api.ts:133-139`) but never called by a view.

| Screen | Data | Mirror? | Verdict |
|---|---|---|---|
| Queue / `WorkQueue` (`views/Decisions.tsx:18-155`) | `/decisions`, `/matters`; composer → `/agent/run` | Indirect: proposals come from triage of mirrored mail | **KEEP** |
| `ProposalDetails` (`views/ProposalDetails.tsx:20-26`) | `/emails/:id` for the draft's source; `/matters/:id` | Yes | REWORK (fetch on demand) |
| Matters list and page (`views/Matters.tsx:30-33, 200-250`) | `/matters/:id` timeline renders **local emails with bodies**, events and actions | Yes, for the email join | KEEP / REWORK the email part |
| People list and page (`views/People.tsx:45, 130-218`) | `stats.received/sent` (computed from the mirror), recent emails by `personId` (only triaged mail) | Yes | REWORK |
| Activity (`views/Activity.tsx:35-38`) | `/actions` | No | **KEEP** |
| Sidebar (`shell/Sidebar.tsx:100-319`) | Accounts with a "Syncing…" spinner, matters, known people, decisions count | Sync status only | REWORK the status semantics |
| Settings › Accounts › `AccountRow` (`accounts/AccountRow.tsx`) | `syncSummary`, "N messages" (local count), **Load older mail / Backfill (default 365)**, Sync now | Yes | **DELETE** backfill; REWORK the count and status |
| Command palette (`shell/CommandPalette.tsx:49-50`) | Matters and people only; no email search | No | KEEP (an email search could be added) |
| Live updates (`state.tsx:59-70`) | **Every** bus event is broadcast (`apps/server/src/server.ts:33`) and triggers a refetch of every mounted resource after 120 ms of quiet. During sync that means one refetch storm per few `email.updated`/`email.received` events | — | REWORK |

---

## 3. What the providers can already do on demand

`MailProvider` (`packages/types/src/index.ts:763-786`):

| Method | On demand? | Notes |
|---|---|---|
| `connect` / `disconnect` | — | — |
| `sync(cursor, {maxEmails, since})` | No | The only way to enumerate mail, mailboxes or threads. Initial = full or windowed snapshot. Incremental = history/delta. |
| `getEmail(providerId)` | **Yes** | Full message with bodies. Gmail `format=full` (`gmail.ts:353-380`); Graph with `/attachments` (`graph.ts:359-380`). |
| `getBlob(blobId)` | **Yes** | Attachment download by opaque handle (`gmail.ts:381-413`). Used only when composing drafts; **no tool exposes attachment download**. |
| `applyChanges`, `createDraft`, `updateDraft`, `deleteDraft`, `send`, `createMailbox?` | Yes (writes) | Take provider ids. |
| `waitForChanges?` | Push | IMAP only. Gmail and Graph have `push: false`. |
| `checkConnection` | Yes, but **not in the interface** | Gmail and Graph implement it; doctor uses it through a cast (`doctor.ts:28-45`). |

`CalendarProvider` (`types/src/index.ts:788-808`): `listCalendars`, `sync(cursor, range)`, event CRUD,
`respond`, and **`freeBusy(range)`** (implemented, e.g. `google-calendar.ts:337-343`, but **not wired**
into the agent or MCP; see §2.4).

**Gaps for an on-demand agent:**

| Need | Status |
|---|---|
| Server-side search with a query string and paging | **Missing.** Gmail `messages.list?q=` is used internally with only `after:` (`gmail.ts:322-327`). Graph `$search`/`$filter`, IMAP SEARCH and JMAP `Email/query` exist only inside `sync()`. |
| List messages in a label/folder with paging (metadata only) | **Missing.** There is no `format=metadata` path. |
| Fetch one thread with bodies | **Missing.** There is no `threads.get` (Gmail) or `conversationId` filter (Graph). |
| List labels/folders with counts | **Missing from the interface.** Gmail `getLabels` is private (`gmail.ts:217-220`); mailboxes arrive only as sync deltas. |
| Get a message by provider id | Present (`getEmail`), but tools cannot address provider ids. |
| Attachment download | Present (`getBlob`), but not exposed as a tool. |
| Count or estimate per query (relationship stats) | Missing (Gmail `resultSizeEstimate` is unused). |
| Contacts lookup | **Missing entirely.** `capabilities.contacts` exists (`types/src/index.ts:42`) but there is no contacts interface. People are derived only from mirrored headers. |
| Calendar free/busy | Implemented in providers, **not wired** (`compose.ts` passes no `freeBusy`). |
| Calendar list events by range on demand | Only through `sync(cursor, range)`. Graph saves the range in its cursor; Google ignores the range. |
| Delta/watermark only (new mail since X) | Gmail `history` and Graph delta exist inside `sync()`. Gmail `users.watch`/Pub/Sub is unimplemented. Graph subscriptions are unimplemented. |

---

## 4. Current user flow: from "Connect Gmail" to "first useful thing"

1. **Empty workspace.** `Home` renders `Welcome` with `SetupFlow` when there are no accounts
   (`App.tsx:42-66`). Copy: "Passport reads your mail on this machine, proposes replies and clean-up…".
2. **Pick a provider.** Google or Microsoft, plus "Connect calendar too" (default on). Click **Connect
   Gmail** (`connect/SetupFlow.tsx:134-183`). This starts a host-agent setup task: Claude Code or
   Codex registers an OAuth client in the user's Google Cloud project through a browser
   (`apps/server/src/setup/*`). Copy: "Your host agent is doing the setup. This takes a minute or two."
   Prompts appear as needed: "Sign in in the browser window, then continue" with **I've signed in,
   continue**, or yes/no and free-text questions (`connect/SetupTaskView.tsx:115-205`). An agent log
   is available in a disclosure.
3. **Connected.** The server starts `syncAccount` for mail and the companion calendar
   (`oauth-account.ts:224-235`). The task view shows "Gmail is connected — **The first sync is running.
   Proposals will appear in your queue.**", the connected address and **Done**
   (`SetupTaskView.tsx:122-123, 205-245`). The redirect path `/accounts?connected=` opens Settings ›
   Accounts and toasts "Account connected. The first sync is running." (`App.tsx:27-39`).
4. **After Done.** Home becomes the Queue: "Nothing needs you" / "You're clear for now. New proposals
   land here as mail arrives." (`views/Decisions.tsx:93-107`). The sidebar account row shows a
   spinner and "Syncing…" (`shell/Sidebar.tsx:117-123`, `accounts/AccountRow.tsx:21-34`).
5. **Progress surfacing.** The only signals are:
   - `syncing: boolean` (`onboarding/routes.ts:72`);
   - "N messages" (the local row count, refreshed on each WS-triggered refetch, `AccountRow.tsx:58-60`);
   - "Sync failed" / "Last sync error: CODE";
   - Routines showing `sync:<id>` runs, often "Job timed out after 300000ms" during a long first sync.

   There is no phase (listing vs fetching vs triaging), no window ("last 30 days" / "last 365 days"),
   no total, ETA or percentage. **The triage backlog is not surfaced at all**: no count of pending
   arrivals, apart from the `agent.arrivals` job ("Processed due email arrivals") and items trickling
   into Activity. `account.sync.retry` events exist (`types/src/index.ts:849`) but no view renders them.
6. **"First useful thing".** Proposals start appearing only after (a) list pagination finishes, (b)
   individual messages are fetched and stored, and (c) each passes the serialized LLM triage. The
   arrival queue waits up to 10 minutes for the companion calendar to finish its full sync before
   triaging (`arrivals.ts:223-232`). The first proposals are about **old mail**: archive or label
   proposals for months-old newsletters, draft replies to old threads, meeting-slot proposals for
   past invites. One auto-created matter per email fills the sidebar.
7. **Composer feels hung.** Typing an instruction calls `/agent/run` (`shell/Composer.tsx:76`). That
   queues behind every pending triage run (§0.6).
8. **"Past year".** Through Settings › Accounts › **Load older mail** (default **365** days) →
   **Backfill**, a blocking POST that awaits the entire widened re-sync before resolving with "Older
   mail synced." (`AccountRow.tsx:71-98`, `onboarding/routes.ts:131-141`). Backfill resets the mail
   cursor to null, so it **re-lists and re-fetches every message in the year**, including ones already
   stored, and turns every never-seen older message into a new arrival for triage.
   `docs/accounts.md:212-214` describes backfill as the way to "widen a mail snapshot".
   Alternatively, a `sync.initialDays: 365` config (`docs/accounts.md:195-198`) gives the same result
   on first connect.

**Stated behaviour in the docs**

- `docs/accounts.md:193-232`: a 30-day default window. "Sent mail, drafts and self mail outside Inbox
  are ingested for history **without triggering arrival triage**", which implies everything else
  triggers it. Backfill semantics. 429/503 backoff with at most five retries. "No live Gmail, Graph
  or IMAP account calls were made during this implementation" (`:234-236`).
- `docs/scheduler.md:12-18`: `sync:<accountId>` every 2 min "plus a first sync on fresh startup",
  `agent.arrivals` every 30 s, a daily digest at 08:00, matter review at 04:00.

**What is confusing or slow**

- No visibility into window, phase or backlog. "Syncing…" can last hours. Triage can last days with
  no indicator.
- The setup copy promises "Proposals will appear in your queue" and "New proposals land here as mail
  arrives". In practice they are about historical mail and arrive in floods.
- The Routines/scheduler UI reports timeouts and failures for a sync that is still running.
- Backfill blocks a browser request for the whole duration and repeats work already done.
- A rate-limit escalation or restart during the initial pass loses all API progress.
- The composer and routines queue behind background triage.
- Mail older than the window does not exist for agents: `search_emails` and the tools only see the
  mirror.

---

## 5. Contract invariants at risk (`docs/CONTRACT.md:78-95`)

| Invariant (abridged) | Assumes mirror? | Notes |
|---|---|---|
| Every locally originated change needs an `ActionRecord`; provider mirroring is exempt system ingestion (`:80-83`) | **Partly.** The rule is mirror-independent; the exemption exists for the mirror | Keep the rule. The ingestion exemption shrinks to new-mail detection. Note that triage currently creates **one ActionRecord per address per email** through `person_update`. |
| Provider-side deletions keep the local email, matter and thread memberships, with `keywords.$deleted = true` (`:84-86`) | **Yes** | Tombstones exist only because emails are mirrored. Matter history keeps working only if attached emails are cached. |
| Messages absent from a completed cursor-expiry reconciliation are tombstoned; reappearing messages clear it without another arrival (`:86-88`) | **Yes** | Requires full-set diffing (`reconcileMail`) and `sync-seen` keys. |
| Account removal may hard-delete its emails (`:88`) | Yes | Trivial without a mirror. |
| Full resync preserves local annotations, defers missing-message reconciliation until the full pass succeeds, retries interrupted recovery from a null cursor (`:88-90`) | **Yes** | `identities.email()` annotation merge, the `sync-reconcile` kv key, null-cursor restarts. |
| Windowed snapshots retain older mail outside their window (`:90`) | **Yes** | `mailSnapshotSince` / `after` filter in reconcile (`index.ts:58-70`, `onboarding/sync.ts:58-60`). |
| Explicit onboarding backfills only widen ingestion; they do not prune (`:91`) | **Yes** | Backfill exists only for the mirror. |
| `executed` + `inverse: null` only for irreversible actions (`:92`) | No in principle; **yes in practice** | The rule is independent, but inverse capture currently reads local state (`executor-context.ts:194-209`). It needs a provider-side snapshot source. |
| `send` is never synchronous when `outboxHoldMinutes > 0`; it is `held` first (`:93`) | No | Independent. Draft resolution currently reads local drafts and threads (`executor-context.ts:89-118`). |
| External agents are capped by `externalAgentCeiling` (`:94`) | No | Independent (`policy.ts:290-301`). |
| Verification state comes from headers and signatures, never content (`:95`) | No | Needs only the headers of the message at hand (`verification.ts`). People's `lastSeenBlueAt` and downgrade detection (`people.ts:171-185`) assume every message from a sender is ingested, so a sender who has been seen blue is downgraded later. Partial history weakens downgrade detection. |
| Every locally originated change is an Action, logged and undoable (`:16-18`) | No | Independent. Undo currently diffs against local state (`executor-restoration.ts:31-90`). |
| Store description: "`node:sqlite` (FTS5)…" (`:27`) and "sync scheduler" (`:32`) | Yes | The package responsibilities table names FTS and the sync scheduler as core. |

---

## Appendix A: mirror-related kv keys and side tables

| Key / table | Writer | Purpose |
|---|---|---|
| `sync_state.cursor = passport-sync-v1:{mail,calendar}` | `sync/index.ts:95-100` | Provider cursors |
| `sync-in-progress:<acct>`, `calendar-sync-in-progress:<acct>`, `calendar-sync:<acct>` | `sync/index.ts:103,108,169-176` | Readiness gates (`calendar-safety.ts`) |
| `sync-reconcile:<acct>:{mail,calendar}` | `sync/index.ts:110,180` | Recovery intent |
| `sync-id:<acct>:<kind>:<native>`, `sync-provider:<acct>:<kind>:<providerId>` | `sync/identity.ts:6-28` | Provider ↔ ULID identity map |
| `sync-seen:<acct>:<providerId>` | `sync/index.ts:215,241` | Arrival dedupe |
| `arrival:<emailId>`, `arrival:pending` (single JSON index), `arrival-claim:<emailId>`, `run:arrival:<emailId>` | `arrivals.ts`, `compose.ts:238-293` | Durable triage queue and checkpoints |
| `person-stats:<personId>` | `people.ts:219-222` | Contribution ids so counts survive window pruning |
| `decision:<run>:<email>`, `agent:pending_decisions` | `decisions.ts` | Decision index |
| `emails`, `emails_fts`, `threads`, `email_mailboxes`, `email_people`, `mailboxes` | `packages/store` | The mirror |

## Appendix B: files most affected by a move to on-demand access

`apps/server/src/sync/{index,identity,connections}.ts`, `apps/server/src/onboarding/{sync,routes,config}.ts`,
`apps/server/src/arrivals.ts`, `apps/server/src/compose.ts`, `apps/server/src/calendar-safety.ts`,
`apps/server/src/mail-routes.ts`, `apps/server/src/matters-routes.ts`,
`packages/providers/src/{gmail,graph,imap,jmap,http}.ts`, `packages/types/src/index.ts`
(MailProvider, EmailQuery, SyncDelta), `packages/store/src/{migrations,store-mail}.ts`,
`packages/tools/src/{reads,extra,writes,context}.ts`, `packages/agent/src/{triage,people,data,schedules}.ts`,
`packages/policy/src/executor-{context,mail,restoration,dispatch}.ts`, `apps/web/src/accounts/AccountRow.tsx`,
`apps/web/src/views/{People,Matters,ProposalDetails}.tsx`, `apps/web/src/state.tsx`,
`docs/{CONTRACT,accounts,scheduler,tools}.md`.
