# Code-quality pass report

Branch: `t3/passport-code-quality-pass`  
Worktree: `/Users/akshaykumardileepmacmini/.t3/worktrees/passport/t3-18d9dd31`  
Base: `3bcb669`

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
| `apps/server/src/onboarding/oauth.ts:192` | c | Preserve the existing error code and propagation after cleanup; do not expose raw payloads. |
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
| `apps/server/src/setup/runner.ts:132` | b | Keep the existing operational log and fallback; never include the caught payload. |
| `apps/server/src/setup/runner.ts:251` | b | Browser helper preparation failed. |
| `apps/server/src/setup/runner.ts:342` | b | Browser helper release failed during cleanup. |
| `apps/server/src/setup/runner.ts:348` | b | Setup browser close failed during cleanup. |
| `apps/server/src/setup/runner.ts:354` | b | Setup browser output cleanup failed. |
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
| `apps/web/src/state.tsx:69` | b | Workspace event frame could not be processed. |
| `apps/web/src/state.tsx:133` | b | Resource request failed or was cancelled. |
| `apps/web/src/state.tsx:162` | b | Workspace action failed. |
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
| `packages/tools/src/schema.ts:215` | a | Malformed URL targets provide no capability; keep trying valid input. |
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
