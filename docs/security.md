# Local server security

Passport is a single-user, local-first email harness. Its HTTP API can read mail, change trust policy, and submit mail/calendar actions. Possession of the API token grants that workspace's full API access; this is not a multi-user permission system. Protect the token, terminal output, login links, and data directory like credentials. Local processes running as your OS user can read the token and are outside this boundary.

The default listener binds to `127.0.0.1`. A 32-byte random token is stored as hex in `<data dir>/api-token` with mode 0600, unless `PASSPORT_API_TOKEN` supplies one. Demo tokens are ephemeral unless explicitly supplied. Opening the startup login URL or submitting the token to `/api/auth/login` creates an opaque HttpOnly, SameSite=Strict cookie and redirects to a URL without the token. Sessions last at most 24 hours and do not survive server restart. `passport token --rotate` revokes file-backed tokens and sessions on the next authentication check; restart also closes any existing WebSockets. Explicit environment tokens require an environment change and restart to rotate.

Host validation blocks DNS rebinding: only `127.0.0.1`, `localhost`, `[::1]`, and exact entries in `PASSPORT_ALLOWED_HOSTS` are accepted. Invalid Hosts receive 421 before routes execute. Origins, when supplied for state-changing HTTP requests or WS upgrades, must use HTTP(S) and an allowed host. Cookie-authenticated writes additionally require `X-Requested-With: passport`. Together with SameSite=Strict and no CORS permissions, these checks prevent a foreign website from driving the local API. Bearer clients may omit the custom header but must still pass Host and Origin checks. API queries cannot authenticate with a query token; only root login and WS upgrades accept one.

