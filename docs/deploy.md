# Deploying Passport

This page is the server path: `passport serve` on a home server, NAS or any always-on machine. On
a Mac you use directly, the [Mac app](install.md#mac-app) is simpler; it runs the same server.

Passport assumes one user on a trusted machine. The API requires its bearer token
or a browser session; use the startup login URL or `passport token`. Keep the
listener on localhost, through SSH, or behind a verified HTTPS proxy with restricted
access. See [security](security.md) for token rotation, Host/Origin checks and proxies.

## Docker on a home server or NAS

The image uses a pnpm build stage and a Node 24 Debian slim runtime, installs the
same npm tarball used for releases, and runs as the non-root `node` user (UID
1000). SQLite is built into Node; no native SQLite addon is installed.

```sh
git clone https://github.com/akd-me/passport.git
cd passport
cp .env.example .env
chmod 600 .env
# Edit .env privately if you want automatic model-backed triage.
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 passport
```

Browse to http://127.0.0.1:3000 on the Docker host. Compose publishes
`127.0.0.1:3000:3000` and uses a named `passport-data` volume for `/data`. It loads
`.env`; leaving the model keys empty is supported. The container starts
`passport serve`, not the disposable demo.

`PASSPORT_HOST=0.0.0.0` is set **inside the container** so Docker port forwarding
can reach the server. Native installs retain the server's loopback default.
`PASSPORT_DATA_DIR=/data` and the volume preserve config, database and the
generated key. Do not override these settings without migrating your data.
The health check requests `/api/health`; it reports process readiness, not
provider reachability, watcher health or model availability. `passport doctor`
(or `docker compose exec passport passport doctor`) reports each account's last
watcher check and cursor age.

Passport does not mirror mail, so a new deployment has no initial sync to wait
for and no mailbox-sized database to grow. Agents read mail on demand through the
provider; the new-mail watcher checks each account every 30 seconds. Set
`PASSPORT_WATCH_INTERVAL_SECONDS` in `.env` (5–86400) to poll less often, for
example on a metered connection; Gmail polling at the default costs about 240
quota units an hour per account. See [accounts](accounts.md#watching-for-new-mail-account-controls-and-diagnostics).

On a NAS, use Compose/Container Manager with these same mount and port settings.
If using a bind mount instead of a named volume, create a private directory
writable by UID/GID 1000 before starting. Do not use world-writable permissions.
The initial named volume is populated with the image directory's ownership.
Use one replica per volume. The data-directory owner lock prevents a second live server; PID checks assume processes share the same host PID namespace, so do not share a data directory across containers/hosts.

After the first release, pull the published image instead of building locally:

```sh
docker compose pull
docker compose up -d --no-build
```

Images are published at `ghcr.io/akd-me/passport` with version, major.minor and
`latest` tags for stable releases. Pin a version or image digest for repeatable
upgrades. Registry commands require the package/image to have been published;
local builds work before that. The release workflow builds Linux amd64 and arm64.
Cross-architecture and NAS-specific deployment still need validation on the
actual target hardware.

## Providers and OAuth callbacks

Set model configuration and private keys through `.env`; see the
[installation reference](install.md#configuration). On Docker Desktop, a host
Ollama service is usually reachable as `http://host.docker.internal:11434`.
On Linux, configure an appropriate host gateway or an internal container service
address. `localhost` inside the container points to the container itself.
Limit model endpoint access to trusted clients too.

Run `passport serve` and use **Connect another** in the sidebar (or **Settings → Accounts**). Gmail
uses your own Google **Desktop app** OAuth client; Outlook uses a native/public
Microsoft registration. The browser callback uses the server's HTTP port at
`http://127.0.0.1:3000/oauth/callback` (substitute your configured port).
Google and Microsoft calendar permissions are optional in the same flow.
See [accounts](accounts.md) for registrations, scopes, IMAP and consent.

For a remote server, forward the UI port with SSH and keep Passport open on the
same loopback address in your browser. Native CLI initialization also supports
a one-shot callback on port 53682; that separate listener needs its own tunnel.
`passport init --llm none --skip-account` initializes without prompts or account consent.

## Remote access and reverse proxies

For a simple home-server connection, keep the default Compose port mapping and
use an SSH tunnel:

```sh
ssh -N -L 3000:127.0.0.1:3000 your-server
```

Then open http://127.0.0.1:3000. Tailscale can also provide private reachability;
limit ACLs to you and keep the API behind a proxy with authentication. Never use
public Tailscale Funnel without verifying the authenticated proxy deployment described in [security](security.md).

A proxy must preserve Authorization, cookies, browser Origin, the intended Host,
WebSocket upgrades and `X-Requested-With`. Configure exact allowed hosts with
`PASSPORT_ALLOWED_HOSTS`; never rewrite arbitrary browser Origins to trusted ones.
For TLS termination, use `PASSPORT_TRUST_PROXY=true` only when the proxy overwrites
`X-Forwarded-Proto` and direct access is restricted. See [security](security.md).

HTTP MCP binds independently to **container loopback**, port 4318. Merely
publishing that port will not make it reachable through Docker bridge networking.
For native installs, an SSH tunnel to 4318 can reach the host loopback listener.
A stdio client may also run `docker exec -i <container> passport mcp` in client mode against
the same data directory; it starts no background jobs. HTTP MCP requires its separate bearer
token from `PASSPORT_MCP_TOKEN` or `<data-dir>/mcp-token`. Do not expose that token publicly.

## Backups and upgrades

Back up the data directory and the matching encryption secret, except
`setup-browser-profile/` and `setup-agent/` (the agent-driven setup browser's live
Google/Microsoft console sign-in and scratch files, recreated on demand, and never to be archived),
`scratch/` (`mail_export` copies of mail for MCP clients) and `host-agent/` (per-call working
directories). If
`PASSPORT_MASTER_KEY` is supplied externally, save it securely with the backup;
otherwise include `master.key`. Losing the key makes saved provider credentials
unreadable. The database contains plaintext cached mail, tasks and notes; encrypt backup storage.
The mail itself stays at the provider, so a lost cache costs nothing but a re-read.

Stop the service for a consistent SQLite snapshot, including any WAL files:

```sh
docker compose stop passport
mkdir -p backups
chmod 700 backups
# Run from this Compose project so /data mounts the correct named volume.
docker compose run --rm --no-deps --entrypoint tar passport -C /data --exclude=./setup-browser-profile --exclude=./setup-agent --exclude=./scratch --exclude=./host-agent -czf - . > backups/passport-data.tar.gz
chmod 600 backups/passport-data.tar.gz
docker compose up -d
```

Keep these archives outside git/build contexts and move them to encrypted
storage. Restore into a fresh private volume while the backend is stopped,
restore the same key/environment, preserve UID 1000 ownership, then verify the
health endpoint, accounts and action history before reconnecting providers.
Test restores periodically. Migrations run on startup; a rollback may require
restoring the pre-upgrade snapshot, so back up before upgrading.

## Releasing

The existing CI runs build, typecheck and tests on Node 22 and 24. The tag
workflow in `.github/workflows/release.yml` adds a packed-install smoke check,
then publishes npm and GHCR artifacts and creates a GitHub release from the
matching `CHANGELOG.md` section.

Maintainer setup before the first tag:

1. Ensure `@akd-me/passport` is publishable under the `akd-me` npm scope. Add
   repository Actions secret **`NPM_TOKEN`**, using a granular token with publish
   permission for that package and suitable automation/2FA settings. Scope it
   narrowly and rotate it. The publish job uses `npm publish --provenance` with
   `id-token: write` and public access. GitHub/npm provenance requires a public
   source repository and a compatible npm account/package setup; validate this
   on the first real release.
2. Permit the workflow's **`GITHUB_TOKEN`** to write packages and repository
   contents. It logs into GHCR and creates the release; no separate GHCR PAT is
   needed. Ensure `ghcr.io/akd-me/passport` inherits repository access and make
   the container package public after its first publication if needed.
3. Enable GitHub private vulnerability reporting and review repository/tag
   protection. The workflow publishes on `v*` tags; restrict who can create them.
4. Update the first `CHANGELOG.md` heading, replacing Unreleased with the release
   date, and commit it. That heading supplies the generated CLI version; the
   tag must be exactly `v<version>`. Run `pnpm build`, `pnpm test`, `pnpm run pack`
   and the installed-package smoke check before pushing the tag.

For example, tag `v0.3.0` once the `0.3.0` heading is committed. The workflow does not build,
sign or upload the Mac app; that is milestone M3 in the [Mac app guide](desktop.md#m3-signing-notarization-and-updates). The verification job uploads the exact CLI
tarball; the npm job publishes that tarball. The image job builds from the same
tag and pushes both Linux architectures. The GitHub release is created only
after both publish jobs succeed and attaches the CLI tarball with changelog notes.
Publishing to npm/GHCR and GitHub release creation have not been live-tested by
local packaging checks. A partial failure can leave an already-published npm
version; rerun only failed jobs after inspecting the registries rather than
trying to overwrite an immutable npm version.
