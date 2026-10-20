# Changelog

Notable changes are recorded here. The first version heading is the CLI artifact
version; release tags must match it. Move Unreleased to a date before tagging.

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
