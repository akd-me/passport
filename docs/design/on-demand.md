# Passport v0.3 design: on-demand mail, tasks, and a Mac app

Status: proposal, 2026-10-22. Supersedes the mirror-first model documented in `docs/accounts.md`
and the sync invariants in `docs/CONTRACT.md` once accepted. The four research reports this draws
on are in `docs/design/research/` (file:line references there are against commit `24e5da7`).

## 1. What is wrong today

The owner connected Gmail and Passport began "processing the past year". That phrase is not in the
code. What actually happens:

1. **Initial sync mirrors a window of the mailbox into SQLite.** The default window is 30 days
   (`apps/server/src/config.ts:51`). Settings › Accounts › "Load older mail" defaults to 365 days and
   its Backfill button resets the cursor, so every message in the year is listed and fetched one at a
   time with `format=full`, with no batching and no concurrency. Any rate-limit escalation or restart
   repeats all of it, because the cursor is only saved at the end of a complete pass.
2. **Every historical message is treated as a new arrival.** Anything not yet stored that is not a
   draft, Sent, or self-sent counts as an arrival, including archived mail, Spam and Trash. Each
   arrival gets two or three host-CLI LLM calls (people, classify, matter, often a reply draft),
   all through one global serialized queue. For 15–18k arrivals at 10–30 s each that is days of
   inference, and the output is proposals about year-old newsletters, draft replies to closed
   threads and meeting slots for past invites.
3. **The composer waits behind the backlog.** User instructions and routines share the same queue
   as background triage.
4. **Nothing reads the mailbox live.** All 44 agent and MCP tools, every HTTP route and the policy
   executor read the local copy and reject ids that are not stored. Mail outside the window does
   not exist for agents. The provider interface has no search, list, thread fetch or label list.
5. **Gmail's quota makes the mirror the expensive part by design.** The quota page updated
   2026-10-16 gives 6,000 units per user per minute. A full message costs 60 units, metadata 20,
   a list page 5, a history page 2. Mirroring 20k messages with bodies is about 1.2M units, at least
   200 minutes at 100% of quota, which is what commit `24e5da7` had to ride out. A metadata-only
   index is still about 400k units, roughly 67 minutes.
6. **The UI cannot explain any of this.** Progress is a "Syncing…" spinner and a local row count. No
   phase, window, ETA or triage backlog is shown. The scheduler reports the sync job as timed out
   after 5 minutes while it keeps running.

The comparison the owner drew is the right one. Claude Code and Codex do not index a repository.
They `ls`, `grep` and `read` on demand, keep notes in files, and run background work only for
things that change. The mailbox should be treated the same way: the provider already has a fast
server-side search index, and Passport has been rebuilding a worse one locally.

## 2. Principles

1. **The mailbox is the filesystem, the provider is the index.** Agents reach into Gmail, Graph,
   IMAP and JMAP on demand with search, list, read, grep and count tools. No backfill, ever.
2. **Cache what was touched, nothing else.** A lazily filled envelope cache (headers, labels,
   attachment manifest, verification) plus a body cache with a TTL. No FTS5 over bodies.
3. **Background work is only for new mail.** A per-account change watcher (Gmail `history.list`,
   Graph `delta`, IMAP IDLE) feeds the existing arrivals queue. The cursor starts at "now" on
   connect, so the agent is usable at second zero.
4. **The unit of work is a task, not an email.** Like a T3 Code thread: a durable conversation with
   streamed tool calls, approvals at the composer, a per-run summary of what changed, and a
   lifecycle of inbox ↔ working ↔ snoozed ↔ settled driven by server-owned monitors.
5. **People and matters are notes the agent maintains**, like memory files, with a small structured
   table for the fields policy depends on (relationship, verification, verified-self).
6. **Every write still goes through the policy executor.** Trust modes, outbox hold, undo and the
   external-agent ceiling are unchanged.
7. **Passport is a Mac app first**, shipped the way T3 Code ships: Electron main process spawning
   the unchanged `passport serve` as a child, with menu bar, notifications, Keychain and deep links.
   The npm CLI and Docker remain as the server-only path.

## 3. The new user flow

### Connect

1. Open Passport.app. The empty state offers Gmail, Microsoft, IMAP. The agent-driven OAuth setup
   from v0.2 stays (it is the part that works).
2. The account connects. **There is no sync.** The watcher takes a cursor at "now", `mail_labels`
   fetches the label tree (1 unit), and the Home screen is live within a second: unread count, the
   last few threads in the inbox from one `mail_list` call, and a composer.
