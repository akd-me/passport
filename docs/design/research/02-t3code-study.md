# 02 — How T3 Code works, and what transfers to Passport

Source studied: `~/.t3/scratch/passport-refs/t3code` after `git pull --ff-only` (succeeded).
HEAD `6f75bcb` — **Wed Oct 21 2026 21:43 -0700** — "feat: ChatGPT Business usage limits offer a copyable admin request (#23361)".
All paths below are relative to that checkout. Where a statement comes from the repo's own docs rather than code, the doc is cited; the docs in `docs/internals/` and `docs/orchestration-v2/` are maintained alongside the code and match what I spot-checked in source.

---

## A. How it runs

### A1. Process architecture

```
┌──────────────── T3 Code.app (Electron 44) ─────────────────┐
│ Electron main (apps/desktop/src/main.ts, Effect services)  │
│   • window, menu, dock badge, deep links, updater, IPC     │
│   • spawns ↓ and supervises/restarts it                    │
│                                                            │
│  ┌─ Renderer: apps/web (React/Vite) ───────────┐           │
│  │  talks to the server over WebSocket RPC,    │           │
│  │  to main over a small IPC surface           │           │
│  └─────────────────────────────────────────────┘           │
└────────────────────────────────────────────────────────────┘
        │ child process: Electron binary in Node mode
        ▼
 apps/server ("t3", Node ≥22.16, Effect)  ── HTTP + WS + /mcp on 127.0.0.1:<port>
   • event-sourced orchestrator, node:sqlite, scheduler, PR sync, webhooks
   • spawns provider CLIs: `codex app-server`, Claude Agent SDK → `claude`, opencode, pi, ACP agents…
   • spawns terminals (node-pty), headless Chrome for html_render, etc.
```

- **Three-tier, with one server per environment.** `AGENTS.md` (top): "A Node WebSocket server wraps provider CLIs and agents … and serves web, desktop, and mobile clients." The glossary (`docs/internals/glossary.md`) defines an **environment** as "one running server and the machine, credentials, workspace access, and state it owns." The desktop app is just one client. It also happens to host a server.
- **The desktop spawns the server as a child process.** `apps/desktop/src/backend/DesktopBackendConfiguration.ts:538-563` sets `executablePath: process.execPath` (the Electron binary) and `ELECTRON_RUN_AS_NODE=1`, which runs `apps/server/dist/bin.mjs` in Node mode. A comment in `DesktopBackendManager.ts:434` says this is "so this backend process does not become a GUI app instance". A bootstrap envelope (port, host, one-time desktop bootstrap token/secret, telemetry fds) arrives on **fd 3**, and fds 4–7 carry telemetry and the embedded-browser control channel (`DesktopBackendConfiguration.ts:519-531`, `DesktopBackendManager.ts:400-446`). Readiness is probed over HTTP. The manager restarts the backend if it crashes. If another server already owns the state dir, the child exits with `SERVER_EXIT_CODE_STATE_DIR_OWNED` (`DesktopBackendManager.ts:801`; the lock is in `apps/server/src/serverOwnership.ts`, which uses a native SQLite handle as an ownership lock).
- **No Bun at runtime.** The server is Node (`apps/server/package.json` `engines.node: ^22.16 || ^23.11 || >=24.10`). Bun shows up only in a fixture-recording script.
- **Transport:**
  - Renderer/mobile/web ↔ server uses **Effect RPC over WebSocket** (`apps/server/src/ws.ts:3182` `RpcServer.makeProtocolWithHttpEffectWebsocket`). The typed contract lives in `packages/contracts/src/rpc.ts`, and `docs/internals/overview.md` calls it "the boundary between independently versioned clients and servers". Subscriptions are scoped: "a client viewing one thread does not pay for every thread's history."
  - Renderer ↔ Electron main uses IPC only for shell concerns: `apps/desktop/src/ipc/methods/` contains `notificationBadge`, `updates`, `window`, `preview`, `connectionCatalog`, `serverExposure`, `sshEnvironment`, `wsl`, `snapShot`, `webLinks`, `providerAuth`, `cliCommand`, `appActivation`. **No domain logic goes over IPC.**
  - Agent ↔ server uses **HTTP MCP** at `http://127.0.0.1:<port>/mcp` with a per-provider-session bearer token (section C).
- **Shared client logic** (connection, reconnect, state reducers) lives in `packages/client-runtime` so web and mobile do not diverge (`docs/internals/overview.md` "Ownership boundaries").
- **Server internals** (`AGENTS.md` "How it works", `docs/internals/overview.md` "Durable intent and side effects"):
  1. The client sends a command.
  2. The pure **Orchestrator** (`apps/server/src/orchestration-v2/Orchestrator.ts`) decides events with no I/O.
  3. **EventSink** commits, in one transaction: the events, the projections, a command receipt (for idempotent retries), and **outbox effects**.
  4. The **EffectWorker** then runs the side effects (start a provider turn, capture a checkpoint) and feeds the results back as commands.

  "A command acknowledgement therefore means the intent committed, not that the provider … finished."

### A2. Persistent state

- **SQLite via Node's built-in `node:sqlite`.** `packages/shared/src/nodeSqliteClient.ts:1` imports `node:sqlite` and wraps it as an Effect `SqlClient` (worker-thread backed). There are no native SQLite addons. Passport already made the same choice (`docs/CONTRACT.md`).
- **On-disk layout** (`apps/server/src/config.ts:115-150`, `apps/desktop/src/app/DesktopStatePaths.ts`). The base dir is `~/.t3` (override `T3CODE_HOME`); dev uses `~/.t3/dev`.
  - `userdata/statev2.sqlite`: the event log, projections, receipts, outbox, scheduled tasks, and webhook dedupe tables.
  - `userdata/settings.json`, `keybindings.json`, `themes/`, `attachments/`, `browser-artifacts/`, `secrets/`, `logs/` (`server.trace.ndjson`, `provider/events.log`, `terminals/`), `environment-id`, `server-runtime.json`.
  - Under the base dir itself: `caches/` (provider status), `worktrees/` (git worktrees T3 creates), and `scratch/` (project-less threads, `docs/user/thread-sidebar.md` "Start without a project").
