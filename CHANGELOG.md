# Changelog

Notable changes are recorded here. The first version heading is the CLI artifact
version; release tags must match it. Move Unreleased to a date before tagging.

## Unreleased

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

## [0.1.0] — Unreleased

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
