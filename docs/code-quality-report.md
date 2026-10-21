# Code-quality pass report

Branch: `t3/passport-code-quality-pass`  
Worktree: `/Users/akshaykumardileepmacmini/.t3/worktrees/passport/t3-18d9dd31`  
Base: `3bcb669`

## Commits

| Step | Commit | Summary |
| --- | --- | --- |
| 1 | `8c92201` | `chore(tooling): add Biome checks and contributor defaults` — pinned Biome 2.5.15, formatter/lint scripts, documented warning baseline, CI and Node/editor defaults. |
| 2 | `59dda1b` | `style: format the repository with Biome` — mechanical formatting and safe fixes; owner explicitly approved Biome's scoped removal of four erased type imports. |
| 3 | `8f9f61e` | `refactor(readability): unpack dense one-liners` — expanded control flow, named conditional decisions, calendar timestamp helper, behavior-preserving memo cleanup, blame-ignore hash. |
| 4 | `8e12fb1` | `refactor(errors): make every catch explicit` — full catch audit, typed parser checks and static operational diagnostics. |
| 5 | `a0aad07` | `refactor(structure): split oversized modules at natural seams` — separated the modules listed below without changing package-root exports or route order. |
| 6 | `9d159f9` | `chore(deps): remove dead code and unused dependencies` — Knip audit, dead internal exports/declarations, redundant development dependencies and lockfile cleanup. |
| 7 | Current documentation commit | `docs: coding conventions` — shared style conventions, final catch locations, warning counts and validation report. |

Commit 1 is the owner-approved lint exception because the repository was not yet formatted.
Its install/build/typecheck/offline tests passed. Commits 2–7 require the full install, build,
typecheck, lint, and offline-test checkpoint. Commit 2 contains only automated edits; the owner
approved the narrowly scoped type-only import fix, which is recorded in its commit body.

## Catch audit

Every production catch clause and inline promise rejection handler in `packages/` and `apps/`
was reviewed; tests, testing helpers, and recorded fixtures are excluded. The table also includes
existing propagation handlers so that the scan is reproducible. Choice **a** narrows an expected
failure and explains its fallback; **b** retains the fallback and uses an existing or optional
logging seam; **c** retains the existing typed/stable error translation or propagates the original
error after cleanup (already explicit, outside the silent-catch subset). New log messages contain
static text only, with no error objects, URLs, command output, credentials, or message bodies.
Optional package diagnostics default to no-op; server composition supplies its logger.