- **Secrets:** the server has its own store (`apps/server/src/auth/ServerSecretStore.ts`, files under `userdata/secrets`). The desktop uses Electron `safeStorage` (Keychain-backed on macOS) for client-side things such as saved connections (`apps/desktop/src/electron/ElectronSafeStorage.ts`). Secrets the agent asks for go through `request_secret` → a one-use `secretRef` (`apps/server/src/secrets/SecretRequests.ts:1-5`: "the value never reaches the transcript, projections, clients, or model context").

### A3. Packaging, signing, updating (macOS)

- **Builder:** `electron-builder` 26, driven by `scripts/build-desktop-artifact.ts`. Package scripts: `dist:desktop:dmg`, `:dmg:arm64`, `:dmg:x64`. App id `com.t3tools.t3code` (`build-desktop-artifact.ts:65`). Product name "T3 Code (Beta)".
- **Mac target** (`build-desktop-artifact.ts:2880-2945`): `dmg` + `zip` (the zip feeds the updater) and category `developer-tools`. `extendInfo` sets usage strings for local network, screen capture, camera, and microphone, plus `CFBundleDocumentTypes` so the app can be the default browser. `protocols` registers the **`t3code://`** and `t3code-dev://` URL schemes (and http/https as a viewer). It also sets entitlements and a provisioning profile for passkeys, and uses a themed per-channel DMG background.
- **Signing:** `scripts/sign-macos.ts` wraps `@electron/osx-sign` (batch codesign). Notarization uses Apple API-key secrets (`APPLE_API_KEY`, `_ID`, `_ISSUER`) and is auto-detected in CI. The env flag `T3CODE_DESKTOP_SIGNED` and `T3CODE_APPLE_TEAM_ID` select it. `docs/operations/release.md:22,48` covers signing and notarizing DMGs. Every native addon is signed "since the hardened runtime refuses unsigned libraries". Windows uses Azure Trusted Signing.
- **Native code stays out of the main process.** `docs/internals/overview.md` (last section): "Native modules never load in the Electron main process on the startup path … new native capability goes in a child with a deadline, not an `import` in main."
- **Auto-update:** `electron-updater` (`apps/desktop/src/updates/DesktopUpdates.ts`) checks at startup, then on a poll and on channel change. The feed is a GitHub Releases provider (`build-desktop-artifact.ts:2756,2862-2880`). Channels are **stable** and **nightly**, with **preview** as a maintainer-only train that has no update feed (`docs/operations/release.md:7-22`). The desktop can also push updates to remote servers (`DesktopRemoteUpdates.ts`).
- **CI builds** six desktop artifacts per release (mac arm64/x64 DMG, Linux AppImage/deb, Windows NSIS) plus a self-contained `t3` CLI archive per platform (`release.md:34-48`).

### A4. Server-only / web / remote modes

- **`npx t3` / `t3 serve`** runs the same server headless and serves the web UI locally (`AGENTS.md` "Multi-surface"). `t3 service install` installs a **launchd user agent** on macOS (`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`) or a systemd user unit on Linux. It "starts the service when you log in and stops it when you log out" (`docs/user/background-service.md`). Environment overrides go in `~/.t3/service.env`.
- **Hosted web** (`app.t3.codes`) is *only a client*: it "stores its connection catalog in the browser and connects directly to each environment. It does not proxy traffic" (`docs/internals/remote.md`).
- **Mobile** (React Native) is another client of any environment.
- **Routes to a server:** LAN, Tailscale, SSH (desktop main can launch a server over SSH), and **T3 Connect**. Connect uses Clerk identity plus a Cloudflare relay (`infra/relay`) that brokers managed tunnels. After bootstrap, traffic goes through the environment's tunnel hostname and the relay does not proxy it. **The one exception is webhooks:** the relay forwards `/v1/hooks/:environmentId/:hookId/:token` so senders get a stable URL. It can optionally *hold* requests for up to 24h in a Durable Object while the environment is offline (`docs/internals/t3-connect.md:1-30`). Push notifications to mobile also need Connect (`docs/user/mobile-notifications.md`).
- **Outside agents:** any MCP client (Claude Code in a terminal, ChatGPT, bots) can connect to `https://<env>/mcp`, sign in with OAuth plus a pairing code, and be granted **Read only** or a runtime-mode ceiling (`docs/user/outside-agents.md`; `apps/server/src/mcp/McpInvocationContext.ts:36-41` `clientRuntimeModeCeiling`).

### A5. Hosting agent CLIs

- **Finding them:**
  - Each provider instance has a `binaryPath` setting, defaulting to the bare name (`claude`, `codex`) (`packages/contracts/src/settings.ts:597,681`).
  - The desktop **hydrates PATH from the user's login shell** (`$SHELL -ilc …`, with `launchctl getenv PATH` as a fallback on macOS) before spawning the backend, so Homebrew/nvm/mise installs resolve (`apps/desktop/src/shell/DesktopShellEnvironment.ts:314-424`). That covers the classic "GUI apps don't get your shell PATH" problem.
  - Provider updates run through whichever installer *owns* the binary: brew/npm/native, else `claude update` / `codex update` (`docs/internals/providers.md` "Provider updates…").
- **How each one runs:**
  - **Codex:** `codex app-server` (JSON-RPC over stdio; `apps/server/src/provider/codexLaunchArgs.ts:13`), with T3's MCP injected via `-c mcp_servers.t3-code.url=…` and the bearer token in env `T3_MCP_BEARER_TOKEN`.
  - **Claude:** `@anthropic-ai/claude-agent-sdk` with `pathToClaudeCodeExecutable` = the resolved binary (`apps/server/src/provider/ClaudeProvider.ts:215`; `ClaudeAdapterV2.ts:1360-1395`). It gets `mcpServers: { "t3-code": { type: "http", url, headers: { Authorization } } }` and `allowedTools: ["mcp__t3-code__*"]`, with `settingSources: ["user","project","local"]` so the user's own Claude config, skills, and CLAUDE.md apply (`ClaudeAdapterV2.ts:3925`).
  - **Others:** Cursor (SDK), Grok and ACP-registry agents (ACP over stdio), OpenCode 1.x/2.x, Pi (RPC mode plus a T3-owned extension that bridges MCP), Antigravity.
