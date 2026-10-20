# Deploying Passport

Passport currently assumes one user on a trusted machine. The API has **no
authentication**: anyone who can reach it can read mail and request actions.
Keep it on localhost, through SSH, or behind Tailscale with restrictive ACLs and
an authenticating proxy. Do not expose port 3000 directly to the internet or a
shared LAN. Origin checks and HTTPS do not replace authentication.

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
successful remote-provider sync or model availability.

On a NAS, use Compose/Container Manager with these same mount and port settings.
If using a bind mount instead of a named volume, create a private directory
writable by UID/GID 1000 before starting. Do not use world-writable permissions.
The initial named volume is populated with the image directory's ownership.
Use one replica per volume; there is no distributed writer lock.

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

OAuth uses a one-shot loopback listener on port 53682 by default. Do account
setup while the main backend is stopped, using the same data directory.

```sh
docker compose stop passport
docker compose run --rm passport accounts add imap
docker compose up -d
```

**Current limitation:** the OAuth callback listener binds to loopback *inside*
the container. A normal published Docker port does not forward to that listener,
so publishing port 53682 cannot complete browser OAuth in a bridged container.
For Gmail/Graph, use the native CLI on the Docker host against a private bind-mounted
data directory while the container is stopped. Ensure the container UID can read
that directory afterward. Another Linux-specific option is running the one-shot
setup container with host networking and the same volume; audit your Docker/NAS
networking before using it. Do not broaden callback binding by patching source.
The IMAP setup command above does not need a callback. See [accounts](accounts.md)
for provider fields and scopes.

For a **native server** on a remote host, forward both the UI and the callback
port to your laptop before running `passport accounts add gmail` in the remote
shell. The browser callback remains the registered loopback URL:

```sh
ssh -N -L 3000:127.0.0.1:3000 -L 53682:127.0.0.1:53682 your-server
```

The SSH target must be running the callback listener natively or via an explicitly
configured host-network setup. The public API does not accept OAuth setup flows.

## Remote access and reverse proxies

For a simple home-server connection, keep the default Compose port mapping and
use an SSH tunnel:

```sh
ssh -N -L 3000:127.0.0.1:3000 your-server
```

Then open http://127.0.0.1:3000. Tailscale can also provide private reachability;
limit ACLs to you and keep the API behind a proxy with authentication. Never use
public Tailscale Funnel for this unauthenticated service.

A proxy must protect **all** routes, including `/api` and `/ws`, enforce
trusted host/origin handling and forward WebSocket upgrades. The current
WebSocket handler expects an `http://` origin matching the backend Host header;
a TLS-terminating proxy must deliberately reconcile that trusted origin/host
boundary. Do not strip arbitrary Origin headers to bypass checks. A generic
HTTPS proxy recipe is not supplied because this path has not been live-tested.
Use the local HTTP/SSH path until proxy authentication and WebSocket behavior
are verified in your deployment.

HTTP MCP binds independently to **container loopback**, port 4318. Merely
publishing that port will not make it reachable through Docker bridge networking.
For native installs, an SSH tunnel to 4318 can reach the host loopback listener.
Otherwise use a native `passport mcp` backend **instead of** the container backend
for that data directory. `docker exec ... passport mcp` would start a second writer
and is not a supported way to attach to the existing backend. Do not publish an
unauthenticated MCP endpoint.

## Backups and upgrades

Back up the whole data directory and the matching encryption secret. If
`PASSPORT_MASTER_KEY` is supplied externally, save it securely with the backup;
otherwise include `master.key`. Losing the key makes saved provider credentials
unreadable. The database contains plaintext mail; encrypt backup storage.

Stop the service for a consistent SQLite snapshot, including any WAL files:

```sh
docker compose stop passport
mkdir -p backups
chmod 700 backups
# Run from this Compose project so /data mounts the correct named volume.
docker compose run --rm --no-deps --entrypoint tar passport -C /data -czf - . > backups/passport-data.tar.gz
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

For example, tag `v0.1.0` when ready. The verification job uploads the exact CLI
tarball; the npm job publishes that tarball. The image job builds from the same
tag and pushes both Linux architectures. The GitHub release is created only
after both publish jobs succeed and attaches the CLI tarball with changelog notes.
Publishing to npm/GHCR and GitHub release creation have not been live-tested by
local packaging checks. A partial failure can leave an already-published npm
version; rerun only failed jobs after inspecting the registries rather than
trying to overwrite an immutable npm version.
