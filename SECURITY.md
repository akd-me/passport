# Security policy

Passport is pre-release software for a single user on a trusted machine. There is
no security audit or supported multi-user/public-hosting mode. Security fixes
currently target the latest code on `main`; no older release line is maintained.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/akd-me/passport/security/advisories/new).
If that form is unavailable, ask the maintainer through the contact information
on [their GitHub profile](https://github.com/akd-me) for a private reporting channel;
do not disclose exploit details in a public issue. Maintainers should enable
private vulnerability reporting before the first release.

Include the affected version/commit, a minimal reproduction, impact and any
suggested fix. Redact tokens, provider credentials, personal mail and database
contents. There is no guaranteed response SLA during this early stage. Coordinate
public disclosure after a fix or an agreed disclosure date.

## Threat model

- The OS user, local filesystem and configured provider/model endpoints are
  trusted. A local process with access to the data directory or environment can
  access the mailbox and keys. Passport does not isolate hostile local users.
- Email, attachments, model output and external-agent instructions are untrusted.
  Provider-derived text reaches prompts and tool results framed as untrusted data
  with command sigils neutralised. Domain changes pass through the action executor,
  risk/reversibility checks, category trust, the task's clamped permission mode and
  an external-agent ceiling. No agent tool approves proposals or changes trust, and
  reader page tokens are sealed so an agent cannot redirect them. This limits
  authority; it is not a guarantee against prompt injection or an agent making a
  poor authorized choice. See [docs/security.md](docs/security.md#what-an-agent-can-and-cannot-do).
- Provider credentials are encrypted with AES-256-GCM. The key is supplied through
  `PASSPORT_MASTER_KEY` or generated in a 0600 `master.key` in the data directory;
  the Mac app keeps it in the macOS Keychain and passes it to its server on an
  inherited pipe (fd 3), never in argv or the environment. Cached envelopes and
  bodies, tasks, notes, account metadata and action history are plaintext in SQLite.
  `mail_export` copies under `scratch/` are plaintext files.
  A model key explicitly placed in configuration remains in that file. Protect
  the whole directory, environment, swap and backups; use OS disk encryption.
- OAuth setup validates state and uses PKCE. Supply your own OAuth clients and
  review the requested scopes. Treat refresh tokens as mailbox access.
- The HTTP API requires a bearer token (`api-token`) or a browser session, and
  checks Host and Origin; HTTP MCP has its own token. Anyone with a token has full
  access to that workspace. It binds to loopback by default. Docker listens on `0.0.0.0` internally
  using `PASSPORT_HOST`, while Compose maps only host loopback. Keep access local,
  through SSH, or behind tightly scoped Tailscale ACLs and an authenticating proxy.
  Do not publish MCP or the API directly to the internet, shared LANs or untrusted
  tailnet members.
- Passport does not mirror mailboxes. Offline search is partial by design: while a
  provider is unreachable, reads come from the bounded cache marked stale and changes
  to cached mail are refused until current state can be read.
- The Mac app is unsigned and not notarized, and Electron's debugging fuses are still
  on; a same-user process could run code under the app's Keychain access. See
  [the Mac app guide](docs/desktop.md#known-limitations).
- Run one backend writer per data directory. The action log is an audit trail,
  not a tamper-proof ledger against someone who can edit the database. Reversible
  operations support undo; sends are cancellable during their configured hold,
  but delivery and other irreversible operations cannot be undone.
- Header-derived verification relies on the receiving provider's trusted boundary.
  The current Passport signature verifier is a stub and does not establish a
  production hosted identity. Message content never grants verification status.

## Network and data boundaries

Passport contacts your configured mail/calendar services for on-demand reads, the
new-mail watcher, calendar sync and actions,
OAuth services for authorization, and your selected LLM endpoint for inference.
Relevant mailbox context can leave the machine in model requests. Passport has
no telemetry service or required hosted backend. External MCP clients can read
mail and may transmit it to their own model providers. Review their policies too.
Package installation and image pulls contact their respective registries.

Back up SQLite and the matching encryption key together, store encrypted backups,
and test restore before changing versions. Rotate a compromised provider token
at the provider; changing a local key does not revoke remote access. See
[deployment](docs/deploy.md) for backup and access guidance.