The built UI runs under a self-only CSP with no inline scripts or framing (inline styles are allowed). `nosniff`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` reduce content confusion, token referrer leakage, and caching. Authentication does not protect against compromised extensions, malicious local software, or an XSS flaw on a trusted origin. Treat every added allowed host as trusted; ports may be constrained explicitly with `name:port`.

## Remote access and reverse proxies

A non-loopback `PASSPORT_HOST` requires an explicit `PASSPORT_API_TOKEN` or `--allow-remote` and produces a warning. The bind address is not automatically an allowed Host. Add the intended LAN/Tailscale/proxy hostname to `PASSPORT_ALLOWED_HOSTS`; do not use wildcards. Prefer keeping Passport on loopback behind a restricted proxy.

A reverse proxy must terminate HTTPS, restrict who can reach the backend, preserve the intended Host and browser Origin, and pass WebSocket upgrades, Authorization, cookies, and `X-Requested-With`. Never rewrite arbitrary browser Origins to a trusted one. If setting `PASSPORT_TRUST_PROXY=true` (or `1`), the proxy must overwrite `X-Forwarded-Proto` with the actual external scheme and prevent direct untrusted access to that header. Forwarded HTTPS then produces Secure cookies. `X-Forwarded-Host` is ignored for trust decisions. Redact token query strings and Authorization/Cookie headers from proxy/access logs; keep the login redirect and auth responses uncached. Use TLS so tokens and cookies are not exposed in transit.

This boundary covers the UI/API listener and its `/ws` upgrade. The separate MCP HTTP listener has its own authentication configuration and must be secured independently. The `passport mcp` stdio command starts no UI/API listener and is unaffected by Host validation.

Only `serve`/`demo` owns background work for a data directory, using an atomic PID/start-time
lock and a 10-second heartbeat (stale after 60 seconds, or when the PID exits). Stdio MCP is a
client: it opens no listener, scheduler or arrival queue. CLI jobs/trust/decisions/sync/triage
use the running server's bearer-authenticated API; authentication failures never fall back
to a separate local execution. MCP installer previews recursively redact values under
authorization/token/secret/key/password keys, including existing unrelated client entries.
Actual configs and backups can contain credentials and must remain private.

## Agent-driven account setup

Setup tasks (`/api/setup/tasks`, `passport accounts connect`) run a host-agent CLI with a visible
browser. The setup tools listen on `127.0.0.1` behind a random per-task bearer token that is revoked
when the task ends. The CLI and the Playwright MCP download (`npx`) get an allowlisted environment
(home and temp directories, locale, `PATH`, `npm_config_*`, proxy and certificate variables);
`PASSPORT_*` values and provider API keys are withheld. `npm_config_*` is forwarded so a private
registry keeps working; it can include npm's own registry token.

OAuth attempts a task starts belong to that task. Cancelling or ending the task deletes its unused
setup links and revokes its attempts (dropping the client secret held in memory); a callback already
in flight re-checks the task immediately before storing credentials and stops with a "setup task
has ended" page. Only one task runs at a time, and a new one cannot start until the previous task's
agent and browser have shut down, because they share the browser profile and output directory.

Task snapshots (HTTP and the `setup.task.updated` WebSocket event) are scrubbed of registered
secrets and secret-shaped strings, and agent narration additionally drops token-like runs of 16 or
more characters that mix letters and digits. When a secret becomes known (`register_oauth_client`),
text already retained in the task is scrubbed again and a corrected snapshot is published. Frames
published before that cannot be retracted: a client that received them keeps them, so treat the
setup log like terminal output.

## Mail is untrusted data

Message bodies, subjects, sender names, labels and attachments come from whoever sent the mail.
Passport treats them as data, never as instructions:

- Task prompts wrap provider-derived text in an `<untrusted-data source="…">` block that says the
  text is data, and neutralise the sigils host agents treat as commands: `$`, mention-style `@` and
  a line-leading `/` get an invisible joiner. Tool results do the same, and timeline items that may
  quote mail are flagged `untrusted` and rendered as plain text.
- Tool-call summaries in a task's timeline are redacted (bodies, secret-named fields and
  token-shaped strings) and at most 200 characters.
- Sender verification comes from authentication headers and the provider's trusted boundary,
  computed once per envelope. Message content never grants verification, and `notes_write` cannot
  change a person's relationship or verification fields.
- Each Codex or Claude Code call is a fresh run in `<data dir>/host-agent` with its own tools,
  shell and plugins disabled and a minimal environment, so mail cannot drive local commands.

This framing reduces prompt injection; it does not make it impossible. The limits below are what
holds when a model follows instructions it should not.

## What an agent can and cannot do

An agent (the built-in runtime or an MCP client) **can** list, search, grep and read mail through
the providers you connected, read attachments, keep notes on people and matters, watch a
conversation for replies, and propose or perform changes through the action executor.

It **cannot**:

- Write anything except through the executor, which applies the global trust mode, category trust,
  always-ask rules, risk and reversibility checks, and the outbox hold for sends.
- Exceed its ceiling. A task's permission mode is clamped to the trust dial and to its parent task,
  and enforced on every action of its runs; plan mode records writes as proposals only. MCP clients
  are capped by `externalAgentCeiling`, and the HTTP MCP bearer token grants access, not trust.
- Approve its own proposals, change trust, or claim another actor's undo. Approvals go through
  `/api/actions/:id/approve` (the UI or an API client holding the UI token); no tool approves,
  rejects or edits trust settings, and tools accept no actor or category override.
- Read credentials or provider settings, or make arbitrary provider requests: `provider_get` is a
  read-only allowlist.
- Steer a reader with a forged page token. Graph and IMAP page tokens, which name provider links
  or UID anchors, are sealed with HMAC-SHA256 (Gmail's own opaque page tokens are passed through); an edited token fails with `INVALID_CURSOR`
  before anything in it is used. The sealing key is derived from the master key with HKDF, so
  tokens survive a restart without a second stored secret.

`mail_export` writes copies of mail to `<data dir>/scratch/<session>/` (0700) for MCP clients with a
shell. Those copies are readable by your OS user and by whatever the client runs; see
[installation](install.md#data-directory).

## Keys

Provider credentials are encrypted with AES-256-GCM under a master key. The CLI and Docker use
`PASSPORT_MASTER_KEY` or a 0600 `<data dir>/master.key`. The Mac app keeps the key in the macOS
Keychain through Electron's `safeStorage` and hands it to its server as JSON on an inherited pipe
(file descriptor 3, named by `PASSPORT_BOOTSTRAP_FD`), never in the command line or environment,
so `ps eww` cannot read it. The server closes the pipe after reading it and never forwards the key
to `claude` or `codex`. Every process that opens the store checks its key against an HMAC key check
and fails with `MASTER_KEY_MISMATCH` rather than writing credentials nobody else can read. See
[the Mac app guide](desktop.md#encryption-key-in-the-keychain) for import, recovery and the residual
risks of an unsigned build.

## Offline is partial, on purpose

Passport does not keep a copy of your mailbox. When a provider cannot be reached, reads fall back to
cached envelopes and bodies marked with `staleAsOf`, and changes to cached mail are refused
(`PROVIDER_UNAVAILABLE`) until the executor can read the current state again. This is a deliberate
trade: there is no full local mail store to steal, back up or keep in sync, at the cost of search
that only covers what was recently read while offline.