3. First-run copy: "Connected. Passport reads your mail on demand and watches for new mail. Ask it
   to do something, or let it triage what arrives." No "first sync is running" message.

### Ask for something (the task)

A task is started from the composer, exactly like a T3 Code thread:

> "Find the Hetzner invoices from this year and attach them to the Taxes matter."

The task view streams the run: `mail_search(from:hetzner newer_than:1y has:attachment)` → 9 rows,
`mail_read` on two of them, `mail_attachment_read` on the PDFs, then a proposed `attach_to_matter`.
Consecutive reads collapse into "Searched twice, read 4 messages" the way T3 collapses tool calls.
Proposed writes appear at the composer as an approval panel with the same choices T3 offers:
accept, accept for this task, always accept this category, decline. The permission mode is chosen
per task in the composer and defaults to the account's trust ladder position.

When the run ends, the task shows a **change summary** (the per-turn diff): "2 attachments added to
Taxes, 0 mail changed". Every line links to the ActionRecord and its undo.

Follow-ups steer the running task or queue after it, with the same queue and steer semantics T3
has. Tasks live in a sidebar with Pinned, Active, Working, Snoozed and Settled. A task that is
waiting on a counterpart sits in Working and comes back to the inbox only when it needs the person.

### Let it work (proactive)

Proactive work is a scheduled or event-driven task, not a special pipeline:

- **New mail** wakes a bound "Inbox" task through the watcher, with the same dedupe rules T3 uses for
  webhooks: replay key on Message-ID, coalesce on thread for a burst of replies. The Inbox task
  triages with the same tool belt and delegates per-matter work to child tasks.
- **`watch_conversation`** is the email analogue of `watch_pull_request`: a task that sent a message
  asks to be woken when someone else replies, a bounce arrives, or a deadline approaches. Only events
  after the watch began wake it. Chatty auto-replies are rate-limited.
- **Routines** (daily digest at 08:00, weekly newsletter cleanup) are `fixed_time` scheduled tasks,
  bound to a task thread or starting a fresh one per run, visible in an Automations panel.

The Decisions feed from v0.2 becomes the "needs you" inbox of tasks, not a flat list of proposals.

### The Mac app

Passport.app launches at login, windowless, with a menu-bar item showing the "needs you" count.
Notifications fire from the main process when a task needs an approval or answer, so they work with
the window closed. Clicking one opens `passport://task/<id>`. OAuth stays loopback in the system
browser, which is what Google and Microsoft require for desktop apps.

## 4. Architecture

### 4.1 The tool belt

The mapping to coding-agent primitives, from research report 03:

| Coding primitive | Email tool | Backing |
|---|---|---|
| `ls` | `mail_labels`, `mail_list` | labels.list; messages.list + metadata batch; Graph `$filter` + `$orderby`; IMAP SORT |
| `Glob` | `mail_list` with structural filters (sender, date, unread, attachment, size) | never touches bodies |
| `Grep` | `mail_search` (portable query or provider-native `rawQuery`) | Gmail `q`; Graph `$search` or `$filter`; IMAP SEARCH; JMAP `Email/query` |
| `Grep -C` | `mail_grep` (regex over a bounded set the agent already narrowed) | fetch then match locally |
| `Read` | `mail_read` (thread or message as clean text, quoted history collapsed, last 5 in full), `mail_attachment_read` (pdf, docx, xlsx, pptx, ics, images as MCP image blocks) | threads.get; conversationId filter with `uniqueBody`; IMAP BODY.PEEK |
| `git status` | `mail_changes` (what arrived or changed since a cursor) | history.list; delta; CONDSTORE |
| `wc`, `uniq -c` | `mail_count` (exact counts, facets over a sample) | id paging, `$count`, ESEARCH COUNT |
| `Bash` | `provider_get` (read-only allowlisted raw GET), `mail_export` (write threads to files for a host agent's own shell) | |
| memory files | `notes_read`, `notes_search`, `notes_write` for people and matters | local |
| `Edit`/`Write` | `label`, `archive`, `move`, `mark_read`, `snooze`, `draft_create`, `draft_update`, `send`, `unsubscribe`, `calendar_respond`, `calendar_event_create`, `label_by_query`, `archive_by_query` | ActionExecutor, unchanged policy |

Conventions that matter:

- Every row is a compact `MailRow` (about 300 bytes) with an opaque handle, `threadId` and the
  RFC 822 Message-ID so a stale id can be re-found without asking the agent.
- Every result carries `cost` (units spent, budget remaining) and `source` (provider, cache, mixed).
  Agents adjust to costs they can see.
- Interactive tool calls never block for a minute on retries. Past 5 s of backoff they return a
  structured `RATE_LIMITED` result with partial rows and a retry hint. A per-account token bucket
  with three lanes (interactive > arrivals > optional deep index) enforces this before the provider
  does.
- The MCP response budget defaults to 64 KiB. Thousands of ids never pass through the model;
  `archive_by_query` resolves them server-side and issues one `batchModify`.
- Mail bodies, subjects and attachments are untrusted. Tool results and trigger prompts wrap them
  the way T3 wraps webhook data, with `$`, `@` and leading `/` neutered.

### 4.2 Local state

| Keep | Change | Delete |
|---|---|---|
| Credentials (AES-GCM) | `Store.emails.get` becomes read-through: envelope cache → provider → upsert | Full-body mirror and FTS5 over bodies |
| Action log, outbox, trust, decisions | `Store.mailboxes` becomes a cached `mail_labels` with TTL | Backfill, "Load older mail", `sync.initialDays` |
| Arrivals queue | Arrival means "received after the account's watermark", not "first time stored" | Cursor-expiry reconciliation, tombstones, windowed snapshot rules |
| Change cursors | Executor pre-images come from a fresh provider read when the cache is older than the last watcher tick | `people.ts` full-store scans per arrival |
| USER.md | People and matters split into structured security state plus markdown notes | Matter and person tables as derived views over the mirror |
| Calendar: a bounded forward window plus `freeBusy` wired through (it exists, it is not connected) | | |

The envelope cache schema and eviction rules are in research report 03 §3.2. Immutable fields are
kept indefinitely (LRU at 100k rows); labels and flags carry a freshness stamp patched by the
watcher at 2 units per history page, never by refetching. If a cursor expires, mark labels stale
and sweep `in:inbox newer_than:2d`; do not resync.

Offline is degraded by design: cached reads with `staleAsOf`, writes held until reconnect and
re-validated. This gives up the v0.2 "search everything offline" property. That is a product
decision worth stating in the README.

### 4.3 Task model

Adopt T3 Code's shape with email vocabulary (avoid "thread", which already means a conversation):

| T3 Code | Passport |
|---|---|
| Environment | One Passport host: the Mac app or `passport serve` |
| Project | Account, or an account group; a task can bind one or many |
| Thread | **Task** |
| Run, execution nodes | One agent pass with streamed tool calls, collapsed read groups |
| Permission mode per thread | Permission mode per task, defaulting from the trust ladder; `supervised / auto_accept_edits / auto / full_access` already match |
| Plan mode | Propose only: no mutations, a proposal list |
| Approval panel at composer | Same, with accept / accept for task / always / decline |
| Checkpoint + per-turn diff | Per-run change summary backed by ActionRecords and undo |
| PR, merge | Draft review, then send through the delayed outbox (send is the merge) |
| `watch_pull_request` | `watch_conversation` |
| Scheduled tasks, webhooks | Routines and the new-mail trigger, with replay and coalesce keys |
| Sidebar: Pinned / Active / Working / Snoozed / Settled | Same |
| AGENTS.md | USER.md, injected by Passport because there is no repo for the CLI to load it from |
| Worktree | **No analogue.** A mailbox cannot be forked. Choose: approve each action, or accumulate a task's writes as staged ActionRecords applied on approval. Start with per-action approval; staging is the follow-up. |

The queue stops being global. Interactive tasks get their own lane; the Inbox task and routines
run in a background lane that yields to it.

### 4.4 Providers

`MailProvider` gains an optional `reader(): MailReader` (append-only in `@passport/types`) with
`search`, `envelopes`, `thread`, `body`, `countIds`, `changes`, `findByRfc822`. The mock
implements it first; Gmail, Graph, IMAP and JMAP follow. Gmail uses the batch endpoint for metadata
and `batchModify` for writes. Graph needs a translator that picks `$search` (free text, no sort,
1,000 cap) or `$filter` (structured, sortable, countable) and says which it used. IMAP pushes cheap
keys to the server and greps bodies locally over a capped candidate set.

Push is deferred. Gmail polling of `history.list` every 30 s costs about 240 units an hour. Gmail
Pub/Sub pull and Graph subscriptions (which need a public HTTPS endpoint) are opt-in later.

### 4.5 Mac app

From research report 04. Electron, mirroring T3 Code's backend-as-child pattern:

- Main process spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` running the unchanged server
  CLI. Electron 44.9.3 and 45 ship Node 24.22.0 with `node:sqlite` 3.53.4 and FTS5 (verified by
  probe against the installed T3 Code build), so the "no native modules" rule holds.
- Attach to an already-running `passport serve` instead of fighting the owner lock.
- PATH is hydrated from the login shell (`$SHELL -ilc`, then `launchctl getenv PATH`), the way T3
  does it, so `claude` and `codex` resolve when launched from Finder. Settings expose binary paths.
- Master key moves into Keychain via `safeStorage`, delivered to the child as `PASSPORT_MASTER_KEY`.
  The store's encryption is unchanged.
- Menu-bar count and notifications come from a main-process WebSocket subscription, not the
  renderer, because the window may be closed. T3 has neither; Passport needs both.
- Not sandboxed, so no App Store. Notarized DMG plus zip from GitHub Releases, electron-updater.
- Installed size about 250 MB. Tauri or a Swift shell would be roughly half, at two to three times
  the effort and with no working reference. The process boundary (HTTP, WS, env) means the shell can
  be swapped later without touching the server.

## 5. Contract changes

`docs/CONTRACT.md` "Things that must be true" entries that exist only because of the mirror are
removed: tombstones, cursor-expiry reconciliation, full-resync annotation preservation, windowed
snapshots, backfill-only-widens. These stay and are now mirror-independent in practice too:

- Every locally originated change is an ActionRecord with an inverse unless irreversible. Inverse
  capture reads a fresh provider pre-image.
- `send` is held when `outboxHoldMinutes > 0`.
- External agents are capped by `externalAgentCeiling`.
- Verification comes from headers, never content, computed once per envelope.

New entries:

- Passport never backfills. The watcher cursor starts at connect time.
- Every provider read declares its quota cost and goes through the per-account governor.
- Provider-derived strings in tool results and prompts are wrapped as untrusted data.
- A task's permission mode cannot exceed the account's trust ladder, and a child task cannot exceed
  its parent.

## 6. Plan

Model assignments follow the v0.2 convention: Claude Opus 5.5 at high effort for features,
GPT-6.1-Sol at xhigh for cleanup and review. One worktree per package, merge to main per feature.

**Wave 1: read on demand (about a week).** Unblocks the owner immediately.

1. `MailReader` contract, mock, quota governor with lanes and bounded interactive retries.
2. Gmail reader: batch metadata, `threads.get`, `countIds`, `history.list` changes, Message-ID
   lookup, `batchModify`.
3. Graph reader with the `$search`/`$filter` translator; IMAP capability-driven search plus local
   grep; JMAP.
4. Envelope cache and body LRU in `@passport/store`; `Store.emails.get` read-through; watcher
   replaces the sync service; arrivals fed by `changes()`; cursor starts at "now".
5. Tools `mail_search`, `mail_list`, `mail_read`, `mail_changes`, `mail_count`, `mail_grep`,
   `mail_labels`; existing read tools become aliases for one release; MCP budget 64 KiB.
6. Delete backfill, "Load older mail", reconciliation, FTS over bodies. Update `docs/accounts.md`,
   `docs/tools.md`, `docs/CONTRACT.md`.

**Wave 2: tasks (about a week).**

1. Task entity, runs, streamed tool-call timeline with collapsed read groups, approval panel at the
   composer, per-run change summary with undo links.
2. Separate interactive and background lanes.
3. Sidebar sections and the inbox semantics; `watch_conversation`; routines as scheduled tasks bound
   to a task; new-mail trigger with replay and coalesce keys.
4. People and matters as notes plus structured security state; `notes_*` tools;
   `mail_attachment_read`; wire `freeBusy`.

**Wave 3: Mac app (about two weeks, M1 to M3 from report 04).**

1. M1: unsigned arm64 `.app` spawning `passport serve`, attach-if-running, login URL in a window,
   OAuth to the system browser, FTS5 smoke test.
2. M2: menu bar, notifications, login item, Keychain master key, `passport://` links, CLI shim,
   binary-path settings, shell PATH probe shared with `passport serve`.
3. M3: signing, notarization, electron-updater on GitHub Releases, Homebrew cask.

Each wave ends with the adversarial review loop from v0.2 before tagging.

## 7. Decisions for the owner

1. **Offline search becomes partial.** Accept that in exchange for zero sync.
2. **Per-action approval versus staged task changes.** Start with per-action, since a mailbox has no
   worktree. Say now if staging is required for v0.3.
3. **Contacts scopes.** `people_lookup` works from mail evidence alone. Google People and Graph
   People scopes are optional extras that make name lookup better.
4. **Electron size.** About 250 MB installed is the cost of reusing T3's exact pattern with no new
   language.
5. **Vocabulary.** "Task" for the unit of agent work, "conversation" for an email thread, "matter"
   unchanged.