| File:line | Choice | Why |
| --- | --- | --- |
| `apps/server/src/accounts.ts:103` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/arrivals.ts:31` | b | Arrival queue operation failed; later work may continue. |
| `apps/server/src/arrivals.ts:173` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/arrivals.ts:250` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/arrivals.ts:280` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/atomic-kv.ts:34` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/auth.ts:47` | a | An absent token file is initialized below; other filesystem errors propagate. |
| `apps/server/src/auth.ts:67` | a | A concurrent token creator owns the existing file; preserve that token. |
| `apps/server/src/auth.ts:164` | b | Session validation failed; rejecting authentication. |
| `apps/server/src/auth.ts:248` | b | WebSocket authentication failed; rejecting upgrade. |
| `apps/server/src/auth.ts:359` | b | Login request JSON could not be read. |
| `apps/server/src/calendar-recurrence.ts:25` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/calendar-safety.ts:130` | a | Unsupported local recurrence is unverified; live provider availability remains required. |
| `apps/server/src/cli.ts:115` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/cli.ts:155` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/cli.ts:167` | b | MCP listener failed during startup. |
| `apps/server/src/cli.ts:187` | b | MCP listener failed during shutdown. |
| `apps/server/src/cli.ts:333` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/cli/mcp-install.ts:50` | b | MCP URL could not be displayed safely. |
| `apps/server/src/cli/mcp-install.ts:379` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/cli/mcp-install.ts:478` | a | An absent client configuration starts empty; other filesystem errors propagate. |
| `apps/server/src/cli/server-client.ts:13` | a | An absent token file means there is no authenticated server connection yet. |
| `apps/server/src/cli/server-client.ts:46` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/compose.ts:55` | a | An absent master key is initialized atomically; other filesystem errors propagate. |
| `apps/server/src/compose.ts:69` | a | Another process installed the key first; keep its existing key. |
| `apps/server/src/compose.ts:321` | b | Account sync failed; retaining its recorded failure. |
| `apps/server/src/compose.ts:424` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/config.ts:126` | a | An absent configuration uses defaults; other filesystem errors propagate. |
| `apps/server/src/config.ts:236` | a | An absent configuration has no prior values to merge. |
| `apps/server/src/demo/executor.ts:51` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/demo/executor.ts:192` | b | Demo outbox action failed; continuing other due actions. |
| `apps/server/src/doctor-host-agents.ts:20` | b | Host-agent discovery failed during diagnostics. |
| `apps/server/src/doctor-host-agents.ts:77` | b | Host-agent diagnostic request failed. |
| `apps/server/src/doctor.ts:55` | b | Provider diagnostic cleanup failed. |
| `apps/server/src/doctor.ts:77` | b | Diagnostic check failed. |
| `apps/server/src/doctor.ts:241` | b | Provider diagnostic failed; trying the next account. |
| `apps/server/src/doctor.ts:275` | b | Configuration diagnostics failed. |
| `apps/server/src/doctor.ts:297` | b | Data directory diagnostic failed. |
| `apps/server/src/doctor.ts:313` | b | Master key diagnostic failed. |
| `apps/server/src/llm-routes.ts:18` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/llm-selection.ts:22` | b | Host-agent discovery failed; retaining the configured fallback. |
| `apps/server/src/mcp-token.ts:22` | a | An absent MCP token is initialized below; other filesystem errors propagate. |
| `apps/server/src/mcp-token.ts:36` | a | A concurrent token creator won; read its existing token. |
| `apps/server/src/onboarding/oauth-account.ts:206` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/onboarding/oauth-account.ts:220` | b | Initial account sync failed; retaining its recorded failure. |
| `apps/server/src/onboarding/oauth.ts:186` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/onboarding/routes.ts:16` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/onboarding/routes.ts:96` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/onboarding/sync.ts:84` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/onboarding/sync.ts:159` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/onboarding/sync.ts:179` | b | Backfill job failed while pausing. |
| `apps/server/src/onboarding/sync.ts:191` | b | Provider disconnect failed after backfill. |
| `apps/server/src/onboarding/sync.ts:202` | b | Backfill job failed while removing the account. |
| `apps/server/src/onboarding/sync.ts:209` | b | Mail provider disconnect failed during removal. |
| `apps/server/src/onboarding/sync.ts:216` | b | Calendar provider disconnect failed during removal. |
| `apps/server/src/owner-lock.ts:19` | a | Missing or malformed ownership metadata means there is no usable owner record. |
| `apps/server/src/owner-lock.ts:41` | b | Owner process probe failed; retaining the conservative owner state. |
| `apps/server/src/owner-lock.ts:57` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/owner-lock.ts:115` | b | Owner heartbeat failed; checking the existing ownership fallback. |
| `apps/server/src/route-input.ts:66` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/schedulers/routes.ts:11` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/schedulers/service.ts:78` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/schedulers/service.ts:84` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/schedulers/service.ts:91` | b | Scheduler update failed; later updates may continue. |
| `apps/server/src/schedulers/service.ts:102` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/schedulers/service.ts:234` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/schedulers/service.ts:296` | b | Scheduler initialization failed before shutdown. |
| `apps/server/src/schedulers/service.ts:333` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/server.ts:59` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/setup/browser.ts:88` | b | Browser process discovery failed; using an empty process list. |
| `apps/server/src/setup/cli.ts:82` | a | Stale prompts and finished tasks need no reply; all other failures propagate. |
| `apps/server/src/setup/cli.ts:137` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/setup/cli.ts:176` | b | Setup cancellation request failed. |
| `apps/server/src/setup/cli.ts:201` | b | Setup interaction interrupted; retaining the task state. |
| `apps/server/src/setup/mcp.ts:56` | b | Setup tool failed; returning the existing safe tool error. |
| `apps/server/src/setup/mcp.ts:200` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/setup/mcp.ts:247` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/setup/mcp.ts:299` | b | Setup MCP transport failed. |
| `apps/server/src/setup/routes.ts:62` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/setup/runner-events.ts:17` | b | Browser URL could not be summarized safely. |
| `apps/server/src/setup/runner-state.ts:138` | b | Setup owner process probe failed. |
| `apps/server/src/setup/runner.ts:131` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/setup/runner.ts:250` | b | Browser helper preparation failed. |
| `apps/server/src/setup/runner.ts:341` | b | Browser helper release failed during cleanup. |
| `apps/server/src/setup/runner.ts:347` | b | Setup browser close failed during cleanup. |
| `apps/server/src/setup/runner.ts:353` | b | Setup browser output cleanup failed. |
| `apps/server/src/sync/connections.ts:50` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/sync/connections.ts:54` | b | Provider disconnect failed after connection failure. |
| `apps/server/src/sync/connections.ts:65` | b | Provider disconnect failed while invalidating a connection. |
| `apps/server/src/sync/connections.ts:82` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/sync/connections.ts:98` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/server/src/sync/connections.ts:118` | b | Provider connection failed before shutdown. |
| `apps/server/src/sync/index.ts:151` | a | An expired calendar cursor requires full reconciliation; other provider errors propagate. |
| `apps/server/src/sync/index.ts:291` | a | An expired mail cursor requires full reconciliation; other provider errors propagate. |
| `apps/server/src/sync/index.ts:319` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `apps/web/src/accounts/AccountWizard.tsx:76` | b | Authorization status refresh failed. |
| `apps/web/src/api.ts:88` | b | API error response did not contain a JSON envelope. |
| `apps/web/src/auth.ts:23` | b | Session refresh failed; retaining normal reconnect behavior. |
| `apps/web/src/auth.ts:80` | b | Login request failed. |
| `apps/web/src/auth.ts:124` | b | Authentication status unavailable; showing login. |
| `apps/web/src/connect/SetupFlow.tsx:87` | b | Setup status refresh failed; retaining the last state. |
| `apps/web/src/connect/SetupFlow.tsx:110` | b | Automatic setup could not start. |
| `apps/web/src/connect/SetupTaskView.tsx:80` | b | Setup response failed. |
| `apps/web/src/settings/AdvancedSettings.tsx:137` | b | Authentication status unavailable in settings. |
| `apps/web/src/settings/ModelSettings.tsx:56` | b | Host-agent discovery failed in settings. |
| `apps/web/src/shell/CommandPalette.tsx:100` | b | Agent review command failed. |
| `apps/web/src/shell/CommandPalette.tsx:118` | b | Permission mode command failed. |
| `apps/web/src/shell/Composer.tsx:82` | b | Agent composition failed; restoring the instruction. |
| `apps/web/src/state.tsx:70` | b | Workspace event frame could not be processed. |
| `apps/web/src/state.tsx:134` | b | Resource request failed or was cancelled. |
| `apps/web/src/state.tsx:163` | b | Workspace action failed. |
| `apps/web/src/ui-state.tsx:41` | b | Stored preference could not be read; using the default. |
| `apps/web/src/ui-state.tsx:51` | b | Preference storage unavailable; retaining session state. |
| `apps/web/src/views/PromotionPrompts.tsx:18` | b | Promotion dismissal storage could not be read. |
| `apps/web/src/views/PromotionPrompts.tsx:45` | b | Promotion dismissal could not be persisted; retaining session state. |
| `packages/agent/src/host/claude.ts:167` | a | Malformed JSON is expected here; retain the existing text or stream fallback. |
| `packages/agent/src/host/codex.ts:227` | a | Malformed JSON is expected here; retain the existing text or stream fallback. |
| `packages/agent/src/host/codex.ts:286` | a | Malformed JSON is expected here; retain the existing text or stream fallback. |
| `packages/agent/src/host/detect.ts:35` | b | Host-agent executable probe failed. |
| `packages/agent/src/host/detect.ts:115` | b | Host-agent version probe failed. |
| `packages/agent/src/host/detect.ts:124` | b | Host-agent login probe failed. |
| `packages/agent/src/host/detect.ts:142` | a | Malformed JSON is expected here; retain the existing text or stream fallback. |
| `packages/agent/src/host/detect.ts:205` | b | Host-agent discovery failed; clearing the cached probe. |
| `packages/agent/src/host/process.ts:45` | b | Host-agent process group cleanup failed. |
| `packages/agent/src/host/process.ts:83` | b | Host-agent process signal failed. |
| `packages/agent/src/host/session.ts:75` | b | Host-agent event listener failed; continuing the run. |
| `packages/agent/src/host/session.ts:157` | b | Host-agent preparation failed; returning the bounded error. |
| `packages/agent/src/host/session.ts:127` | b | Host-agent process could not be started. |
| `packages/agent/src/host/session.ts:151` | b | Host-agent private file cleanup failed. |
| `packages/agent/src/host/session.ts:194` | b | Host-agent session listener failed; continuing the session. |
| `packages/agent/src/llm/client.ts:30` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/agent/src/llm/client.ts:122` | b | LLM transport failed; applying the existing retry policy. |
| `packages/agent/src/llm/client.ts:135` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/agent/src/llm/json.ts:13` | a | Malformed JSON is expected here; retain the existing text or stream fallback. |
| `packages/agent/src/llm/json.ts:49` | a | Malformed JSON is expected here; retain the existing text or stream fallback. |
| `packages/agent/src/manual.ts:68` | a | Input validation failures become tool feedback; unrelated agent failures propagate. |
| `packages/agent/src/runtime.ts:49` | b | Agent queue operation failed; later runs may continue. |
| `packages/agent/src/runtime.ts:202` | b | Agent operation failed; retaining the safe run error. |
| `packages/mcp/src/resources.ts:20` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/mcp/src/resources.ts:32` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/mcp/src/resources.ts:129` | b | MCP resource notification failed; keeping domain event delivery active. |
| `packages/mcp/src/server.ts:75` | b | MCP response exceeds the configured budget; returning the bounded error. |
| `packages/mcp/src/transports.ts:151` | b | MCP HTTP request failed; returning the existing transport error. |
| `packages/policy/src/executor-dispatch.ts:121` | b | Message submitted; sent-copy or draft cleanup failed. |
| `packages/policy/src/executor-restoration.ts:192` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/policy/src/executor-restoration.ts:198` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/policy/src/executor.ts:108` | a | Missing or changed draft references trigger reapproval; unrelated errors propagate. |
| `packages/policy/src/executor.ts:182` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/policy/src/executor.ts:232` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/policy/src/executor.ts:250` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/policy/src/executor.ts:334` | b | Outbox release failed; retaining the first error while continuing due actions. |
| `packages/policy/src/unsubscribe.ts:83` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/policy/src/unsubscribe.ts:124` | a | Malformed URL targets provide no capability; keep trying valid input. |
| `packages/policy/src/unsubscribe.ts:221` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/policy/src/unsubscribe.ts:244` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/caldav-ical.ts:21` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/caldav-ical.ts:203` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/caldav.ts:175` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/caldav.ts:370` | a | Unsupported free-busy REPORT uses bounded event fallback; other provider errors propagate. |
| `packages/providers/src/calendar-common.ts:48` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/calendar-common.ts:69` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/errors.ts:48` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/gmail.ts:102` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/gmail.ts:285` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/gmail.ts:359` | a | A provider 404 means the requested message no longer exists. |
| `packages/providers/src/google-calendar.ts:210` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/graph-calendar.ts:184` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/graph.ts:204` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/graph.ts:256` | a | An absent folder delta is skipped while remaining folders are synchronized. |
| `packages/providers/src/graph.ts:305` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/graph.ts:367` | a | A provider 404 means the requested message no longer exists. |
| `packages/providers/src/http.ts:28` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/http.ts:54` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/http.ts:168` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/http.ts:212` | a | Only an authenticated 401 with refresh credentials is retried after refresh. |
| `packages/providers/src/imap.ts:152` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/imap.ts:194` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/imap.ts:347` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/imap.ts:384` | a | A stale IMAP identity means the original message no longer exists. |
| `packages/providers/src/imap.ts:578` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/imap.ts:595` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/jmap.ts:187` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/providers/src/normalize/index.ts:218` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/scheduler/src/index.ts:46` | b | Job state persistence failed; keeping the write queue available. |
| `packages/scheduler/src/index.ts:85` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `packages/scheduler/src/index.ts:208` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/scheduler/src/schedule.ts:74` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/scheduler/src/scheduler-execution.ts:68` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `packages/scheduler/src/scheduler-execution.ts:110` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `packages/store/src/credentials.ts:36` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/store/src/event-bus.ts:47` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `packages/store/src/event-bus.ts:52` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `packages/store/src/store-database.ts:40` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/store/src/store-query.ts:31` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/store/src/store.ts:80` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/tools/src/availability.ts:23` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/tools/src/extra.ts:123` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
| `packages/tools/src/extra.ts:459` | a | Malformed URL targets provide no capability; keep trying valid input. |
| `packages/tools/src/register.ts:27` | b | Tool request failed; returning the existing bounded error. |
| `packages/tools/src/register.ts:33` | b | Tool error exceeds the response budget; returning the minimal error. |
| `packages/tools/src/schema.ts:216` | a | Malformed URL targets provide no capability; keep trying valid input. |
| `apps/server/src/cli/mcp-install.ts:594` | b | Both bridge directions share the logged failure and shutdown handler. |
| `apps/server/src/cli/mcp-install.ts:600` | b | Both bridge directions share the logged failure and shutdown handler. |

