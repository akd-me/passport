# v0.4 documentation audit

Date: 2026-10-24. Code base: `main` at `781a09b`. Documentation branch:
`t3/v04-docs-pass`. No production code, CHANGELOG, screenshot files or web-owned task UI
passages were changed. Vocabulary follows [plan §5](design/v04-plan.md#5-vocabulary).

## Review sources

The local review inputs are `~/.t3/scratch/passport-v04/review-r1.md` (Doc/code mismatches
1–34 and fix-plan Docs paragraph) and `review-r2.md` (pending web review). The six files under
`r1-parts/` are original review parts, not final fix reports. No standalone final fix reports
with “Doc lines to change” / “Documentation handoff” were present in that scratch directory.
Per the brief's fallback, the handoff matrix below uses every [Unreleased Fixed entry](../CHANGELOG.md)
and the named branch tips, then verifies the actual functions instead of applying old line numbers.

| Stream | Handoff source |
|---|---|
| F1 | `t3/arrival-session-tool-security` tip `c0883dc`; agent/tools/MCP Fixed entries |
| F2 | `f2/r1-tasks-lifecycle-orchestration` tip `d45e2c5`; lifecycle/orchestration Fixed entries |
| F3 | `t3/harden-scheduler-deliveries` tip `84b9339`; webhook/account/secret Fixed entries |
| F4 | `t3/draft-edit-run-polling` tip `fd1b4bc`; draft editor and CLI Fixed entries |
| F5 / web | Not merged at the supplied base; UI review and documentation remain with the web step |
| F6 | `t3/integration-followups` tip `781a09b`; integration Fixed entries |

“Applied” means the reference docs now describe the verified result. “Already correct” means
the merged fix made the existing statement true; it was checked and retained. “Deferred with
limitation” means the behavior remains and is explicitly documented rather than claimed fixed.

## R1 Doc/code mismatches

| Item | Passage / verified code | Disposition |
|---|---|---|
| 1 | Install called arrivals/routines tool-less. `runtime.ts` session dispatch and `routine-session.ts` supply tools. | Applied — [install](install.md#models), [Sessions](tasks.md#sessions) |
| 2 | Transcript scope. `runner.ts` persistence and `triggers.ts::runJob` keep Inbox/routine/scheduled/voice work ephemeral. | Applied — Sessions and consolidated limitations |
| 3 | Codex native tools. `host/codex.ts::codexToolCatalog` plus feature switches remove native tools; resource helpers remain. `host/session.ts` isolates cwd. | Applied — Sessions, install and security; no absolute filesystem-isolation claim |
| 4 | Resume fallback. `session-run.ts::agenticSession` requires `HOST_AGENT_SESSION_MISSING`, no activity and no cancellation. | Applied — Sessions and agent README |
| 5 | Live permission ceiling. `runner.ts::RunCeilings.lookup/liveCeiling` reads the parent chain on each policy decision, capped by the starting level. | Applied — task/tool/policy/security references; mid-run plan becomes supervised |
| 6 | Late steer. Runner settling guard and `service.ts::cancelForSteer` omit already completed requests. | Applied — Runs and Sessions |
| 7 | Last ten proposals. `session.ts::resumeInstruction` queries approval items separately from notices. | Already correct — retained last-ten statement |
| 8 | Immediate host interruption. `host/process.ts` kills the process group; API loops check boundaries. | Applied — plan item and Runs/Sessions |
| 9 | Duplicate/reserved question kind. `types/tasks.ts::TaskItemPayloads` and `questions.ts::ask` emit questions. | Applied — one active question row |
| 10 | New user message also unarchives. `status.ts::started` clears hidden state for new messages. | Applied — Status rules |
| 11 | Waiting Inbox task. `status.ts::started` preserves it only for background triggers; messages enter Working. | Applied — Status rules |
| 12 | Snooze wake. `service.ts::maintain` re-checks the row and calls `resolveTaskStatus(reopened)`. | Applied — maintenance, reopen and Woke behavior |
| 13 | Independent question/secret Input state. `types/tasks-r1.ts::taskWaitingOn`, secret tools/routes and question resolution share the rule. | Already correct — field and independent-resolution details added; obsolete limitation removed |
| 14 | Activity stamps. `stampTask` is shared by runner and tool writes; watch tools do not advance activity timestamps. | Already correct — invariant retained; stale limitation removed |
| 15 | Full continuation request. `continuation.ts::requestOf` prefers `TaskRun.request`, including steer/answer context. | Applied — run model, restart and limit continuation |
| 16 | Continuations use sessions. `continueRun` passes `session` and the runner's persistence policy. | Applied — old limitation removed; bounded history versus resumed context explained |
| 17 | Provider reset time. `llm/client.ts` translates 429 `Retry-After` into ISO error text; `limits.ts::parseResetAt` parses it. | Applied — Usage limits |
| 18 | First steered/continued title. `titles.ts::generate` considers earlier completed message runs, not the first run ID alone. | Applied — Kinds and generated-title behavior |
| 19 | Stopped parent wakes. `subtasks.ts::completed` suppresses wakes for queue-held/Limited/settled/archived parents. | Applied — consolidated limitation retains that children continue and notify |
| 20 | Real depth. `subtasks.ts::ancestors/delegateLocked` counts routine and API-created parent links. | Applied — Subtasks depth rule |
| 21 | Child account subset. `delegateLocked` checks creation; `runner.ts::runAccounts` and `tools/context.ts` enforce calls. | Applied — call-time scope, `ACCOUNT_FORBIDDEN`, and routine/all-account exceptions |
| 22 | Concurrent dismiss. `questions.ts::dismiss` serializes under the queue lock and rejects a second resolution. | Already correct — 409 retained; bounded historical lookup documented |
| 23 | Deferred settle plus queue. `status.ts::settleAtRunEnd` keeps the request temporarily; `started` clears it on the next message. | Applied — Status rules and limitation |
| 24 | Direct message to cancelled child. `queue.send` leaves `cancelledByParent`; only `subtasks.followUp` clears it. | Deferred with limitation — Subtasks and consolidated list |
| 25 | Accepted-window budget. `webhooks.ts::receive` increments deliveries only on accepted new windows. | Applied — scheduler distinguishes 10 windows, 60 updates, rejection and 70-request budgets |
| 26 | Restart secret deadline. `store-secrets.ts::requests.get` checks original `expiresAt`, not restart time. | Applied — tools/security/store references |
| 27 | Account `secretRef` handoff. `accounts.ts` and `onboarding/routes.ts` support raw API refs and probe-only tests; wizard/setup tools do not. | Deferred with limitation — API test/install behavior applied; wizard/setup gap retained |
| 28 | Routine form reference gap. `apps/web/src/scheduler/RoutineOptions.tsx` asks for a reference; no private picker exists at this base. | Deferred with limitation — tools/scheduler/tasks; UI wording left to web |
| 29 | Manual webhook Run now. Scheduler supplies stored instruction without a webhook request. | Deferred with limitation — scheduler and tasks explain literal placeholders |
| 30 | Arrival category scope. `triage-session.ts::arrivalToolContext` and `tools/context.ts::submit` restrict the trusted override to its own organizing call. | Applied — tools and triage migration |
| 31 | Arrival retry acknowledgment. `runtime.ts::runInternal` requires a completed checkpoint or session checkpoint with actions; other partial session work throws `TRIAGE_INTERRUPTED`. | Applied — tasks, scheduler and agent/server READMEs; people actions alone re-infer |
| 32 | Triage authority. `ARRIVAL_TOOLS` and arrival-only target checks refuse orchestration/secrets/render and other tools. | Applied — exact allowlist and `INPUT_TRIAGE` |
| 33 | Render failures. `render.ts` checks cap before parsing and counts sanitiser failures; `render-html.ts` scans linearly. | Applied — ten attempts including sanitiser failures, with counter persistence scope |
| 34 | Draft save feedback. `executor-drafts.ts` keeps the original; `executor-commands.ts::approve` records `approved_edited` and edit distance. | Applied — tools/tasks/policy/security references |

Code paths in this table are under `packages/agent/src`, `packages/tools/src`,
`packages/types/src`, `packages/policy/src`, `packages/store/src`, or `apps/server/src/tasks`
and `apps/server/src/schedulers` as named. They were located by symbol and the function bodies
were read, including integration overrides (`triggers.runJob`, runner persistence and account scope).

## Fix handoff coverage

Entries below follow all 35 bullet paragraphs under the two `### Fixed` headings of
`[Unreleased]` at the supplied base. The short content labels avoid branch-relative line numbers.
All are Applied unless an explicit caveat is listed. F5 contributes no merged Fixed bullet at this base.

| Fixed entry / stream | Content line → applied documentation | Code verified |
|---|---|---|
| 01 / F6 | Private OS temp host directories; mail-export scratch stays separate → Sessions, install, deploy, security, READMEs | `host/session.ts::runHostAgent`, invocation cleanup |
| 02 / F6 | Scheduled allowlist → tools exact routine list, scheduler, tasks, agent README | `routine-session.ts::ROUTINE_TOOLS`, runtime filtering, runner tool scope |
| 03 / F6 | Successful result survives late Stop/steer → Sessions and Runs | `session-run.ts::agenticSession` successful-result check |
| 04 / F6 | Resolve secret IDs after run end, including expiry → questions/secrets API and security | `schedulers/secret-routes.ts::publish`, tools secret resolution |
| 05 / F6 | Shared waiting/stamping → Task fields, status, WebSocket and security | `types/tasks-r1.ts`, runner/stamps, tools secrets/watch writes |
| 06 / F6 | Inbox/routine follow-ups and continuations ephemeral → persistence scope across guides | `runner.ts` kind/voice setting, message/wake/continuation option merge |
| 07 / F2 | Session continuations, whole request and fresh history → TaskRun model, restart and Limited | `continuation.ts::continueRun/requestOf` |
| 08 / F2 | Preserve snooze, no auto-reopen settled/archive, snooze holds queue → lifecycle and limits | `status.ts::started`, `limits.ts::autoResume`, lifecycle snooze, `noAutoResume` |
| 09 / F2 | Question and secret keep independent Input → model and Questions | `status.ts`, `taskWaitingOn`, secret routes |
| 10 / F2 | Live ceiling and task accounts → task/tool/policy/security references | `runner.ts::RunCeilings/liveCeiling/runAccounts`, tools context |
| 11 / F2 | Finishing run cannot be cancelled/re-sent or skip end hooks → Runs/Sessions | runner agent-finished hook, cancellable guard, `cancelForSteer` |
| 12 / F2 | Child person-choice suppression, stopped/Limited parent, ancestry, recovery hook, no arrival/schedule delegation → Subtasks and limitations | `subtasks.ts::completed/delegateLocked/followUp`, restart/wiring |
| 13 / F2 | Resume keeps Approval/Input; maintenance re-checks; milliseconds; continued titles; Stop has no Done → status, lifecycle, limits, titles | `limits.ts`, `service.ts::maintain`, `titles.ts`, `status.ts::unseenOutcome` |
| 14 / F2 | Dismiss 409, parallel question/delegate limits, person snooze/title, framed labels/requests, independent proposal lookup → Questions/Subtasks/Organise/Sessions | `questions.ts`, `subtasks.ts`, `organize.ts`, `untrusted.ts::taskLabel`, titles/session prompts |
| 15 / F3 | Accepted windows only → webhook budget paragraph | `webhooks.ts::receive` delivery increment |
| 16 / F3 | Per-routine/global cap, separate persistence, preview-only history → scheduler, deploy | `MAX_PENDING_PER_ROUTINE`, `MAX_PENDING_GLOBAL`, `save/load/log` |
| 17 / F3 | Separate signature rejection budget; unknown pre-body throttle; deep JSON `rejected`; credential-name redaction → scheduler and security | webhook route authorization, `receive`, `webhook-request.ts` |
| 18 / F3 | Probe-only account tests; consume after persistence; failed-install cleanup → accounts, secrets, security | `accounts.ts::addAccount`, onboarding test route, `routine-options.ts` |
| 19 / F3 | One-hour default refs, persistent deadline, sweep, legacy revocation → tools, accounts, store, security, deploy | `store-secrets.ts::put/peek/consume/sweepExpired`, store maintenance |
| 20 / F4 | Serialized draft saves, preserved original, `409 ACTION_DECIDED` → tools/tasks/policy | executor editor and approval commands, render route mapping |
| 21 / F4 | Durable `--wait`, bounded transient retries → install, deploy, server README, API table | `cli/tasks.ts::waitForRun`, `tasks/run-routes.ts` |
| 22 / F1 | Arrival allowlist and `INPUT_TRIAGE` → exact tool list and task migration | `triage-session.ts::ARRIVAL_TOOLS/arrivalToolContext` |
| 23 / F1 | Arrival category affects own organizing call only → tools/tasks | arrival tool context plus tools context target/category checks |
| 24 / F1 | People actions alone do not acknowledge failed arrival; partial work surfaces → migration and server/agent/scheduler | `runtime.ts::runInternal`, session checkpoint; docs qualify report shorthand: an organizing Action alone is not the checkpoint |
| 25 / F1 | Transcript persistence only for resumable task work → Sessions/install/deploy/security/README | `agenticSession` persistence, task runner, `triggers.runJob` scheduled override |
| 26 / F1 | Missing-session-only fallback, replacement ID on success → Sessions and agent README | `session-run.ts::agenticSession`, host session error classification |
| 27 / F1 | Codex native-feature/catalog hardening → Sessions/security/install/agent README | `host/codex.ts::codexToolCatalog`; docs qualify “only” with three residual resource helpers |
| 28 / F1 | Account scope / `ACCOUNT_FORBIDDEN` → tools/tasks/security | runtime trusted context, tools account/reader/email/action checks |
| 29 / F1 | Secret IDs, shared question rule, task stamps and no watch activity bump → model/status/secrets | `tools/secrets.ts`, `tools/tasks-watch.ts`, shared types |
| 30 / F1 | Linear render, stray `<`, common entities, single URL decoding, failed-attempt cap → rich output/security | `render-html.ts::sanitizeRenderHtml/decode`, `render.ts` |
| 31 / F1 | Stderr/Claude result limits and API Retry-After → Usage limits | host session/text/parsers, LLM client, `limits.ts::detectLimit/parseResetAt` |
| 32 / F1 | Ten-second grace then tool abort on time exhaustion → Sessions and agent README | `session-run.ts::TOOL_GRACE_MS`, runtime linked tool signal |
| 33 / F1 | Claude session prompt private file → Sessions working files, install/security/agent README | `host/claude.ts::claudeInvocation`; Codex/completion argv caveat retained |
| 34 / F1 | MCP tool timeout exceeds secret wait → tools, Sessions, MCP README | `mcp/tool-belt.ts` 600 + 60 default |
| 35 / F1 | Pending profile stops competing learning → learning/profile/allowlist docs | `voice-learning.ts::VoiceLearningGuard.seed`, runtime seed call |

## Web handoff left unchanged

`docs/tasks.md` from `## UI` through the end of its review R5 Known limitations was preserved
byte-for-byte. This includes R5-2, R5-5, system-task archive confirmation, latest-action Undo,
touch/keyboard queue behavior, seen timing, title styling, browser shortcuts, repeated palette
group headings, R5-15 cross-tab busy state, R5-18 clamp notice and approve-scope compatibility.
The two UI-specific W2A bullets (subtasks-line placement/duplicate Lineage fetch and palette/
direct-child messaging) were retained verbatim in the consolidated dated list.

The current routine form’s private reference gap (R1 mismatch 28) is documented as a limitation
outside that section; its UI remedy remains with the web step. R2-1 through R2-26 and the
R1-52 keyboard listener fix remain outside this documentation-only pass. No screenshots changed.

## Verification and limits of this audit

Runtime descriptions were verified by reading local code, not by signing into providers or
asking live models. Live OAuth, Gmail/Graph/IMAP/JMAP behavior, model judgment quality, full
Tailscale connectivity and npm/GHCR publication were not verified here. Historical Mac packaging
smoke evidence is retained as historical; this pass does not claim a new packaged-app smoke.
Optional live host-agent tests are intentionally disabled for the offline test run.

Validation on this branch (Node 25.9.0, pnpm 10.33.0):

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Passed; checkout initially had no dependencies; no lockfile change |
| `pnpm build` | Passed after dependency installation; existing web chunk-size advisory only |
| `pnpm lint` | Passed (Biome checks plus all workspace typechecks); existing warnings/deprecations only |
| `PASSPORT_SKIP_LIVE_HOST_AGENTS=1 pnpm test` | One full test run: **2,225 passed, 12 skipped**, no failures |
| Task model/API/scope audit | All requested fields and routes documented; exact allowlists compared to code |
| UI ownership check | UI/R5 section and both UI-specific W2A bullets match the base byte-for-byte |
| README screenshot inventory | All 12 existing files linked, no missing/renamed files |
| Local Markdown link check / `git diff --check` | Passed |

The first build attempt failed because TypeScript was not installed; installing from the frozen
lockfile resolved it. Tests were not repeated. Build output and logs live outside the repository
under `/tmp/passport-v04-docs-*`; no dependencies or generated artifacts are committed.

## Commits

- `4547d78` — `docs(tasks): align v0.4 lifecycle tools and scheduler contracts`
- `5498cac` — `docs(operations): describe v0.4 sessions privacy and CLI behavior`
- The commit containing this audit and the plan Outcome completes the pass. Nothing was pushed
  or tagged; the integrator owns the release heading and final web integration.