- **Env passed:** the desktop strips its own `T3CODE_*` control vars from what it forwards (`DesktopBackendConfiguration.ts:72-126`). Per instance, users can set **environment variables** and **launch args**. Multi-account works through per-instance config homes, e.g. `CLAUDE_CONFIG_DIR=~/.claude_personal`, `CODEX_HOME` (`docs/user/providers-claude.md:7-40`). Antigravity scrubs ambient Google credentials so instances cannot cross accounts (`docs/internals/providers.md`).
- **Health checks must not trigger setup:** "Opening a provider session can start MCP servers, run hooks, or launch a login browser", so probes avoid it (`docs/internals/providers.md`).

### A6. Window closed, background work, notifications, dock, deep links

- **Closing the window does not quit on macOS.** `apps/desktop/src/app/DesktopLifecycle.ts:244-253` quits on `window-all-closed` only when `platform !== "darwin"`, and `activate` (dock click) re-opens the window. The backend child lives in main's scope, so **agents keep running with no window open**. Quitting uses a "hold ⌘Q" confirmation by default (`apps/desktop/src/window/QuitHold.ts`, `QuitConfirmationMode` default `"hold"` in `packages/contracts/src/settings.ts:226-228`). The renderer runs with `backgroundThrottling: false` (`DesktopWindow.ts:401`).
- **No tray or menu-bar icon.** I found no `Tray` usage; the dock icon is the presence.
- **For true always-on hosting**, users run the launchd service, and the desktop can act as a client of it or of any remote environment.
- **Server-side background loops run without any client connected:**
  - the **Scheduler**, a 5-second tick (`apps/server/src/scheduling/Scheduler.ts:57`);
  - scheduled tasks and webhooks;
  - **PR sync and PR watch** (2-minute cadence);
  - **thread settlement** (auto-settle after 3 days idle or PR merged; `docs/internals/overview.md`, `docs/user/thread-sidebar.md`);
  - "resume at usage-limit reset" continuations.

  `apps/server/src/background/BackgroundPolicy.ts` tracks **client activity leases** (45s TTL) and host power state, to decide when opportunistic work should run.
- **Notifications:**
  - **Desktop/web:** OS notifications are raised **by the renderer** with the web `Notification` API (`apps/web/src/components/ThreadNotificationCoordinator.tsx`), and the dock badge count goes over IPC (`apps/desktop/src/ipc/methods/notificationBadge.ts:37` `app.setBadgeCount`). Triggers: an agent finishes, fails, needs approval, or asks a question (icons in that file).
  - **Mobile:** push and Live Activities via T3 Connect (`docs/user/mobile-notifications.md`).
  - **Inference, not verified at runtime:** desktop OS notifications depend on a live renderer.
- **Deep links:** the `t3code://` scheme is registered (`build-desktop-artifact.ts:2909`; `ElectronApp.setAsDefaultProtocolClient`, with special handling on Linux in `DesktopLinuxUrlHandler.ts`). `open-url` is used for Clerk OAuth return and Codex auth callbacks (`apps/desktop/src/app/DesktopClerk.ts:210`, `CodexAuthCallback.ts`). Agents link threads as `t3-thread://v1/<threadId>`, which the client resolves (`docs/orchestration-v2/orchestrator-mcp-server.md` "t3_thread_read").

---

## B. How a task is structured

### B1. Entities

From the glossary and `docs/orchestration-v2/core-graph-and-data-model.md`:

| Concept | Meaning |
|---|---|
| **Environment** | One server and its machine, credentials, and state. A client can connect to many. |
| **Project** | "An environment-local workspace record rooted at a directory." Optional: project-less threads get a folder under `~/.t3/scratch`. |
| **Workspace** | The project root checkout, **or** a git **worktree** (`~/.t3/worktrees/…`) bound to the thread. Thread fields: `branch`, `worktreePath`. The binding is chosen at launch (`workspaceStrategy: root | worktree{baseRef,branch,startFromOrigin} | existing_worktree`). The `t3.json` `scripts[].runOnWorktreeCreate` setup runs in the background; `runOnSettle` cleans up. |
| **Thread** (`AppThread`) | "The durable conversation and work history … survives provider process exits." Holds `modelSelection`, `runtimeMode`, `interactionMode`, branch/worktree, `lineage {parentThreadId, relationshipToParent: fork|subagent}`. |
| **Run** | One counted user-visible turn. Status: `queued → starting → running → waiting → completed / interrupted / failed / cancelled / rolled_back`. Has `RunAttempt`s (steer-by-restart, retry, recovery). |
| **ExecutionNode** | The tree under a run: `root_turn, assistant_message, reasoning, plan, todo_list, tool_call, approval_request, user_input_request, subagent, hook, system`. Only the root completes the run. |
| **ProviderSession / ProviderThread** | The live CLI process and its native conversation handle. One app thread can switch providers between runs. |
| **RuntimeRequest** | An approval (`command`, `file-read`, `file-change`, `mcp-elicitation`, `permission`) or a user-input question, persisted with an app-owned id. |
| **Checkpoint** | A hidden git ref captured before and after each run. It powers the per-turn diff and restore. |
| **ContextTransfer / Handoff** | Fork, provider switch, merge-back, subagent spawn/result, with portable summaries when native transfer is impossible. |

### B2. Lifecycle: compose → turn → tools → approvals → diff → PR