## Module splits

The original entry points and package-root exports remain available. Moved code keeps its
existing route registration order, query text, action ordering, and React markup.

| Original module | Extracted concerns | Result |
| --- | --- | --- |
| `packages/policy/src/executor.ts` | Shared snapshots; validation and capture; mail mutations; restoration; dispatch; approval and undo commands | Seven modules, each below 400 lines |
| `packages/store/src/store.ts` | SQL and query helpers; mail, calendar, people/matter, and action/trust/KV repositories | Seven modules, each below 400 lines |
| `packages/providers/src/mock.ts` | Fixture construction; mail mock; calendar mock | Existing mock entry point re-exports the same API |
| `packages/providers/src/caldav.ts` | iCalendar parsing, normalization, and serialization | CalDAV transport remains cohesive at about 400 lines |
| `packages/scheduler/src/index.ts` | State/contracts and job execution | Three modules, each below 400 lines |
| `apps/server/src/app.ts` | Input parsing and action, mail, matter/people/calendar, settings/account, and agent routes | Route groups preserve registration order |
| `apps/server/src/demo/executor.ts` | Demo action application and shared request helpers | Lifecycle remains in the original entry point |
| `apps/server/src/sync/index.ts` | Provider identity mapping and cursor/key conventions | Sync coordination remains in the service |
| `apps/server/src/schedulers/service.ts` | Built-in system job definitions | Routine/account lifecycle remains in the service |
| `apps/server/src/onboarding/oauth.ts` | OAuth account enrollment and credential persistence | Browser authorization state remains in the original module |
| `apps/server/src/setup/runner.ts` | State/contracts; setup tool host; browser event summaries | Runner lifecycle remains in the original module |
| `apps/web/src/views/Decisions.tsx` | Decision cards/outbox; proposal details; grouping and keyboard helpers | View entry point and existing exports remain |
| `apps/web/src/views/Trust.tsx` | Modes; controls; promotion prompts; safety forms | Settings view and existing exports remain |
| `apps/web/src/views/Scheduler.tsx` | Job table/history and routine form | Settings view and existing exports remain |
| `apps/web/src/connect/SetupFlow.tsx` | Task display/actions and shared task interpretation | Polling/setup navigation stays in the entry point |

