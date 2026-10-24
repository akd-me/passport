# Changelog

Notable changes are recorded here. The first version heading is the CLI artifact
version; release tags must match it. Move Unreleased to a date before tagging.

## [Unreleased]

### Added

- Arrival triage and routines run as agentic task sessions with Passport’s tool belt and notes.
  Newsletters, receipts and service notifications keep model-free policy playbooks; a one-release
  `triage.mode: "pipeline"` fallback and fixture parity coverage remain available. Stable arrival
  IDs, action/checkpoint retry acknowledgement, backlog drop notices and loop guards are preserved.
- First account connect creates a one-time “Learn how you write” task: one Sent search, at most
  50 quote-collapsed messages, and one reversible Voice/Signature/VIP `profile_update` proposal.
  The new category always asks the person, with proposed USER.md visible before approval and
  executor-backed undo. IMAP without Sent skips learning; CLI connects defer it to the server.
- `render` rich task output: server-sanitised restricted HTML in a themed, opaque sandbox,
  full-size viewing, a 64 KiB limit and ten renders per run. Daily digest routines request
  one render; every render counts against the tool-call budget.
- Side-by-side draft review from task approvals and Needs you, with conversation context,
  inline body saves that leave approval pending, and an “As they will see it” preview through
  the same sanitiser and sandbox. One-click approval stays available.
- `passport task start`, `send`, `show`, `list`, `approve` and `reject`, with human-readable
  output and `--json`. `start` and `send` support `--wait` for the submitted run's summary
  (exit 2 when the person is needed). Task commands require the running server and never
  open the store directly.
- CLI usage in the installation guide and a loopback/Tailscale Serve remote-access recipe,
  with offline coverage for configuration, token login, Host/Origin checks and WebSocket
  authorization; remote browsers do not receive the Mac app's native notifications.
- Webhook routines with HMAC signatures, seven-day replay protection, durable coalescing,
  filters, token rotation and the latest 50 deliveries. Routines can run on their bound task
  or create a fresh child task for each run.
- `request_secret` and private task input with encrypted one-use references for webhook
  signing keys and IMAP credentials. Task details now include Automations; routine details
  include Deliveries.
- Task lifecycle v2 (server; the web wiring follows): tasks carry `returnedAt`, `seenAt` and
  `unseenOutcome` (`done` / `woke`) with `POST /api/tasks/:id/seen` and `/mark-unread`. Settle,
  snooze and archive answer with the `previous` state, and `/unsettle`, `/unsnooze` and
  `/unarchive` reopen a task, so every sidebar move can be undone.
- A server-side follow-up queue: a message sent while the task is busy waits in `Task.queue`
  and can be read, edited, reordered, removed or promoted to a steer under
  `/api/tasks/:id/queue`. Stop (and settle, archive) hold the queue (`queueHeld`) until
  `/queue/resume` or the next message.
- The Limited state: a run stopped by a Codex or Claude Code subscription limit or a provider
  429 sets `needsUser: "limited"` and `Task.limited { resetAt, autoResume }`. `/resume` continues
  the run now, `/resume-at-reset` continues it when the limit resets, and the queue waits.
- Restart continuation: a message, watch or wake run cut off by a restart continues once, with a
  `RESTARTED` notice listing what was in flight, instead of failing.
- Generated titles: after a task's first run the fast model proposes a title of at most 60
  characters (`titleGenerated: true` until you rename it).
- `@passport/types` exports `isTaskWorking` and `taskBadge` (Approval, Input, Working, Waiting,
  Limited, Failed, Woke, Done); the server's status rules live in one `resolveTaskStatus`.
- ⌘1–⌘9 open the first nine sidebar tasks, Escape closes the details panel, ⌘Enter sends with
  the opposite of the default send mode, and ⌘Z undoes a pin or unpin while its five-second
  toast shows.