1. **Compose** (`docs/user/composer.md`). Markdown composer with up to 100 attachments per message. Large pastes become file attachments. Inline **context chips** (terminal excerpt, diff/review comment, preview annotation, file, PR `#123`, another thread `@title` as a lazy reference). `/` for commands, `$` for skills, `/goal`, `/compact`, `/plan`. You pick provider/model, **permission mode**, and **interaction mode** (Default/Plan) in the composer. `Cmd+Enter` on a new thread starts it **in the background** and opens another draft. Shift-clicking several models sends the same prompt to N threads/worktrees. A prompt stash is on `Cmd+S`.
2. **Send.** `thread.message.send` creates the user message, a `Run(queued)`, and a root node. The outbox effect starts the provider turn; the provider session and thread are created lazily (`feature-lifecycles.md` "Creating Threads / Starting A Run").
3. **Streaming.** The adapter emits normalized `ProviderAdapterV2Event`s (B5). Turn items (`packages/contracts/src/orchestrationV2.ts:1339-1543`): `user_message, assistant_message, reasoning, proposed_plan, todo_list, user_input_request, file_change, command_execution, file_search, web_search, approval_request, checkpoint, run_interrupt_request/result, system_notice, error, compaction, handoff, fork, thread_created, subagent, dynamic_tool (MCP tools), notification`. Live command output streams as `command_output.delta`, which is **not persisted** and goes only to clients showing that row.
4. **Approvals.** A provider request becomes a `RuntimeRequest` plus an approval node, and the thread status becomes *waiting*. The user picks from `accept | acceptForSession | acceptAlways | decline | cancel` (`packages/contracts/src/providerPolicy.ts:49-55`). The panel sits **at the composer** (`apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx`, `ComposerPendingApprovalActions.tsx`). Questions use `ComposerPendingUserInputPanel.tsx`. A response fails with `not_resumable` if the provider callback died.
5. **Turn end → finalization barrier.** Flush streams, finalize plans/todos, **capture the checkpoint**, compute the turn diff, then mark the run terminal (`feature-lifecycles.md` "Completion Barriers"). Provider-turn end and follow-up settlement are distinct milestones: a late diff must not keep a spinner alive (`overview.md` "Turn completion and checkpoints").
6. **Review.** The thread shows the **changed files and diff for that turn only** (`docs/user/source-control.md` "Review turn changes"), plus a branch comparison. **Edit from here** rewinds the conversation, optionally with **Revert files too** (worktree threads only, refused if another thread shares the dir) (`composer.md` "Edit an earlier prompt"). Rollback calls the provider's native rollback when it has one; a provider that cannot roll back must refuse before touching files.
7. **Ship.** Git actions in the thread: commit, push, create PR, with AI-generated commit message, title, and description that draw on the thread's work and checks (`source-control.md` "Create a pull request"). The agent must `link_pull_request` any PR it creates (system prompt, section C). PR sync then keeps status current. **Review guides** (AI "tours" of a PR), merge, auto-merge, revert PR. `watch_pull_request` lets the agent babysit CI and comments.
8. **Settle.** A finished thread moves to **Settled** manually, or automatically after 3 days idle or when its PR merges. **Snooze** hides it until a time. Undo is available for 5s on every settle/snooze/archive (`docs/user/thread-sidebar.md`).

### B3. What the thread UI shows (web/desktop)

- **Sidebar.** Sections: **Pinned / Active / (Working, beta) / Snoozed / Settled**. The Working fold holds threads that are running or *monitoring* and pops them back "when it finishes, fails, or needs an approval or answer", ordered "by when each thread last came back to you" (`thread-sidebar.md` "Fold working threads"). Rows show status, PR badges, and diff stats. You can drag between sections to pin, settle, or wake; drag a thread onto the composer as context; or drop files on a row.
- **Timeline** (`apps/web/src/components/chat/MessagesTimeline.tsx`, `docs/user/activity-log.md`): user and assistant messages, with **consecutive tool calls collapsed into an expandable summary** ("Ran 2 commands and sent messages to 3 threads"). Up to two categories are named, prioritizing commands, file changes, and orchestration over reads. Expanding a call shows its input, output (live tail), and exit code, plus an **Open diff** button. Also in the timeline: proposed-plan cards (`ProposedPlanCard.tsx`), subagent progress (`ProviderSubagentBar.tsx`, the "Agents" view), **secret-request cards** (`SecretRequestCard.tsx`), inline HTML renders from `html_render` (`HtmlRenderFrame.tsx`), MCP App frames, citations, and notices.
- **Composer area:** the approval or question panel, the queued-messages control (`QueuedRunsControl.tsx`), a context-window meter, usage limits, goal row, plan follow-up banner, and banners for provider status and server updates.
- **Right panel** (`apps/web/src/rightPanelStore.ts:16-83`) has tabs for `diff` (per-turn), `files` / `file`, `preview` (an embedded, agent-drivable browser tab per thread), `terminal` (persistent per-thread PTYs), `device` (iOS/Android simulators), `pull-request`, and `pull-requests`. The thread header has details: PR rows, automations (`ThreadAutomationsPanel.tsx` lists scheduled tasks bound to this thread), branch toolbar, and "Open in…" editor.
- **Command palette** (`Cmd+K`) searches threads across environments.

### B4. Permission and interaction modes