Kept intact: the append-only shared type contract; existing test suites and fixture files;
CSS beyond formatting; the remaining single-protocol provider adapters; the agent triage pipeline; tool registration
catalogues; policy evaluation; and CLI configuration merging. Their remaining larger functions encode one ordered
protocol or workflow, and splitting them further would introduce extra state plumbing without a
clearer boundary. They remain candidates for focused follow-up work. Server setup files besides
the runner already fit the target after formatting. Other existing web views/components fit the
target or remain close to it with a single cohesive form/view.

## Dead code and dependency audit

Ran Knip 6.42.1 with its workspace discovery. No unused files were found. Biome 2.5.15
has no unused-export rule; its required unused-import and unused-variable rules were checked
alongside Knip's export/type graph.

Removed:

- Root `vitest`: every test workspace already declares its own runner; root scripts only recurse.
- Provider `@types/mailparser`: installed `mailparser` supplies its own declarations; provider
  typecheck passes without the separate typings. Reinstalled to update `pnpm-lock.yaml`.
- The unused web `PageHeader` component and `setupTaskFromEvent` helper.
- The unused agent `strings` schema constant and MCP `json` / `errorResult` presentation helpers.
- The unused internal `Dispatch` type alias and mock-calendar `folderNames` field.
- Unused internal exports/re-exports across server helpers, agent parsers/prompts/schema constants,
  provider parsing/serialization helpers, tool schema builders, test fixture helpers, and UI
  implementation helpers. Internally used implementations remain private.