- The web UI wires the lifecycle: the sidebar orders tasks by when they came back to you
  (`returnedAt`), rows recede once seen and come forward with Done and Woke marks, opening a task
  marks it seen, and the row menu has Mark unread. Settle, snooze and archive now offer Undo in
  their toast and on ⌘Z, through the reopen routes, putting back a snooze or settle they
  replaced.
- A queue strip above the task composer: queued follow-ups as rows you edit in place, drag (or
  Alt+↑/↓) to reorder, steer now or remove; after Stop it reads "Queue held · Resume".
- Limited tasks show when the limit resets with Resume, Resume at reset and Snooze until reset,
  in the task header and on Needs you.
- Task titles rename in place from the header; a title Passport suggested reads muted until you
  rename it. A restart that interrupted a run shows as "Picked up after a restart" with what was
  in flight.
- The agent can ask you a question (`ask_user`): it shows above the composer with its suggested
  answers and Dismiss, the task waits in your inbox with the Input badge, and your answer (or
  any message you send meanwhile) becomes the next run's message through the queue.
  `POST /api/tasks/:id/questions/:itemId/answer` and `/dismiss`; Needs you lists questions in
  their own group.
- Subtasks: `task_delegate` starts child tasks (async, or wait to end the turn and wake with
  the result) that never exceed the parent's mode or accounts and nest at most two deep;
  `task_status` and `task_cancel` follow and stop them. A finished subtask notifies its parent
  and wakes it (`completionWake: settled_only | always`, completions coalesce into one wake); a
  subtask's question goes to the parent's agent, never to you, and subtasks cannot approve
  anything. Task details gain a Lineage panel (`GET /api/tasks/:id/lineage`), the timeline a
  collapsed "Started 3 subtasks, 2 working" line, and subtasks stay out of the sidebar unless
  they need you.
- `task_organize` lets the agent snooze, pin, rename or mark its task unread, and settle it
  when the run ends (unless something then waits on you).

### Changed

