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

### Known limitations

- Pre-release software. Provider and model integrations have offline test
  coverage; live account/model delivery must be validated separately.
- The HTTP API has no authentication. Keep it on localhost or behind a private,
  authenticated access boundary. One backend writer per data directory.
- Persistent storage needs SQLite FTS5: stock Node 22.5 lacks it despite exposing
  `node:sqlite`. Use Node >=22.16 with FTS5, preferably Node 24. The CLI reports
  missing FTS5 before opening the workspace; the demo works on Node 22.5.
- Irreversible actions, including delivered sends, cannot be undone. Trust is a
  policy boundary, not a prompt-injection proof.
- Hosted identity and SMTP+ are parked. No hosted Passport service is required.