Retained deliberately:

- Package-root APIs, including provider normalizers, mock factories, transport/tool adapters,
  shared contracts, and runtime integration types. Repository usage alone cannot establish that
  an intentionally published API is dead. `packages/types` was not pruned.
- `Decisions` / `WorkQueue` and `isSetupTaskFinished` / `isFinished`: existing compatibility aliases.
  They are tagged `@compatibility`; Knip suppresses only their two duplicate-export reports.
- `ObjectSchema`: its exported name is required for TypeScript declaration emission when a
  returned schema class contains private members. It is tagged with that reason.
- The platform `pkill` executable used by setup cleanup; it is not an npm dependency.
- No test, fixture file, CLI entry point, stylesheet rule, or intentionally public API was deleted.

`knip.jsonc` contains only the platform-binary allowance, compatibility tag, and the two narrow
intentional-duplicate allowances. No Biome suppression comments were added.

Removed internal export surface (definitions remain private unless listed as deleted above):

| File | Removed exports/re-exports |
| --- | --- |
| `apps/server/src/demo/fixtures.ts` | `CATEGORIES` |
| `apps/server/src/doctor.ts` | `printDoctor` |
| `apps/server/src/onboarding/oauth-account.ts` | `accountIdentity`, `calendarScope` |
| `apps/server/src/onboarding/oauth.ts` | `OAuthKind`, `accountIdentity` |
| `apps/server/src/owner-lock.ts` | `OWNER_HEARTBEAT_MS`, `OWNER_STALE_MS` |
| `apps/server/src/schedulers/index.ts` | `JobView`, `RoutineDefinition`, `getSchedulerService` |
| `apps/server/src/setup/browser.ts` | `npxCommand` |
| `apps/server/src/setup/mcp.ts` | `createSetupMcpServer` |
| `apps/server/src/setup/runner-state.ts` | `SetupOAuth` |
| `apps/server/src/setup/runner.ts` | `SETUP_BROWSER_TOOLS`, `SetupOAuth` |
| `apps/server/src/validation.ts` | `TrustLevel` |
| `apps/web/src/accounts/AccountFilter.tsx` | `accountColour` |
| `apps/web/src/accounts/AccountRow.tsx` | `providerName` |
| `apps/web/src/components/Dialog.tsx` | `trapTab` |
| `apps/web/src/components/ui.tsx` | `PageHeader`, `isMac` |
| `apps/web/src/connect/SetupTaskView.tsx` | `StepIcon` |
| `apps/web/src/setup-api.ts` | `SetupLogEntry`, `SetupPrompt`, `SetupTaskStatus`, `setupTaskFromEvent` |
| `apps/web/src/shell/Composer.tsx` | `suggestions` |
| `apps/web/src/state.tsx` | `WorkspaceEvent` |
| `apps/web/src/ui-state.tsx` | `applyTheme` |
| `apps/web/src/views/DecisionCard.tsx` | `CancelButton`, `Countdown` |
| `apps/web/src/views/Decisions.tsx` | `CancelButton`, `Countdown`, `ProposalDetails` |
| `apps/web/src/views/JobTable.tsx` | `JobRow`, `countdown`, `duration` |
| `apps/web/src/views/NewRoutineForm.tsx` | `examples` |
| `apps/web/src/views/People.tsx` | `DowngradeWarning` |
| `apps/web/src/views/PromotionPrompts.tsx` | `DISMISSED`, `offerKey`, `readDismissed` |
| `apps/web/src/views/ProposalDetails.tsx` | `reversibilityText` |
| `apps/web/src/views/Trust.tsx` | `ActionCategory` |
| `packages/agent/src/host/detect.ts` | `ProbeExec` |
| `packages/agent/src/host/index.ts` | `ProbeExec`, `createClaudeParser`, `createCodexParser`, `hostAgentEnv` |
| `packages/agent/src/prompts/index.ts` | `emailContext` |
| `packages/agent/src/schemas.ts` | `CATEGORIES`, `categorySchema`, `objectSchema`, `slotSchema`, `string`, `strings` |
| `packages/agent/src/triage.ts` | `emailCounterparty`, `readThread`, `replyDraft`, `sensitiveCategory` |
| `packages/mcp/src/presentation.ts` | `errorResult`, `json` |
| `packages/mcp/src/testing/fixtures.ts` | `at` |
| `packages/policy/src/executor-dispatch.ts` | `Dispatch` |
| `packages/policy/src/testing/fixtures.ts` | `FakeCalendarProvider`, `FakeMailProvider`, `capabilities` |
| `packages/providers/src/caldav-ical.ts` | `calendarTimestamp`, `participation`, `providerId` |
| `packages/providers/src/gmail.ts` | `GmailPart` |
| `packages/providers/src/graph.ts` | `GraphAttachment` |
| `packages/providers/src/http.ts` | `readJson`, `request` |
| `packages/tools/src/response-budget.ts` | `bodyPrefix` |
| `packages/tools/src/schemas.ts` | `address`, `addresses`, `category`, `status` |