- A task run on Codex or Claude Code is now one agentic session instead of up to 12 one-shot
  CLI completions with tools described in the prompt. The CLI gets Passport's tools as an MCP
  server (served from the Passport process on `127.0.0.1` behind a per-run bearer) and calls
  them natively; every call keeps the run's identity, task, permission mode and provider
  readers, and still goes through policy. Tool calls and replies stream into the timeline as
  they happen. See [docs/tasks.md](docs/tasks.md#sessions).
- Follow-ups resume the provider session (`claude --resume`, `codex exec resume`) with a short
  turn: what happened since your last message, the status of the task's proposals, and the
  request. A task without a session, a different host agent, or a session the provider no
  longer has falls back to the history prompt. Tasks gain `providerSessionId` and
  `providerSessionKind`.
- The 12-tool-call cap is gone. Every manual or task run, on a host agent or an API provider,
  has a budget of 200 tool calls and 30 minutes (`agentBudget` in `passport.config.json`,
  `PASSPORT_AGENT_MAX_TOOL_CALLS`, `PASSPORT_AGENT_MAX_RUN_MINUTES`) and ends with a
  `BUDGET_EXHAUSTED` notice when it runs out, keeping the work done so far.
- Task runs' system prompt gains a short orchestration section: what a task is, how approvals
  come back, the budget and when to hand back.
- `@passport/mcp` exports `ToolBeltListener` and `createToolBeltServer`; `createAgentRuntime`
  takes `toolBelt` and `budget`; `HostAgentLlmClient.session()` runs one resumable session.
- The web UI is restyled to the v0.4 design brief ("classy, not showy") in both themes: warm-grey
  surface steps instead of borders, one desaturated indigo accent for the primary action, focus
  and the Needs you count, five type sizes, one control radius and one panel radius, and a single
  elevation for popovers and dialogs. Timeline items no longer nest cards: your messages sit in a
  tinted block, replies are plain prose, run headers are a hairline, and decisions hang from an
  accent rule. The approval panel above the composer is a calm list. Sidebar rows are one 36 px
  line with small-caps section headers.
- One status mark set (Approval, Input, Waiting, Working, Limited, Failed, Woke, Done) is used by
  the sidebar, the task header, Needs you and the task list.
- `styles.css` and `styles-tasks.css` are now tokens plus layered component and screen sheets
  under `apps/web/src/styles/`; dead rules are removed.
- Needs you groups the tasks waiting on you by what they wait on (Approvals, Paused at a usage
  limit, Failed, then anything else), from one list in `apps/web/src/views/needs-you-groups.ts`
  that later kinds join with one entry.
- The status mark comes from `taskBadge` in `@passport/types`, so a pending approval now
  outranks a failure.
- `docs/screenshots/task-dark.png` is a dark capture again (it was the light one); the task and
  Needs you screenshots are recaptured and `queue-strip-light/dark.png` are new.

### Fixed

- Secret responses and expiry clear pending request IDs even after the requesting run ended;
  regression coverage includes saved, declined, cancelled and timed-out requests (R1-18).
- Server lifecycle and tool writes share the types package's waiting-state and task-stamping
  rules, including pending secret requests (R1-18, R1-19 integration).
- Inbox and routine message, watch and wake runs stay ephemeral, including continuations;
  only user tasks keep resumable CLI transcripts (R1-5 integration).
- Restart continuations and limit resumes run as host-agent sessions with the tool belt and
  resume the task's provider session; they repeat the run's whole request (a steer's cancelled
  message, an answer's question) and, on a fresh session, the task history (R1-4, R1-17).
- A continuation keeps a snooze the person chose; resume-at-reset no longer brings back a task
  the person settled or archived; snoozing a busy task holds its queued follow-up (R1-15,
  R1-16, R1-32).
- `request_secret` and `ask_user` keep separate Input state: resolving one leaves the task
  waiting while the other is open (R1-18, server side).
- The permission ceiling is read on every policy decision, so lowering a task's or a parent's
  mode, or switching to plan, reaches a running session; runs pass the task's accounts to the
  tools (R1-9, R1-10).
- A Stop or steer that lands while a run is finishing no longer cancels it, re-sends its
  request or skips its run-end hooks (R1-8).
- Subtasks: the person's Stop, settle or archive of a subtask notifies its parent without
  waking it, and the parent cannot undo it; Stop on a parent, or a limited parent, is not woken
  by finishing subtasks; the depth limit counts the real ancestry; restart recovery reports a
  subtask's end to its parent; arrival and scheduled runs cannot delegate (R1-11 to R1-14,
  R1-1).
- `/resume` keeps Approval or Input when proposals or questions wait; snooze wake-ups and
  auto-settle re-check the task and follow the status rules; "try again in 340ms" parses as
  milliseconds; a steered or continued first run still gets a generated title; Stop leaves no
  Done badge (R1-26 to R1-29, R1-31).
- Dismissing a question twice answers 409 with one notice; parallel `ask_user` and
  `task_delegate` calls respect their limits; `task_organize` no longer overrides the person's
  snooze, settle or title; prompts quote task titles as labels and frame a subtask's request in
  the title prompt; the resumed turn lists the last 10 proposals however busy the task is
  (R1-30, R1-34 to R1-36, R1-40).


### Fixed

- Webhook new-window budgets count accepted windows only; filtered, duplicate and rejected
  deliveries leave room for eligible events.
- Webhook queues are bounded per routine and globally, persist in separate routine records,
  and retain only prompt previews in delivery history.
- Invalid webhook signatures have a separate rejection budget. Unknown URLs are throttled
  before reading request bodies, deep JSON is rejected with a delivery record, and credential
  substrings are redacted from request headers and query values.
- Account connection tests peek at private references and never queue voice learning. Account
  and webhook setup consume references only after persistence succeeds, cleaning up failed installs.
- Saved private references expire after one hour by default, retain their deadline across restart,
  and are swept by store maintenance. References from older builds without an expiry are revoked.
- Saving a draft now shares the action executor's approval lock, preserves the agent's original
  for edited-approval trust feedback, and returns `409 ACTION_DECIDED` if approval wins the race.
- `passport task start/send --wait` polls a durable run lookup instead of the latest 50 runs,
  and tolerates brief connection or server errors with bounded retries.
- Arrival triage sessions may call only the tools the triage prompt names (mail, notes and people
  reads, matters, notes, reply drafts, scheduling, and label/archive/mark-read of the arrival
  itself); `task_delegate`, `ask_user`, `task_organize`, `request_secret`, `render` and the rest
  answer `INPUT_TRIAGE` (R1-1).
- The category the model picks for an arrival applies to that arrival's own organize call only;
  later drafts and mail operations keep their inferred policy categories (R1-2).
- A failed arrival session is no longer acknowledged on retry because people-resolution actions
  exist: inference is repeated unless the session organized the arrival, and a session that
  stopped after partial work fails so the arrival queue surfaces it (R1-3).
- Only resumable task runs (message, watch, wake) keep a CLI transcript; arrivals, routines and
  voice learning run with `--no-session-persistence` / `--ephemeral` and record no provider
  session (R1-5).
- A failed resume starts a fresh session only when the CLI reports the session missing
  (`HOST_AGENT_SESSION_MISSING`), and the fresh id is recorded once that attempt succeeds (R1-6).
- Codex sessions offer only Passport's MCP tools: native-tool features and `request_user_input`
  are off, and a rewritten model catalog removes code-mode `exec`, `apply_patch`, sub-agents and
  clock tools (R1-7).
- Task account scope is enforced on tool calls (`AgentRunOptions.accountIds`,
  `ACCOUNT_FORBIDDEN`) (R1-10).
- `request_secret` follows the question status rules and records `pendingSecretRequestIds`, so
  a question and a secret request no longer clear each other's Input state; tool-side task
  writes stamp `returnedAt`, and the watch tools no longer move `lastActivityAt` (R1-18, R1-19).
- The render sanitiser runs in linear time, keeps a stray `<` in text, decodes common named
  entities and link URLs once; failed renders count toward the 10-per-run limit (R1-25, R1-50,
  R1-51).
- Usage limits reported only on stderr or as Claude result text are classified as limits, and an
  API 429's `Retry-After` becomes the reset time (R1-33).
- An expired time budget aborts tool calls still running after a 10 s grace (R1-37).
- Claude sessions read the system prompt (with USER.md) from a private file instead of argv
  (R1-39).
- The tool belt's MCP tool timeout exceeds the longest `request_secret` wait (R1-46).
- A pending profile proposal ends voice-learning sampling for the account, so a restarted run
  cannot propose a second profile (R1-49).


## [0.3.2] — 2026-10-24

### Fixed

- Passport's replies in a task timeline showed raw markdown (`**bold**`, `- ` bullets). They are
  now rendered as a markdown subset (paragraphs, headings, nested lists, tables, quotes, inline
  and fenced code, emphasis) through a small React renderer that builds elements rather than
  HTML. Raw HTML stays text; links and images are shown as text with their URL, never as anchors
  or images, so quoted mail cannot smuggle a destination into a reply. Your own messages, mail
  snippets and notices remain plain text.

## [0.3.1] — 2026-10-23

### Fixed

- The built-in agent runtime built its tool registry without the on-demand readers, so in a task
  every `mail_search` / `mail_read` / `mail_grep` call failed with `ON_DEMAND_UNSUPPORTED` for a
  connected Gmail or Outlook account and the model fell back to the local cache. The runtime now
  passes the same readers its own reads use. MCP clients were unaffected. The error message now
  says what is missing (a provider reader) instead of pointing at "legacy store tools".

## [0.3.0] — 2026-10-22

### Added

- Tasks ([docs/tasks.md](docs/tasks.md)): the unit of agent work, like a T3 Code thread. A task
  holds runs (interactive lane for your messages, background lane for arrivals, routines and
  wakes) and a timeline of items: messages, redacted tool calls, approval requests, notices and
  notifications. It has a server-owned lifecycle (inbox / working / snoozed / settled /
  archived; auto-settle after 3 idle days). Follow-ups queue or steer; interrupt stops a run at
  its next step. Plan mode records writes as proposals. A task's permission mode is clamped to
  the trust dial and its parent, and enforced on every action of its runs. Proposed actions
  surface the task with `needsUser: "approval"`; approvals still use `/api/actions/:id/approve`.
  New routes under `/api/tasks`; new WebSocket events `task.updated`, `task.run.updated` and
  `task.item.appended`. `/api/agent/run` now creates a task per instruction and returns its
  `taskId`.
- Every mail account gets a system Inbox task that records arrival triage as a timeline. Model
  routines (`agent.daily_digest`, `agent.matter_review`, user routines) each run on their own
  routine task (`JobState.taskId`).
- `watch_conversation` / `unwatch_conversation` tools: a task is woken when someone else replies
  on a conversation, a bounce or auto-reply arrives, or after 14 days. Replays are deduped on
  Message-ID for 7 days, bursts are coalesced per thread over 120 s (persisted across restarts),
  and 3 automatic, no-op or unattended-send wakes in a row stop the watch.
- `POST /api/tasks` accepts `matterId` and `emailIds` (ULIDs or mail handles) like
  `/api/agent/run`, validates them and `accountIds` (`UNKNOWN_MATTER`, `UNKNOWN_EMAIL`,
  `UNKNOWN_ACCOUNT`, `ACCOUNT_MISMATCH`), and records a `notification` naming the context on the
  timeline.
- `GET /api/tasks/by-action/:actionId` returns `{ taskId, runId }` for an action, archived tasks
  included, so `?decision=<id>` deep links open the right task.
- Approval scopes: `POST /api/actions/:id/approve` takes `{ scope: "once" | "task" | "always" }`.
  `task` approves later proposals of the same category in that task (never riskier, less
  reversible or at a lower trust level than the approved one, and never past an always-ask
  rule); `always` pins the category to `auto_accept_edits` for reversible actions and otherwise
  acts as `task` with an `ALWAYS_UNAVAILABLE` notice. New `Task.approvalGrants`.
- Hooks for integrators: the tool registry `observer` and `readOnly` options and
  `ToolContext.taskId`; `AgentRuntime.run(trigger, { runId, observer, readOnly, taskId, signal,
  priority })`; the policy engine `ceiling` option; `Store.tasks`.

- Passport.app deep links `passport://task/<id>` (→ `/tasks/<id>`), `passport://needs-you` and
  `passport://tasks`.

### Changed

- Mail is no longer mirrored. Connecting an account takes a change cursor at "now"; Passport never
  backfills. A new-mail watcher (`watch:<accountId>`, every 30 seconds, `watch.intervalSeconds`;
  IMAP IDLE checks at once) follows `MailReader.changes` in the `arrivals` quota lane, caches new
  envelopes under mail-handle ids and triages new Inbox mail that is not from you. Label changes
  and deletions only patch the local cache. An expired cursor marks labels stale and runs one
  bounded sweep (`in:inbox newer_than:2d`, 100 messages, deduplicated). Rate limits back off the
  watcher and never fail the account. New `account.watch.*` events.
- `GET /api/emails` is provider search (`q`, `account`, `limit`, `pageToken`; cache-only without a
  reader); `GET /api/emails/:id` and `POST /api/agent/triage/:id` accept mail handles and read
  through the cache; `GET /api/threads/:id` reads a thread handle from the provider. Rate-limited
  reads answer `429` with `Retry-After`.
- `GET /api/accounts`: `messageCount` is the provider Inbox total from label counts, plus `watch: {
  since, lastTickAt, cursorAgeSeconds, status }`; `syncing` is gone. The label tree refreshes on
  connect and every 10 minutes. Doctor reports watcher health (last check, cursor age) and calendar
  sync age separately.
- Calendars keep the bounded sync; arrivals wait at most one minute (was ten) for a related
  calendar. Composer runs start before queued background arrival and schedule runs.
- Settings → Accounts shows "Watching since … · last check …" and the Inbox count; the sidebar
  shows Watching, Paused or Needs sign-in. Workspace refetches are throttled per event type.
- `store.maintenance` also evicts cached bodies and envelopes.
- Passport.app: the menu-bar count and Dock badge are the tasks that need you plus proposals no
  task owns, matching **Needs you** (pending decisions against a server without task routes, such
  as the demo). They refresh on `task.updated` as well as `action.*`. Notifications also fire when
  a run fails, name the task, and open it; the menu item opens `/needs-you`.
- Docs for v0.3: the README leads with the Mac app and the on-demand model; install and deploy
  cover `watch.intervalSeconds`, the data directory (including `scratch/`) and the DMG's
  right-click → Open; `docs/security.md` and `SECURITY.md` cover untrusted-data framing, what an
  agent can and cannot do, sealed page tokens, the Keychain key and partial offline search.
  `SECURITY.md` no longer says the HTTP API is unauthenticated.

### Security

- Review r4 fixes for the task model, watcher and on-demand tools:
  - Server prompt framing can no longer be forged: mail text is wrapped in a per-frame random
    `<untrusted-data-…>` tag and any `untrusted-data` tag inside it is defused (R4-1).
  - `mail_export` never writes through symlinks: the session and `attachments/` directories must
    be real 0700 directories inside the scratch root, files are created exclusively, names are
    hashed ids, bodies are quoted, and exports older than 24 h are actually swept (R4-2, R4-14,
    R4-36, R4-37).
  - Message-ID, In-Reply-To and References, attachment names, summary fields, JSON keys and MCP
    people/matter resources (notes fenced last) are neutralised and marked untrusted; the
    neutraliser also covers fullwidth sigils, Unicode indentation and NEL (R4-3, R4-4, R4-5,
    R4-33, R4-34, R4-35).
  - Model-supplied regexes are bounded: long or catastrophic patterns are refused, and
    `mail_grep` and `notes_search` (`Store.notes.search` with `pattern`) match in a worker with a
    2 s limit (`PATTERN_TIMEOUT`) (R4-6).
  - The `matter_review` prompt and the manual run's initial context wrap matter and mail data in
    the random-tag frame and leave out agent-written matter notes and refs (R4-24).
  - `watch_conversation` accepts only thread handles, is planned (not run) in plan mode and
    refuses settled or archived tasks (`TASK_SETTLED`) (R4-9, R4-17, R4-18).
  - Watcher and calendar-sync failures carry a bounded code and fixed text into job history and
    `job.finished` (R4-26).

### Fixed

- Watches: coalesced wakes survive a restart, the loop guard counts each wake once and catches
  autoresponder ping-pong, and a guard stop or expiry surfaces the task before auto-settle
  (R4-7, R4-8, R4-10). Settle, archive and snooze during a run win when it ends (R4-9); steer keeps
  the cancelled message on long tasks and no longer bounces the task (R4-19, R4-20); maintenance
  wakes every due snoozed task (R4-21).
- Arrivals: the queue keeps the newest 200 and drops arrivals older than 24 h, so configuring a
  model later is not a backfill; messages gone at the provider are dropped after one retry; both
  leave an `ARRIVALS_DROPPED` notice on the Inbox task (R4-11, R4-12).
- `GET /api/emails` across accounts returns the healthy accounts plus `skipped[]` (R4-13).
- `mail_read` resumes at the text actually returned under the MCP budget, and large
  `mail_grep`, `provider_get`, list and `mail_export` results are clipped with `omittedItems`
  instead of failing (R4-15, R4-16).
- Smaller fixes: account changes no longer 500 when the scheduler failed to start (R4-25); the
  watcher no longer clears a calendar sync error (R4-28); the retired `sync` block is not written
  back (R4-30); broken IMAP reader connections are replaced (R4-31); explicit triage of a queued
  arrival answers 409 (R4-32).
- A data directory first opened by the pre-release task-model build gets its missing
  `matter_refs` table: the migration is idempotent and re-applied, and the store refuses to open
  a database that lacks a required table (R4-27).

### Removed

- Backfill (`POST /api/accounts/:id/backfill`, **Load older mail**), the windowed mail snapshot,
  mail reconciliation and tombstoning by the sync service, and per-poll Gmail label refresh.
  `sync.initialDays` is accepted with a one-time deprecation warning and ignored.

## [0.2.0] — 2026-10-21

### Added

- Host agents: the agent now runs on the Codex or Claude Code subscription
  signed in on the host machine, with no API key. New `codex` and `claude-code`
  providers drive the CLIs (`codex exec --json`, `claude -p --output-format
  stream-json`) for completions and for agentic sessions with MCP servers
  (`runHostAgentSession`, groundwork for browser-driven account setup).
- `auto` model selection (the new default): Codex, then Claude Code, then a
  configured API provider, else no agent. Explicit choices are persisted.
- `GET /api/host-agents`; `PUT /api/settings/llm` accepts `codex`,
  `claude-code` and `auto`. `passport init` detects host agents and keeps
  API-key providers under "advanced"; `passport doctor` reports each CLI with
  its fix and test-pings the selected one. Accounts shows detected agents.

- Agent-driven account setup: **Set up with my agent** (Accounts) and `passport accounts connect
  --provider gmail|microsoft` start a task in which Codex (`gpt-6.1-sol`, high reasoning; Claude Code
  as fallback) drives a visible browser (Playwright MCP, pinned) to create your own Google or Microsoft
  OAuth client, asks you to sign in and approve, and connects the mailbox. New `/api/setup/tasks`
  routes and the `setup.task.updated` event; the setup tools run on `127.0.0.1` behind a per-task
  bearer token. The setup browser profile lives in `<data dir>/setup-browser-profile`; keep it out of
  backups. Host-agent MCP servers accept startup/tool-call timeouts.

### Fixed

- Account setup: answering **No** to an agent's confirmation now reaches the agent as declined
  (it used to read as "Continue"); `/api/setup/tasks/:id/respond` accepts `yes`/`done` or `no` for
  confirm prompts and `done` for sign-in prompts, and rejects anything else with 400 without
  clearing the prompt. A blank answer to a question also leaves the question answerable.
- Account setup: cancelling (or ending) a task revokes the OAuth attempts it started; a consent
  that lands afterwards, including one already exchanging its code, connects nothing and shows
  "This setup task has ended". The manual Accounts flow is unchanged.
- Account setup: the agent asks one message at a time; a second, different `ask_user` while one
  is unanswered returns an error telling it to wait, instead of hiding the first.
- Account setup: a cancelled or finished task keeps the single setup slot until its agent and
  browser have shut down (`409 SETUP_BUSY`, "finishing up"), so the next task's browser and
  output are not cleaned up by the old one; server shutdown stops and waits for every task.
- Account setup: registering a client secret rescrubs text already in the task (log, steps,
  prompt, error), and agent narration drops token-like strings (16+ characters mixing letters
  and digits) before it is logged.
- The Playwright MCP download (`npx`) runs with an allowlisted environment instead of the
  server's full environment, so `PASSPORT_*` values and provider API keys are not passed to it.

### Changed

- API keys are optional. Existing configurations that only held the old
  placeholder default switch to `auto`; any other saved model choice is kept.

### Fixed

- Host-agent POSIX process groups now escalate to SIGKILL even after the CLI leader exits,
  retain exit cleanup until the group is gone, and settle runs after a bounded stdio drain (V2-3).
- Returning to automatic model selection retains and persists the latest configured API
  provider rather than an earlier placeholder (V2-7).
- Codex JSON output with array or scalar roots uses prompt instructions and local validation
  instead of an incompatible strict output schema (V2-8).
- Codex sessions enforce `maxTurns` using streamed turn/tool starts and report
  `HOST_AGENT_MAX_TURNS` when the budget is exceeded (V2-9).
- Malformed Claude authentication status and individual CLI probe failures no longer hide
  a healthy Codex installation during host-agent detection (V2-14).
- Web: closing the connect dialog no longer orphans a running setup task. The task lives in
  app state, reopening the dialog returns to it, a running or waiting task is recovered from
  `GET /api/setup/tasks` after a reload (or when starting hits `SETUP_BUSY`), and a sidebar
  entry under Accounts reopens a setup that is waiting for you.
- Web: setup status polling no longer overlaps requests, and late or out-of-order snapshots
  (polls or WebSocket frames) can no longer replace a newer one or hide an agent's prompt.
- Web: a composer instruction that fails no longer overwrites a draft typed while it ran; the
  failed instruction is offered as Retry instead.
- Web: the composer placeholder, send hint, decision key hints and empty sidebar text use
  `--muted` and reach WCAG AA contrast (4.5:1) in light and dark; `--faint` is kept for
  decorative strokes.

## [0.1.0] — 2026-10-20

### Added

- Local-first mail and calendar harness backed by SQLite with full-text search,
  encrypted provider credentials, a people graph and matter workspaces.
- Decisions feed, editable draft approvals, trust controls, action history and
  undo for reversible actions; delayed outbox with release and cancellation.
- Earned trust per category, promotion offers, decay, counterparty verification,
  and an external-agent permission ceiling.
- Bring-your-own Gmail, Microsoft Graph, IMAP/SMTP, JMAP, Google Calendar,
  Graph Calendar and CalDAV adapters; OAuth setup uses state and PKCE.
- Anthropic, OpenAI, OpenAI-compatible and Ollama model adapters, automatic
  triage, USER.md standing instructions, daily digests and matter reviews.
- Mailbox MCP over stdio and loopback Streamable HTTP; reads, drafts, mail,
  calendar, people and matter tools share the policy executor for writes.
- Offline fixture demo, React UI, local API/WebSocket server and CLI.
- Single `@akd-me/passport` npm artifact with bundled workspace code and web UI,
  project MCP registration, Docker deployment and tag-driven release automation.

### Hardened

- Fixed 36 review findings across pre-release hardening waves covering API
  authentication and request boundaries, owner coordination, durable ingestion,
  provider identity/recurrence handling, policy enforcement and outbox approvals.
- Arrival retries now resume persisted triage steps and reuse recorded actions;
  exhausted retries surface the incomplete step for human review.
- Calendar proposals wait for complete, fresh sync data before release, with
  bounded hold extensions and an explicit availability-unverified review state.
- MCP install previews redact secrets in arguments, environment values, URLs and
  printed paths. Packed CLI smoke coverage authenticates its API checks and runs
  as a separate CI job.

### Known limitations

- Pre-release software. Live OAuth consent/refresh, provider send/calendar
  delivery, real model interoperability, Docker deployment and registry publishing
  remain unverified by the offline suite and local package smoke test.
- The HTTP API requires a bearer token or browser session with Host/Origin
  checks. Keep it on localhost or behind a private access boundary. One backend
  writer per data directory.
- Persistent storage needs SQLite FTS5: stock Node 22.5 lacks it despite exposing
  `node:sqlite`. Use Node >=22.16 with FTS5, preferably Node 24. The CLI reports
  missing FTS5 before opening the workspace; the demo works on Node 22.5.
- Irreversible actions, including delivered sends, cannot be undone. Trust is a
  policy boundary, not a prompt-injection proof.
- Hosted identity and SMTP+ are parked. No hosted Passport service is required.
