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