## Behavior and retained warnings

The proposal-grouping memo now computes its pure filter inside the existing memo callback,
retaining the same data/grouping dependencies and recomputation timing. The remaining resource
effect warning is intentional: the workspace version is a refresh trigger. The command-palette
test effect intentionally seeds its initial state on mount. Neither dependency array was changed.
No tests were removed or weakened, and no new test was necessary for a new domain branch.

The four required error rules remain errors: `suspicious/noExplicitAny`,
`correctness/noUnusedVariables`, `correctness/noUnusedImports`, and `style/useConst`.
`complexity/noExcessiveCognitiveComplexity` remains a warning at threshold 25.
The owner approved the documented baseline warnings below, including low-count rules whose
unsafe fixes would change UI, hook, generator-fixture, or parser behavior. The comments live in
`biome-baseline.jsonc`, extended by strict-JSON `biome.json`. No inline or file-level
`biome-ignore` comments were added.

| Rule | Remaining warnings | Severity origin |
| --- | ---: | --- |
| `a11y/noAutofocus` | 3 | Owner-approved baseline downgrade |
| `a11y/noLabelWithoutControl` | 1 | Owner-approved baseline downgrade |
| `a11y/noNoninteractiveElementToInteractiveRole` | 1 | Owner-approved baseline downgrade |
| `a11y/noNoninteractiveTabindex` | 1 | Owner-approved baseline downgrade |
| `a11y/noStaticElementInteractions` | 2 | Owner-approved baseline downgrade |
| `a11y/noSvgWithoutTitle` | 1 | Owner-approved baseline downgrade |
| `a11y/useAriaPropsSupportedByRole` | 3 | Owner-approved baseline downgrade |
| `a11y/useButtonType` | 37 | Owner-approved baseline downgrade |
| `a11y/useFocusableInteractive` | 1 | Owner-approved baseline downgrade |
| `a11y/useKeyWithClickEvents` | 3 | Owner-approved baseline downgrade |
| `a11y/useSemanticElements` | 8 | Owner-approved baseline downgrade |
| `complexity/noCommaOperator` | 2 | Default/recommended warning |
| `complexity/noExcessiveCognitiveComplexity` | 76 | Requested threshold 25 |
| `complexity/noImportantStyles` | 4 | Default/recommended warning |
| `complexity/useOptionalChain` | 5 | Default/recommended warning |
| `correctness/noEmptyCharacterClassInRegex` | 1 | Owner-approved baseline downgrade |
| `correctness/noUnsafeOptionalChaining` | 5 | Owner-approved baseline downgrade |
| `correctness/noUnusedFunctionParameters` | 12 | Default/recommended warning |
| `correctness/useExhaustiveDependencies` | 2 | Owner-approved baseline downgrade |
| `correctness/useYield` | 10 | Owner-approved baseline downgrade |
| `style/noDescendingSpecificity` | 40 | Default/recommended warning |
| `style/noNonNullAssertion` | 621 | Default/recommended warning |
| `suspicious/noArrayIndexKey` | 3 | Owner-approved baseline downgrade |
| `suspicious/noAssignInExpressions` | 0 | Owner-approved baseline downgrade |
| `suspicious/noConfusingVoidType` | 2 | Default/recommended warning |
| `suspicious/noExportsInTest` | 1 | Owner-approved baseline downgrade |
| `suspicious/noFocusedTests` | 2 | Default/recommended warning |
| `suspicious/noImplicitAnyLet` | 3 | Owner-approved baseline downgrade |
| `suspicious/noShadowRestrictedNames` | 1 | Owner-approved baseline downgrade |
| `suspicious/useIterableCallbackReturn` | 4 | Owner-approved baseline downgrade |

