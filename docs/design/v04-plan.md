# Passport v0.4: the agent runs like a coding agent, and the app feels like one you keep

Status: accepted 2026-10-24. Base: `v0.3.2` (`1bbdcb4`). This is the brief every v0.4 work item
is built from. Read it whole before starting any item below. Behaviour that already exists is
documented in `docs/tasks.md`, `docs/tools.md`, `docs/scheduler.md`, `docs/desktop.md`; the
rules that must stay true are in `docs/CONTRACT.md`.

## Outcome (2026-10-24)

At `main` `781a09b`, the runtime/server work shipped: native resumable task sessions, questions,
subtasks and organise tools, seen/reopen lifecycle, editable queue, Limited recovery, restart
continuations, webhook routines, private-input references, restricted renders, draft review,
voice learning on connect and task CLI commands with durable run polling. The final web fix
stream and release integration remain pending. The scoped tools, temporary host directories,
transcript persistence and R1 corrections are described in the current reference docs.

Deferred: staged task changes, fork/merge-back, private reference handoff in account setup and
the routine form, plus the remaining limitations in [tasks](../tasks.md#known-limitations-2026-10-24)
and [scheduler](../scheduler.md#known-limitations). Live OAuth/provider checks remain unverified.
[R1 mismatch and fix-handoff dispositions](v04-docs-audit.md) record the review inputs
(`review-r1.md`, `review-r2.md`) and the UI work left to the web pass. The brief below records
the original work breakdown; this Outcome and the reference docs describe the shipped result.

## 1. Why

v0.3 adopted the T3 Code thread model well, but the agent underneath does not run like a coding
agent, and the UI reads as a prototype. Findings from the 2026-10-24 audit:

- A task run on Codex or Claude Code is **not an agentic session**. Every step spawns a fresh CLI
  process as a one-shot completion with the tool catalogue described in the prompt and the model
  returning JSON (`packages/agent/src/host/client.ts` `complete`, loop in
  `packages/agent/src/manual.ts`). Each step replays the transcript. The run is capped at **12 tool
  calls** and says so. The agentic path `runHostAgentSession` exists and is only used by account
  setup (`apps/server/src/setup/runner.ts`).
- A follow-up message gets the title plus 16 recent items in 6,000 characters
  (`apps/server/src/tasks/service.ts`). Tool results from the previous run are gone.
- Arrival triage is still the v0.2 fixed pipeline (`packages/agent/src/triage.ts`): heuristics
  plus two or three structured completions per email. The Inbox task only records it.
- The agent cannot ask the person a question (`question` is reserved), cannot spawn a child task,
  and cannot snooze, settle, pin or rename its own task.
- Settle, snooze and archive have no undo and no reopen route. Titles are the first 60 characters
  of the message. There is no rich output. The queue of follow-ups is invisible.
- The UI: cards nested in cards, three competing border weights, status conveyed by five different
  glyph styles, a composer that competes with the approval panel, and sidebar sections that shout.

T3 Code Orchestrator V2 (stable 2026-10-15, `pingdotgg/t3code`, design docs in
`docs/orchestration-v2/`) solved the orchestration half. The research summary used for this plan
is in `docs/design/research/05-t3-orchestrator-v2.md`. The concepts we adopt, with their T3 names:

| T3 V2 | Passport v0.4 |
|---|---|
| MCP injected into the Claude Agent SDK / `codex app-server` session; one streamed turn per run | One `runHostAgentSession` per task run with Passport's own MCP server as the tool belt; resume the provider session on follow-ups |
| `isThreadWorking` pure predicate; inbox ordered by "returned to you"; badges Approval / Input / Waiting / Working / Limited / Failed / Woke / Done | Same predicate over `Task`; `returnedAt`; `seenAt` and mark-unread; the same badge vocabulary |
| `RuntimeRequest` kinds `approval` and `user_input`, `blocking`, dismiss | `question` items, `needsUser: "question"`, answer and dismiss routes |
| `delegate_task` with `workState`, `completionWake`, child questions bubbling to the parent, no self-approval | `task_delegate`, `task_status`, `task_cancel` tools; child tasks in a lineage panel |
| `t3_thread_organize` | `task_organize` (snooze, settle, pin, rename, mark unread), settle deferred to run end |
| Server-side queue with edit / reorder / promote-to-steer; queue held after Stop until Resume | Same, as `/api/tasks/:id/queue` and a queue strip above the composer |
| Limited state with resume now / at reset / snooze until reset | Same, for Codex and Claude subscription limits and provider 429s |
| Scheduled tasks: webhook trigger with signature, replay key, coalesce window, filters; delivery log; per-thread Automations panel; bound thread versus fresh thread per run | Same on routines; `request_secret` for signing secrets and IMAP passwords |
| `html_render` with injected theme variables; `html_preview` self-check | `render` tool producing a `render` timeline item: digests, triage tables, draft-as-received preview |
| Restart continuation: tell the agent what died | `RESTARTED` notice with the interrupted work listed; the run resumes rather than fails |
| `t3 thread start/send --wait/show/list` | `passport task start / send --wait / show / list` |

Not adopted: worktrees and workspace strategies (a mailbox has no fork), PR guides, device and
preview automation, Claude workflow projection, fork and merge-back (deferred).

## 2. Shared rules for every work item

1. **Branch from `main` in your own worktree.** Commit as you go with conventional messages
   (`feat(tasks): …`, `fix(web): …`). Do not push, do not tag, do not touch `CHANGELOG.md`
   version headings; add your lines under `## [Unreleased]` (create it if absent).
2. **Keep the gates green in your worktree before you finish:** `pnpm build`, `pnpm lint`
   (Biome plus typecheck) and `pnpm test`. Tests use offline fixtures only. Server route tests
   must import `createApp` from `apps/server/src/auth.test-client.ts` or they answer 401.
3. **Minimise merge conflicts.** Put new server code in new files with one-line hooks in
   `app.ts`, `cli.ts`, `server.ts` or `compose.ts`. Put new web code in new files under the
   feature's folder. Do not reformat files you are not changing.
4. **Append-only contracts.** `@passport/types` only grows. New `TaskItem` kinds, `DomainEvent`
   members, routes and tool names are additive. Existing routes keep their shapes.
5. **Tool count.** Adding a registry tool bumps the current `toHaveLength(69)` assertions in
   `packages/tools/src/registry.test.ts` and `packages/mcp/src/transports.test.ts`.
6. **Untrusted data.** Anything provider-derived stays wrapped and neutered exactly as
   `docs/tasks.md` describes. New prompt framing uses `frameUntrusted`. New UI renders agent and
   mail text as plain text or through `apps/web/src/components/Markdown.tsx`, never as HTML.
7. **Policy.** Every write still goes through the action executor under the task's effective
   mode. The agent never approves its own proposals, never raises trust, and a child task never
   exceeds its parent.
8. **Docs are part of the item.** Update `docs/tasks.md`, `docs/tools.md`, `docs/scheduler.md`
   or `docs/install.md` to match what you built, including a "Known limitations" entry for
   anything you consciously left out.
9. **Finish with a report:** branch name, commits, what changed, test totals before and after,
   anything skipped and why. The integrator merges; you do not.

## 3. Design brief for the web UI: classy, not showy

The feeling to aim for: a well-made notebook. Quiet surfaces, one accent, type that carries the
hierarchy, and motion only when state changes. People should want to come back because it is calm
and fast, not because it is decorated. References: the frontend-design notes at
`~/.t3/scratch/passport-refs/frontend-design-SKILL.md` and T3 Code's layout
(`~/.t3/scratch/passport-refs/t3code/apps/web`). Linear and Things are the right register.

**Type.** Keep Public Sans for UI and Source Serif 4 for mail content. Use five sizes, not seven;
weight carries emphasis (500 for names and titles, 400 elsewhere, 600 only for the page title).
Line height 1.5 for prose, 1.3 for rows. Tabular numerals for counts and times.

**Colour.** Neutral surfaces with one warm-grey step between them, never a border where a step in
surface tone will do. One accent, the existing indigo desaturated a touch, used for the primary
action, focus and the "needs you" count only. Amber, red and green are for status words and
dots, never for backgrounds larger than a badge. Dark mode is a first-class pair, not an
inversion: check every screen in both.

**Shape and depth.** One radius for controls, one for panels. No gradients, no glass, no inner
shadows. One soft elevation, reserved for popovers and dialogs. Cards do not nest: a timeline
item is a block with a left rule or a hanging glyph, not a card inside a card inside a card.

**Density and rhythm.** An 8 px grid. Sidebar rows 36 px, timeline items breathe at 16 px, the
reading column stays at 46 rem. Section headers in the sidebar are small caps in muted text with
right-aligned tabular counts. Empty states are one sentence and one action.

**Status vocabulary.** One glyph set for task state, used identically in the sidebar, the task
header, Needs you and the menu-bar count: Approval, Input, Waiting, Working, Limited, Failed,
Woke, Done. A row recedes (muted title) when nothing is new; it comes forward when it returned
to you and you have not seen it.

**The task page.** The timeline reads like a document: your messages right-aligned in a tinted
block, the agent's in plain prose, tool groups as one quiet line that expands, run headers as a
hairline with the trigger and the change summary. The approval panel sits above the composer as
a calm list, not a banner. The composer is one surface: text, then a single row of mode chips
and the send affordance, with queued messages shown above it as editable rows.

**Motion.** 150 to 200 ms with the existing ease, only for appearance, reorder and state
changes. Respect `prefers-reduced-motion`.

**Keyboard.** `⌘K` palette, `j`/`k` rows, `⌘1`–`⌘9` jump to the first nine tasks, `⌘Enter` for
the opposite of the default send mode, `⌘Z` undoes the last sidebar action inside its five-second
window, `Esc` closes. Every control reachable; visible focus ring; AA contrast everywhere.

**Do not** add illustrations, mascots, confetti, animated gradients, or marketing copy.

## 4. Work items

### Wave 1 (parallel, from `main`)

**W1A Agentic session runtime** (Opus 5.5, high). Make task runs real sessions.
- A task run on a host agent (Codex or Claude Code) becomes one `runHostAgentSession` with
  Passport's MCP server attached (stdio child of the server process, or in-process Streamable
  HTTP with a per-run bearer; choose the one that keeps the `ToolContext.taskId` and the task's
  permission mode on every call). Native tool use, no JSON tool protocol, no 12-call cap; keep a
  generous configurable ceiling (default 200 tool calls, 30 minutes) that ends the run with a
  `BUDGET_EXHAUSTED` notice.
- Stream host events into timeline items as they happen: `tool_call` on completion with the
  redacted summaries the docs require, `assistant_message` on text, usage on the run.
- Follow-ups resume the provider session when one exists (`--resume <session_id>` for Claude,
  `thread_id` for Codex) and fall back to the current history prompt when it does not or when
  the provider changed. Record `providerSessionId` on the task (additive field).
- Interrupt and steer terminate the host session process group immediately; a successful result
  already settling remains completed. API loops check cancellation at model/tool boundaries.
- API-provider runs (Anthropic, OpenAI, Ollama) keep the native tool loop but lose the 12 cap
  in favour of the same budget.
- Arrival triage and routines keep working unchanged in this item; W2C moves them.
- The system prompt gains the orchestration instructions the session needs (what a task is,
  how approvals come back, when to stop and hand back). Keep it under 4 KB.
- Tests: fixture-driven stream-json replays for both CLIs through the runtime, including a
  resumed follow-up and an interrupted run. A regression test that an LLM tool call reaches a
  provider reader through the runtime (the v0.3.1 bug).

**W1B Task lifecycle v2, server side** (Opus 5.5, high). Everything below is API and store;
the web wiring is W2B.
- `returnedAt` on `Task` (when it last came back to you, per the T3 inbox rule), `seenAt`,
  `POST /api/tasks/:id/seen` and `/mark-unread`; `unseenOutcome: "done" | "woke" | null`.
- Reopen routes: `/unsettle`, `/unsnooze`, `/unarchive`. Settle, snooze and archive return
  the previous state so the UI can undo.
- Queue API: `GET /api/tasks/:id/queue`, `PATCH /api/tasks/:id/queue/:runId` (edit text),
  `POST …/reorder`, `DELETE …`, `POST …/promote-to-steer`. After `/interrupt` the queue is
  **held** (`task.queueHeld: true`) until `POST /api/tasks/:id/queue/resume` or a new message.
- Limited state: a run that ends because the subscription or provider limit was hit sets
  `task.limited: { resetAt, autoResume }` and `needsUser: "limited"`; `/resume` runs now,
  `/resume-at-reset` schedules through the scheduler, `/snooze` until reset is the existing
  snooze. Detect limits from the host CLI error surface and from provider `429`.
- Restart continuation: on startup, runs left `running` get a `RESTARTED` notice listing what
  was in flight (watches, pending wakes) and are re-queued once instead of failed, unless they
  already restarted once.
- Title generation: after the first run ends, a fast-model completion proposes a title of at
  most 60 characters; `title.generated: true` until the person renames. Mark-unread and rename
  are events.
- Pure status function: move the status rules into one exported `resolveTaskStatus` with the
  Working predicate, and test it as a table.
- Docs: `docs/tasks.md` model, status rules, HTTP API and WebSocket sections.

**W1C Scheduler v2 and secrets** (GPT-6.1-Sol, xhigh, priority tier).
- Webhook trigger for routines: `{ type: "webhook", signature?, maxDeliveryAgeMinutes?,
  dedupe?: { replayKey?, coalesceKey?, coalesceWindowSeconds? }, filters?: [...] }` with the
  T3 semantics (HMAC signature with hex or base64 and optional prefix, 7-day replay key,
  10–3600 s coalesce using the latest payload, at most 16 filters with `equals`, `notEquals`,
  `startsWith`, `in`, `exists` and `[]` fan-out). Route `POST /api/hooks/:token`; prompt
  templating `{{body.x}}`, `{{headers.x}}`, `{{query.x}}`, `{{body}}`, `{{request}}`, each
  framed as untrusted data. A delivery log of the last 50 per routine with outcome
  `accepted | dispatch_failed | duplicate | coalesced | rejected_signature | disabled |
  rate_limited | expired | filtered`. Token rotation.
- `runOn: "bound" | "fresh"` per routine: bound posts a `schedule` run on the routine's task
  (today's behaviour); fresh creates a new `kind: "task"` task per run with the routine as
  parent.
- `request_secret` tool and `secret_request` timeline item: the agent asks for a secret, the
  person enters it in a private field in the task, the value is stored encrypted under a
  one-use `secretRef`, and the model never sees it. Consumers: webhook signatures, IMAP
  passwords in account setup.
- Web: an **Automations** panel in task details for routines bound to the task (last run,
  status, next run, run now, pause) and a **Deliveries** list on the routine page. Put both in
  new files under `apps/web/src/scheduler/`.
- Docs: `docs/scheduler.md` and `docs/tools.md`.

**W1D Design system and restyle** (Opus 5.5, high). Behaviour-preserving.
- Implement §3 across every screen: shell, sidebar, task list rows, task page, timeline,
  approvals, composer, Needs you, home, matters, people, scheduler, settings, dialogs, palette,
  trust. Consolidate `styles.css` and `styles-tasks.css` into tokens plus component layers;
  remove dead rules. Keep class names that tests query, or update the tests with the change.
- Unify the status glyph set in `apps/web/src/tasks/TaskGlyph.tsx` and use it everywhere.
- Add the keyboard behaviours in §3 that do not need new API (`⌘1`–`⌘9`, `⌘Enter` opposite
  mode, `Esc`). `⌘Z` undo for pin/unpin now; W2B extends it.
- Verify both themes by rendering representative screens with react-dom/server plus the CSS
  into `/tmp` HTML and screenshotting (the v0.3.2 method); include the screenshots in the
  report and replace `docs/screenshots/*.png` with new captures of the same screens.
- Every existing web test passes. Add tests for the keyboard behaviours.

**W1E CLI and remote access** (GPT-6.1-Sol, xhigh, priority tier).
- `passport task start "<message>" [--account] [--mode] [--plan] [--wait]`, `passport task
  send <id> "<text>" [--steer] [--wait]`, `passport task show <id> [--items N]`,
  `passport task list [--status]`, `passport task approve <actionId>` and `reject`. `--wait`
  blocks until the run ends; exit code 2 means the task needs the person. Uses the running
  server through the existing client; no direct-store fallback for tasks.
- `passport doctor` gains a line for the host agent session mode once W1A merges (coordinate
  by reading `main` late; do not block on it).
- Docs: `docs/install.md` CLI section; a "Remote access" section in `docs/deploy.md` with a
  tested Tailscale recipe (serve on loopback, `tailscale serve`, token in the URL) and the
  Mac app notification caveat.

### Wave 2 (parallel, after Wave 1 merges)

**W2A Questions, child tasks, organise** (Opus 5.5, high).
- `ask_user` tool → `question` item `{ text, options?, blocking }`, `needsUser: "question"`,
  `POST /api/tasks/:id/questions/:itemId/answer` and `/dismiss`. The answer becomes the next
  run's message (queue) and the composer shows the question above it. A message sent while a
  question is pending answers it.
- `task_delegate({ message, title?, accountIds?, permissionMode?: "inherit"|lower, mode:
  "async"|"wait", completionWake: "always"|"settled_only" })`, `task_status`, `task_cancel`.
  Children are `kind: "task"` with `parentTaskId`, hidden from the sidebar by default, shown
  in a **Lineage** panel on the parent and as one collapsed line in the timeline ("Started 3
  subtasks, 2 working"). Child completion appends a `notification` (`source: "subtask"`) on the
  parent and wakes it per `completionWake`; several completions coalesce into one wake. A
  child's question is forwarded to the parent as a notification, not to the person. A child
  cannot approve anything and cannot delegate deeper than depth 2.
- `task_organize({ action: snooze|unsnooze|settle|pin|unpin|rename|mark_unread, until? })`,
  settle applied when the run ends.
- Docs: `docs/tasks.md` and `docs/tools.md`; bump tool counts.

**W2B Lifecycle web wiring and keyboard** (Opus 5.5, high).
- Sidebar: order the inbox by `returnedAt`, recede seen rows, Woke and Done badges, mark
  unread in the row menu, `⌘Z` undo for settle/snooze/archive through the reopen routes.
- Queue strip above the composer: queued messages as editable rows with drag reorder, promote
  to steer, remove; "Queue held, Resume" after Stop.
- Limited state: badge, the three recovery actions in the task header and in Needs you.
- Restart notice rendering; generated-title styling until renamed.
- Needs you groups by `needsUser` kind: approvals, questions, limited, failed.

**W2C Triage as an agent run, and voice on connect** (Opus 5.5, high).
- Arrival triage becomes a background session run on the Inbox task using the tool belt and
  notes, with a triage prompt that produces the same outcomes (category, people, matter
  attach, draft reply when warranted) through tools and policy. Keep the deterministic
  heuristics as a pre-filter so newsletters and receipts never reach the model. Remove the
  structured-completion pipeline once parity tests pass against the existing fixtures.
- On first connect, a one-time task "Learn how you write" runs a bounded `mail_search` over
  Sent (50 messages), proposes Voice, Signature and VIP entries for USER.md as a single
  `profile_update` proposal the person approves, and never writes USER.md unprompted.

**W2D Rich output and draft review** (GPT-6.1-Sol, xhigh, priority tier).
- `render` tool: the agent supplies restricted HTML (allowlisted tags, no scripts, no external
  loads) rendered in a sandboxed iframe with injected theme variables; a `render` timeline
  item with a title and height. Use it for the daily digest and for triage tables.
- Draft review: a `draft_create` or `reply_draft` proposal opens side by side with the thread
  it answers, editable inline, with a "As they will see it" toggle that renders the draft with
  quoted history through the same sandbox.
- Docs: `docs/tools.md`; bump tool counts.

### Wave 3

Adversarial review of the merged result (read-only, reproduce with throwaway scripts), fix
passes split by directory, packaged-CLI smoke, Electron FTS5 smoke, screenshots, CHANGELOG
`0.4.0`, tag.

## 5. Vocabulary

Task, run, item, conversation (an email thread), matter, routine, subtask (a child task),
question, render. "Needs you" is the inbox of tasks waiting on the person. Never "thread" for a
task.