- **`RuntimeMode`** = `approval-required | auto-accept-edits | auto | full-access` (`packages/contracts/src/providerPolicy.ts:25-32`). **Default is `full-access`.** The UI labels are Supervised / Auto-accept edits / Auto (provider's automatic review) / Full access (`docs/user/permission-modes.md`).
  - It is chosen **per thread in the composer**, with an environment default and a per-project override.
  - Providers that lack a mode degrade to `approval-required`. Muse has only Supervised and Full; Grok has no Auto-accept edits.
- **`ProviderInteractionMode`** = `default | plan`, a separate axis ("Plan: investigate read-only and return a concrete plan"; prompts in `packages/provider-core/src/server/orchestrationInstructions.ts`).
- **Privilege ceiling for agents:** a child or another targeted thread "may stay equal to or become narrower than the parent mode. It may not escalate" (`orchestrator-mcp-server.md` "Policy And Idempotency"). External MCP clients carry their own ceiling.
- **How the mode reaches the provider:** `ProviderAdapterV2RuntimePolicy { runtimeMode, interactionMode, cwd, approvalPolicy?, sandboxPolicy?, reasoningEffort? }` is passed to every session and turn (`packages/provider-core/src/server/ProviderAdapter.ts:48-55`). Each adapter maps it to native flags; for example, OpenCode full-access replies `once` so it can't widen a shared server's grants.

### B5. Queueing and steering

- **Three dispatch modes** (`feature-lifecycles.md` "Steering And Queueing Messages"): **steer in place** (provider-native), **steer by restart** (interrupt, then a new `RunAttempt` under the same Run, for providers without native steering), and **queue after active** (a new Run).
- **In the UI:** a client setting picks Queue or Steer as the default; `Cmd+Enter` does the opposite one. Queued messages are **server-persisted**, can be edited, reordered, removed, or promoted to steer, and are **held** after Stop or a server restart until **Resume** (`composer.md` "Queued messages").
- **For agents:** `t3_thread_send` with `mode: auto | queue | steer | restart`, and the `t3_queue_*` tools.
- **Idempotency:** every MCP or scheduled send derives stable command and message ids from a `clientRequestId` or fire-key.

### B6. Provider / driver abstraction

- **Terms** (glossary): **driver** = the integration for a provider kind. **Instance** = one configured account/config of a driver (route by instance, so two Claude accounts never share state). **Adapter** = the protocol translator. **Session** = the live process.
- **Contract:** `packages/provider-core/src/server/ProviderAdapter.ts`.
  - Capabilities and `openSession`.
  - Session methods: `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `interruptTurn`, `respondToRuntimeRequest`, `readThreadSnapshot`, `rollbackThread`, `forkThread`, `compactThread?`, `injectHistory?`, `stopSubagent?`, `mcpApps?`.
  - One **event stream** of the normalized union (`:79-176`): `app_thread.created`, `provider_session.updated`, `provider_thread.updated`, `provider_turn.updated`, `node.updated`, `subagent.updated`, `message.updated`, `turn_item.updated`, `command_output.delta`, `runtime_request.updated`, `plan.updated`, `turn.terminal` (completed/interrupted/cancelled, or failed with `failure` + optional `retry`, plus `threadDisposition: reusable|broken`).
- **Implementations:** `apps/server/src/orchestration-v2/Adapters/{Codex,Claude}AdapterV2.ts`, and `packages/provider-{acp,cursor,grok,opencode,pi,muse}`. There is a guide for adding one (`docs/internals/adding-a-provider.md`) and a capability doc (`docs/orchestration-v2/provider-capability-system.md`).
- **Rule:** "Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb." (`AGENTS.md` "Taste"). Raw provider frames go only to diagnostic logs; the normalized V2 event is the durable row.

---

## C. Tools the agent gets, and how

### C1. Injection and auth

- **Before opening a provider session**, `ProviderSessionManager` asks `McpSessionRegistry` for a credential scoped to *(environment, thread, provider instance, provider session)*. It expires on idle or max lifetime and is revoked when the session ends (`apps/server/src/mcp/McpSessionRegistry.ts:98-130`; `orchestrator-mcp-server.md` "Transport And Authentication").
- **Capability flags on the credential** (`apps/server/src/mcp/McpInvocationContext.ts:14-20`): `orchestration`, `worktree`, `pull-requests` always; `preview` when browser tools are enabled; `device`.
- **Handler wrapper:** every handler goes through `McpToolAccess` (`reads`, `readsAsCaller`, `actsAsCaller`, `writes`). It refuses writes from read-only clients and requires a **live calling run** for mutations (`apps/server/src/mcp/McpToolAccess.ts`).
- **Registration:** all toolkits register in `apps/server/src/mcp/McpHttpServer.ts:991-1080`. Tool annotations (`Readonly`, `Destructive`, `Idempotent`, `OpenWorld`) are set per tool.

### C2. Tool catalogue (from `apps/server/src/mcp/toolkits/*/tools.ts`)

The `C`/`O` column distinguishes two kinds of tool:
- **C (capability):** gives the agent a new power to observe or act on the world for the current task.
- **O (orchestration):** manipulates T3's own work graph (threads, runs, queue, schedules, links).

| Group | Tools | Kind | Notes |
|---|---|---|---|
| Capability discovery | `orchestrator_capabilities` | O | Providers, models (short list + `search`), runtime modes, inherited options. |
| Delegation (subagents) | `delegate_task`, `task_status`, `task_cancel`, `t3_workflow_stop` | O | Child thread + run; `mode: async|wait`; role; inherits provider/model/modes; no privilege escalation; parent is woken on child completion and gets child questions. |
| Top-level threads | `create_threads` (1–20, shared checkout), `t3_thread_launch` (one, explicit `workspaceStrategy`) | O | "Only when the user explicitly asks for separate threads." |
| Thread read/write | `t3_thread_list`, `t3_thread_read` (`messages`/`activity` views, incremental `afterPosition`), `t3_thread_search`, `t3_thread_update` (rename, regenerate title, link/unlink PR), `t3_thread_send` (`auto|queue|steer|restart`), `t3_thread_wait`, `t3_thread_interrupt` | O | Provenance recorded: `createdBy: agent`, `creationSource: mcp`. |
| Thread housekeeping | `t3_thread_organize` (pin/snooze/settle/archive/unread), `t3_thread_configuration`, `t3_thread_configure` (provider/model, **not** permission mode), `t3_thread_fork`, `t3_thread_merge_back`, `t3_thread_transfers` | O | |
| Queue | `t3_queue_list/read/edit/cancel/reorder/promote_to_steer` | O | |
| Pending requests | `t3_pending_request_list/read/respond` | O | Answers **questions only**; "This cannot approve a permission request." |
| Scheduling & automation | `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now` | O | Section D. |
| Secrets | `request_secret` | O (human-in-loop) | Private card in the thread; returns a one-use `secretRef`. |
| Pull requests | `link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`, `watch_pull_request`, `unwatch_pull_request`, `write_pull_request_guides`, `read_pull_request_guide` | O / C | `watch_*` is the wake mechanism (D4). "Guides" are reviewer **tours** of a PR, not agent instructions. |
| Projects & workspaces | `t3_project_list/read/create/update/delete/clone`, `t3_worktree_handoff` (move *this* thread into a new worktree), `t3_worktree_status`, `t3_worktree_list` | O | |
| Environment | `t3_environment_read`, `t3_environment_preferences_update` (incl. ≤4,000-char custom instructions) | O | |
| Attachments | `t3_attachment_prepare_upload`, `t3_attachment_discard`, `t3_thread_send_attachments` | O | |
| Collaborative browser | `preview_status/open/dialog/navigate/resize/set_appearance/snapshot/click/type/hover/select/drag/upload/press/scroll/evaluate/wait_for/recording_start/recording_stop`, `t3_preview_list`, `t3_preview_close` | **C** | Shared with the user's visible tab; the agent may act only on `unclaimed` tabs, not while `human` is driving. |
| Devices | `device_list/open/screenshot/close` | **C** | iOS/Android simulators streamed into the Device panel. |
| Visual output | `html_preview` (headless screenshot + console), `html_render` (inline page in the thread above the reply) | **C** | |

**What is not here:** the agent's **core capabilities** (shell, file read/edit, grep, web search) come from the **provider CLI itself**. T3 adds no file or shell tools; it only *observes* them as normalized turn items and gates them through permission modes. Passport's design differs here: its domain tools (search, read, draft, send) must be **its own MCP tools**, because mail is not a local filesystem the CLI can reach.

### C3. System prompt / instructions

- **Provider-native instructions** stay in charge. Claude gets `systemPrompt: { type: "preset", preset: "claude_code", append: … }` (`ClaudeAdapterV2.ts:1379-1386`). Codex keeps its own collaboration-mode developer instructions (Default/Plan text in `apps/server/src/provider/CodexDeveloperInstructions.ts`).
- **T3 appends three things:**
  1. `buildRuntimeInstructions` (`packages/provider-core/src/server/runtimeInstructions.ts`): `<runtime_info>` (harness, model, effort) plus a `<pull_request_linking>` policy block.
  2. **`T3_CODE_ORCHESTRATION_SECTIONS`** (`packages/provider-core/src/server/orchestrationInstructions.ts:8-40`), only when the T3 MCP server is attached: delegate_task vs. new threads, review rounds, schedule_task schema, request_secret, `t3-thread://` links, workspace choice for `t3_thread_launch`, MCP name-prefix and ACP fallbacks, "Showing visuals" (`html_preview` → `html_render`). These are authored as self-contained sections under 4 KB because "Codex cuts the middle out of any entry over 4,000 bytes".
  3. `T3_CODE_BROWSER_TOOL_INSTRUCTIONS`, when preview tools exist.
- **Delivery per provider:**
  - Claude: system-prompt append.
  - Codex: `additionalContext` entries `t3_code_orchestration_01…` (`CodexDeveloperInstructions.ts:205-230`).
  - OpenCode: system prompt.
  - Cursor/Pi: prepended to the **first user message** inside `<t3_code_orchestration_instructions>` (`t3OrchestrationPromptForFirstRun`).
  - ACP: re-sent in a `<t3_code_instructions>` wrapper whenever the mode or tool availability changes, because ACP has no system field (`t3AcpPromptWithInstructions`).
- **User-level custom instructions:** an environment preference (`t3_environment_preferences_update` `customInstructions`, ≤4,000 chars).
- **Project guides:** **T3 does not inject AGENTS.md or CLAUDE.md into agent turns.** The provider CLI loads them natively; Claude uses `settingSources ["user","project","local"]`. T3 itself reads `AGENTS.md` and `CLAUDE.md` only for its own text generation (commit messages and PR descriptions, `apps/server/src/git/GitManager.ts:850-868`). Repo config lives in `t3.json` (setup/settle scripts, defaults such as `worktreeSubmodules`). "Review guide instructions" are a Settings field with a per-project override (`source-control.md`).
- **Untrusted input is framed explicitly.** Webhook values arrive wrapped in `<webhook-data-…>` tags, "marked as untrusted request data". `$`, `@`, and a leading `/` get an invisible character so `$skill`, `@file`, and `/command` don't fire (`docs/user/project-settings.md` "Webhook automations"). Passport needs this for mail bodies.

---

## D. Background / proactive work

### D1. Scheduled tasks

- **Storage and execution:** the `scheduled_tasks` table in `statev2.sqlite`, run by `ScheduledTaskService` (`apps/server/src/scheduledTasks/ScheduledTaskService.ts`). The service registers `runDueTasks` with the shared **Scheduler**, a 5-second tick with one permit per source (`apps/server/src/scheduling/Scheduler.ts`). Due tasks run with `concurrency: 1`.
- **Schedule kinds** (`apps/server/src/scheduledTasks/Schedule.ts`; tool text in `mcp/toolkits/orchestrator/tools.ts:120`):
  - `{type:"interval", everyMs}`
  - `{type:"fixed_time", timeOfDay:"09:00", weekdays:[1..5]}` (environment time zone)
  - `{type:"webhook", signature?, filters?, replayKey?, coalesceKey?, coalesceWindowSeconds?}`
- **Stored with the task:** prompt, project, title, model selection, runtime and interaction modes, workspace strategy, `createdBy` / `creationSource`, `enabled`, `nextRunAt`, `lastRunStatus`, `runCount`.

### D2. Binding a run to a thread

`runTask` (`ScheduledTaskService.ts:728-935`):
- If `task.threadId === null`, it calls `threadLaunch.launch(...)`, which creates a **fresh top-level thread per run**, seeded with the stored model, modes, and workspace strategy. The initial message carries `scheduledTaskId`.
- Otherwise it calls `threadManagement.sendToThread({ mode: "queue", scheduledTaskId, … })`, which posts **into the bound thread**. A bound run "follows the thread's current provider".
- **Default:** a task created by an agent from inside a thread in the same project binds to that thread (`bindToCurrentThread=true`). The tool description gives the reason: this "suits an orchestrator that sees every trigger, delegates work, and can dedupe against what is in flight". Deleting a thread deletes the tasks bound to it (`deleteForThread`).

### D3. Surfacing, dedupe, and failure handling

- **Results** surface as ordinary thread activity: messages show their `scheduledTaskId`, the thread rises in the sidebar and notifies like any finished run, and the per-thread **Automations** panel plus Settings → Scheduled tasks show `lastRunAt`, `lastRunStatus`, `lastRunError`, and `nextRunAt`. Webhook tasks have a **Deliveries** log showing each request and the prompt it rendered (`project-settings.md`).
- **Overlap guard:** an in-memory `activeRuns` set. If the same task is already running, a scheduled tick silently skips it, and a manual or webhook trigger errors (`:737-748`). The task row is re-read before firing (paused, deleted, or postponed → no fire).
- **Idempotency:** `commandId = scheduled-task:<taskId>:<startedAtMs>:<trigger>` (or `:webhook:<deliveryId>`) makes a dispatch replay-safe (`:813-820`).
- **Missed `fixed_time` runs** (machine asleep) are **skipped and rescheduled**, not back-filled (`rescheduleMissedRun`). Runs stuck in `running` after a crash are marked failed on startup ("Run was interrupted by a server restart").
- **Webhook dedupe** (`scheduledTasks/webhookDedupe.ts`):
  - **replayKey**: a template such as `{{headers.x-github-delivery}}`, hashed. The same key is ignored for **7 days** per task.
  - **coalesceKey + window** (10–3600s, default 120): one run after the window from the first delivery closes, using the **latest** payload.
  - Pending windows survive restarts.
  - Rate limits: 10 log entries per task per minute; 60 coalesced updates per minute, then HTTP 429.
  - **filters**: `equals | notEquals | in | startsWith | exists`, with `[]` fan-out over arrays (`webhookFilter.ts`).
  - **signature**: HMAC with a secret given via `request_secret`.
  - **Prompt templating**: `{{body.x}}`, `{{headers.x}}`, `{{query.x}}`, `{{body}}`, `{{request}}`, each wrapped as untrusted data (`webhookTemplate.ts`).
  - A **public URL** needs the T3 Connect relay, which can hold requests while offline and dedupes redelivery via `x-t3-relay-delivery-id` (`docs/internals/t3-connect.md`).

### D4. `watch_pull_request`: how a thread is woken

- **`PullRequestWatchReactor`** (`apps/server/src/orchestration-v2/PullRequestWatchReactor.ts`) polls watched PRs **every two minutes**. It is grouped per project and uses host fingerprints to save rate limit.
- **It wakes the thread when:** a check fails, the required checks pass, **someone else** comments or reviews (only comments after the watch began), or the branch starts conflicting (`pullRequestWatch.ts`). It stops a chatty bot from looping an agent by counting consecutive comment-only wakes.
- **The wake** is `engine.dispatch({ type: "thread.pull-request-watch.sync", …, wake: { text, notification: { source: {kind:"monitor"}, outcome, summary } } })` (`:268-287`). It lands in the thread as a **message carrying a `notification`** (`OrchestrationV2Notification`: `source ∈ delegated_task | subagent | command | monitor | background_task | system`, `outcome`, `summary`, `detail`; `packages/contracts/src/orchestrationV2.ts:1046-1089`), and that starts a new run.
- **While watching**, the thread sits in the user's **Working** section, not their inbox. The agent must `unwatch_pull_request` when handing back, "so the thread returns to their inbox".
- **The watch ends** on merge/close, settle/archive, the user's Stop, unwatch, or after 8 consecutive read failures. On that last one it also posts a "stopped watching" wake.
- **Inbox semantics stay consistent:** wakes from background work or PR watches do **not** count as "resuming" for auto-settle (`thread-sidebar.md`). A snoozed thread stays hidden through background wakes and comes back only for an approval, a question, a failure, or a user message (`orchestrator-mcp-server.md` "t3_thread_read" snooze paragraph).
- **The same wake pattern** is used for delegated-task completion (`delegatedCompletion` on the message), child-thread questions forwarded to the parent, and background commands.

**Generalized pattern for Passport:** *a monitor owned by the server polls or receives an external event → it dispatches a command → a `notification`-tagged message is appended to a specific thread → that starts a run with the thread's own provider and permission mode → the thread moves from the **Working** section to the inbox if and when it needs the human.*

---

## E. Transfer to email

| T3 Code concept | Email analogue | Where the analogy holds / breaks |
|---|---|---|
| **Environment** (one server owning machine, creds, state) | One Passport host (`~/.passport`, Mac app or `passport serve`) | Holds well: the server owns OAuth tokens, SQLite, and the CLIs, and clients are just views. Same remote story (LAN, Tailscale, a relay for webhooks and push). |
| **Project** (workspace record rooted at a directory) | **Mail account** (or a group of accounts) | Mostly holds: per-project defaults (model, permission mode, instructions) map to per-account defaults. **Breaks:** many tasks span accounts ("reply from work, cc personal"). Consider letting a thread bind 1..N accounts, or a "No project"/scratch analogue for cross-account tasks. |
| **Workspace: root checkout vs. git worktree** | Live mailbox vs. a **sandbox overlay**: staged labels, archives, drafts recorded as pending Actions, not yet applied to the provider | **Breaks hardest.** A worktree is a *private copy* where an agent can make many changes and you review the sum. A mailbox has no cheap fork. The closest analogue is Passport's action log in "staged" state: the agent's changes accumulate as proposed `ActionRecord`s scoped to the thread and are applied on approval. Without that, "root vs. worktree" collapses to "supervised vs. auto". |
| **Thread** (durable conversation + run history) | A **task on the mailbox**: "clear my inbox", "find the Hetzner invoice", "reply to Priya" | Holds. The thread should be the unit in the sidebar, not the email thread. Passport's **matter** is closer to a long-lived *project-scoped* thread or a pinned thread. Note T3's "thread" is *not* the email conversation; pick distinct vocabulary (task vs. conversation). |
| **Run / turn**, streamed tool calls, collapsible activity groups | One agent pass: `search(…)`, `get(…)`, `label(…)` calls grouped as "Searched 3 times, read 12 messages, archived 40" | Holds directly. T3's summary rules carry over: name two categories, prioritize writes over reads, never over-claim ("waiting on" ≠ "done"). |
| **grep / ls / read / file_search** (native CLI tools) | Provider `search` / `list` / `get` / thread fetch as **Passport MCP tools** | **Breaks structurally.** In T3 the CLI's built-in tools touch the filesystem directly. In Passport every read and write must go through Passport's MCP, *on demand*. That is the fix for "sync the whole mailbox before agents can work": query the provider live, cache what's read, sync incrementally in the background. |
| **Permission / runtime modes** (Supervised, Auto-accept edits, Auto, Full access) + per-request `accept / acceptForSession / acceptAlways / decline` | Passport's existing `supervised / auto_accept_edits / auto / full_access` + per-category trust | Already aligned. Map "edits" to reversible mailbox mutations (label, archive, mark read, draft) and "commands" to irreversible or outward actions (send, delete-forever, accept invite). `acceptForSession` / `acceptAlways` map naturally to "allow archiving newsletters for this task / always". T3's **no-escalation rule** for child tasks and external clients maps to Passport's `externalAgentCeiling`. |
| **Interaction mode: Plan** | "Propose only": the agent drafts a plan or proposal list and makes no mutations | Holds. |
| **Approval panel at the composer** | Approve / edit / reject a proposed action or draft inline in the task | Holds. T3 keeps approvals in the thread and at the composer, not in a separate global feed. Passport's current Decisions feed is closer to T3's sidebar "needs you" signal than to its approval UI. |
| **Checkpoint + per-turn diff** | **Per-run action summary**: what this run changed (labels added, N archived, drafts created, sends queued) | Holds as UI. **Breaks on restore:** T3's "Revert files too" is a git ref restore; Passport needs per-action inverses (already in the contract) and must say which are irreversible. T3's rule that a provider which can't roll back must refuse *before* touching anything is worth copying. |
| **Diff review → commit → PR** | **Draft/action review → outbox → send** | Draft review is the diff. **Send ≈ merge**, not PR: it is the irreversible publish. The **delayed outbox** is closer to T3's queued run (editable, cancellable, held on Stop). A PR is an artifact *others* review asynchronously; the email analogue is the sent message awaiting a reply. |
| **Linked PR + PR sync + settle-on-merge** | Linked **email conversation(s)** for a task, kept in sync; **auto-settle when the conversation resolves** (reply received, invoice paid, meeting accepted) | Holds well. "Thread settles when its PR merges" becomes "task settles when the counterpart replies or the matter closes". |
| **`watch_pull_request`** (2-min poll; wake on checks, comments, conflict) | **`watch_conversation`**: wake the task when *someone else* replies, a bounce or auto-reply arrives, or a deadline approaches | This is the proactive core. Copy the semantics: only *new* events after the watch began wake it; watching keeps the task in **Working**, not the inbox; unwatch on hand-back; a give-up after repeated read failures posts a wake; a loop guard for auto-replies. |
| **Scheduled tasks** (interval / fixed_time / webhook), bound thread vs. fresh thread per run, replay and coalesce keys | "Every weekday 9:00 triage", "on new mail matching X → run task" | Holds. **New mail ≈ webhook trigger:** Gmail Pub/Sub push or Graph change notifications are literal webhooks, and IMAP IDLE/polling is the `interval` case. Use T3's dedupe: `replayKey = {{messageId}}` (7-day), `coalesceKey = {{threadId}}` with a window so a burst of 5 replies runs once; filters on sender, label, or list headers. **Bound-thread default:** one long-lived "Inbox orchestrator" thread sees every arrival and delegates, versus a fresh task per message. |
| **Untrusted-input framing** (`<webhook-data-…>`, neutered `$ @ /`) | Mail bodies, subjects, and attachments are hostile by default | Must copy, and strengthen. Every provider-derived string in a tool result or trigger prompt gets the same wrapper. |
| **`delegate_task` / subagents** (parent woken on completion, child questions routed up) | "Triage" parent fans out to per-matter or per-message children; children ask the parent, not the user | Holds. T3's rule that "subagent threads can't take messages; when a child needs an answer the parent asks" keeps the inbox from filling with child tasks. |
| **Queue / steer** follow-ups | "Also unsubscribe me from those" mid-run (steer) vs. "then do X" (queue) | Holds unchanged. |
| **Sidebar sections**: Pinned / Active / Working / Snoozed / Settled + Undo toast | Task list with the same sections; the human's **inbox = tasks that came back needing you** | Strong fit. T3 already has inbox semantics ("returns the thread to their inbox"). Snooze hides a task even while its agent wakes for background work; it surfaces only for a question, approval, failure, or user message. |
| **Git history / reflog** | **Action log with undo** | Holds; Passport already has it. T3's per-turn attribution ("files Git brought in are left out") maps to "show only changes this task made, not ones that arrived by sync". |
| **AGENTS.md / CLAUDE.md** (loaded by the CLI natively) + environment custom instructions + `t3.json` | **USER.md** (standing instructions, tone, VIPs) + per-account overrides + routine definitions | Partial. T3 never injects AGENTS.md itself; it relies on the CLI. Passport has no repo, so it **must inject USER.md** itself, through the system-prompt append (Claude) or `additionalContext` (Codex), as T3 does with its orchestration sections (keep each under 4 KB for Codex). |
| **`request_secret` → one-use `secretRef`** | Asking for an IMAP app password, a webhook secret, or an OAuth client secret during setup | Holds directly. It is better than having the CLI drive a browser and paste secrets. |
| **`html_render` / preview / device panels** | Render a digest, an invoice table, or a calendar view inline; "preview" the drafted email as it will be received | Holds. A rendered email preview is the email "preview pane". |
| **`t3-thread://` links, `@thread` context chips** | `passport-task://…`, `@task`, and chips for a person, matter, message, or attachment | Holds. |
| **Desktop: Electron main → Node server child (fd-3 bootstrap, `ELECTRON_RUN_AS_NODE`) → CLI grandchildren; login-shell PATH hydration; keep running on window close; launchd service for always-on; DMG + zip; osx-sign + notarize; electron-updater on GitHub Releases; custom URL scheme for OAuth return** | Passport Mac app | Transfers almost verbatim. Passport's server is already Node + `node:sqlite` with no native addons, which is exactly the constraint T3 keeps in the main process. A `passport://` scheme suits Google and Microsoft OAuth returns. **Gap to note:** T3 has no menu-bar or tray presence, and its desktop notifications come from the renderer. A mail app that wakes on new mail probably wants a menu-bar item and main-process notifications so alerts fire with no window. |

**Short opinions for the designer:**
1. The decisive transfer is T3's **thread-as-task with a server-owned lifecycle** (inbox ↔ working ↔ snoozed ↔ settled, woken by monitors). Passport's current "decisions feed" is a flattened version of this.
2. Mailbox access should look like T3's provider tools: **on-demand MCP queries**, not a precondition sync.
3. The weakest analogy is the **worktree**. Decide early whether Passport gets a real "staged changes" workspace, because it determines whether "review the diff, then apply" is possible or only "approve each action".