Total: **855 warnings**, zero errors. Biome also reports 9 informational
notices (including the requested `recommended` configuration field's deprecation notice).
The catch audit covers **203 sites**: 32 expected/narrowed fallbacks,
100 logged fallbacks, and 71 existing typed errors or propagation paths.

## Validation

Environment: Node **25.9.0**, pnpm **10.33.0**. CI retains its Node 22/24 matrix.

| Check | Result |
| --- | --- |
| `pnpm install` | Passed at every commit checkpoint; lockfile consistent |
| `pnpm build` | Passed at every checkpoint, before MCP/server tests |
| `pnpm typecheck` | Passed at every checkpoint |
| `pnpm lint` | Passed from commit 2 onward; commit 1 exception explicitly approved |
| `PASSPORT_SKIP_LIVE_HOST_AGENTS=1 pnpm test` | Passed at every checkpoint: 1,061 passed, seven intentionally skipped live tests |
| `pnpm format:check` | Passed; no fixes needed |
| `npx --yes knip --reporter json --no-progress` | Knip 6.42.1 reports `{"issues":[]}` with the documented narrow allowances |
| Shared type-contract comparison against `3bcb669` | All 88 existing interface/type/enum declarations retain identical syntax structure, ignoring formatting punctuation |
| `pnpm run pack` | Built a fresh `apps/server/dist/akd-me-passport-0.1.0.tgz` |
| `node scripts/smoke-package.mjs apps/server/dist/*.tgz` | Passed: installed CLI help, MCP dry-run, authenticated demo and persistent APIs, decisions and built UI |
| Live host-agent tests with `PASSPORT_SKIP_LIVE_HOST_AGENTS` removed | Six passed: Claude Code and Codex JSON completion, stdio MCP, and authenticated HTTP MCP; about 20 seconds |
| Live setup test with the skip variable removed | One passed: real Codex session, scripted console, simulated user responses, client registration and connected result; about 24 seconds |
| `git diff --check` | Passed |

Live commands were run once after the final source changes:

```sh
env -u PASSPORT_SKIP_LIVE_HOST_AGENTS pnpm --filter @passport/agent exec vitest run src/host/host.live.test.ts
env -u PASSPORT_SKIP_LIVE_HOST_AGENTS pnpm --filter @passport/server exec vitest run src/setup/setup.live.test.ts
```

The seven requested commits remain separate. Nothing was pushed or merged. The deliberate
retentions, baseline rule downgrades with per-rule counts, full 203-site catch table, module
splits, and dead-code decisions are recorded above. No API route, CLI flag, configuration key,
event/MCP tool name, rendered UI styling, or UI copy was changed.
