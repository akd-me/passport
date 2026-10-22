# Connect your accounts

Passport connects Gmail and Outlook through **your own** OAuth client, so no third party sits between
you and your mail. Creating that client used to mean a tour of the Google Cloud or Microsoft Entra
console. Now your agent does it: you click one button, sign in when asked, and approve access.
Account passwords, client secrets and tokens go through the encrypted credential store. OAuth
verifiers and browser login states stay in memory; authorization attempts expire after ten minutes.
Use the local server on the same computer as your browser.

## Let your agent set it up

Requirements: `passport serve` (not the demo), a signed-in host agent (Codex, or Claude Code as the
fallback; see [Start a workspace](#start-a-workspace)), Google Chrome or Microsoft Edge, and Node's
`npx` with network access the first time.

1. Click **Connect another** in the sidebar (or **Settings → Accounts → Connect an account**), choose
   **Gmail** or **Microsoft**, leave **Connect calendar too** as you want it, and start the setup. From a terminal:
   `passport accounts connect --provider gmail|microsoft [--no-calendar] [--agent codex|claude-code]`.
2. A browser window opens. The agent opens the Google Cloud console (or Microsoft Entra app
   registrations). When it asks, **sign in in that window** and click **Continue** in Passport (press
   Enter in the terminal). The agent never types passwords or codes for you.
3. The agent creates or reuses a project named Passport, enables the Gmail (and Calendar) API, sets up
   the consent screen with you as a test user, and creates a **Desktop app** client (Microsoft: a public
   client app registration with the `http://127.0.0.1:<port>/oauth/callback` redirect and the delegated
   Graph permissions listed below). If a console page is not what it expects, it asks you a question
   instead of guessing. A checklist and a log in Passport show what it is doing.
4. Passport stores the client encrypted and the agent opens Google's (or Microsoft's) consent page in
   the same window. **You** choose the account and approve; Google will say the app is unverified,
   which is expected for your own client (**Advanced → Go to Passport**). The mailbox connects and
   Passport starts watching for new mail at once; there is no first sync.

When the agent asks you to confirm something, **No** tells it to stop that step and ask you how to
proceed. Cancel at any time; the agent and the browser stop, and a consent page still open in the
browser can no longer connect the account. A new task can start once the old browser has closed.
Things already created in the console stay and are reused next time. Run the task again for each account; the browser remembers your console sign-in.

How it works: Passport starts a host-agent session (Codex with `gpt-6.1-sol` at high reasoning, else
Claude Code with `claude-opus-5-5`) with two MCP servers. The browser is
[Playwright MCP](https://github.com/microsoft/playwright-mcp) (`npx -y @playwright/mcp@0.0.83`, pinned),
headed, on your installed Chrome, then Edge, then Playwright's Chromium (if neither browser is
installed, run `npx -y @playwright/mcp@0.0.83 install-browser chrome-for-testing`). Code-running,
file-upload and network-inspection browser tools are not offered to the agent. Passport's setup tools
(`ask_user`, `report_progress`, `register_oauth_client`, `wait_for_connection`, `finish`) run on a
`127.0.0.1` listener that accepts only a random per-task bearer token, passed to the CLI outside its
argument list and revoked when the task ends. `register_oauth_client` goes through the same PKCE flow
as the manual wizard; the agent's browser opens a single-use `/oauth/setup/<ticket>` link that binds the
attempt to that browser. The client secret never enters the task log, the event stream or the agent's
instructions; log text is scrubbed of it and of secret-shaped strings.

**The setup browser profile** lives in `<data dir>/setup-browser-profile` and keeps you signed in to
the Google/Microsoft console between tasks. It holds live console cookies: keep it out of git (the
repository's `.gitignore` excludes it) and out of backups (see [deployment](deploy.md#backups-and-upgrades)).
Delete the directory to sign the setup browser out. Screenshots the agent takes go to
`<data dir>/setup-agent/browser-output` and are deleted when the task ends.

Known limits: Google sometimes refuses sign-in in a browser controlled by automation ("This browser or
app may not be secure"). If that happens, sign in to the console in that window again later or use the
manual steps below. Consoles change; the agent works from goals and landmarks (see
`apps/server/src/setup/prompt.ts`) and asks you when stuck.

## Start a workspace

From a built checkout, run `passport init` (during development:
`pnpm --filter @passport/server exec tsx src/cli.ts init`). It lists the Codex and Claude Code CLIs it
found and offers `auto` (the default: use whichever is signed in), `codex`, `claude-code`, `advanced`
(an API provider) or `none`. Host agents use your subscription and need no key. Under `advanced`,
cloud API keys are entered without terminal echo; explicitly entered keys are saved in the private
config file, or set `PASSPORT_LLM_API_KEY` in the environment instead. `none` leaves mail usable
without an agent. The wizard creates the data directory, `master.key` and `passport.config.json`.
Keep the master key with any encrypted database backup. For unattended setup use
`passport init --llm auto --skip-account` (or `--llm none`), or pipe `none\nskip\n` to `passport init`.

The CLI can connect a first mailbox with a one-shot callback listener on
`http://127.0.0.1:53682/oauth/callback`. It prints the URL and waits up to ten minutes. For a different
listener port set `PASSPORT_OAUTH_REDIRECT_URI`; register that exact callback for Microsoft.

Run `passport serve`, then open `http://127.0.0.1:3000/accounts`. An empty workspace opens the account
wizard at `/` too. `PASSPORT_PORT` changes the HTTP port. All browser instructions below use
`http://127.0.0.1:<port>/oauth/callback`; substitute the running server's port. Keep the original tab
open: it shows authorization progress and receives account updates over WebSocket. The consent tab
returns to Accounts after connecting. Repeat for every personal, work and secondary mailbox.

## Set up manually

The same OAuth clients the agent creates, step by step, plus IMAP.

### Gmail with your own desktop OAuth client

1. Open [Google Cloud console](https://console.cloud.google.com/). Use the project selector →
   **New project** → name it → **Create**, then select it.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**. Repeat for **Google Calendar API**
   if connecting a calendar.
3. **Google Auth Platform → Branding → Get started** (or **OAuth consent screen** in older console
   navigation). Enter an app name, your support email and contact email; complete the setup.
4. **Google Auth Platform → Audience** → choose **External** for personal Gmail or accounts across
   organizations. Under **Test users → Add users**, add every Google address you plan to connect.
   Workspace-only registrations can use **Internal** when the organization permits it.
5. **Google Auth Platform → Data Access → Add or remove scopes** → add `openid`, `email`,
   `https://www.googleapis.com/auth/gmail.modify` and optionally
   `https://www.googleapis.com/auth/calendar.events` → **Update → Save**.
6. **Google Auth Platform → Clients → Create client → Application type: Desktop app** → name it
   → **Create**. Copy the client ID. Download the client JSON if needed; its `installed` object
   contains `client_id` and `client_secret`. A desktop client uses a loopback redirect; do not create
   a Web application client for this flow.
7. In Passport, open the connect dialog, choose **Gmail → Set up manually**, enter the client ID and optionally the client
   secret. Leave **Connect calendar too** checked for your primary calendar, or clear it for mail only.
   Click **Connect**. If the browser blocked the tab, use **Open authorization tab**.
8. Select the intended Google account and grant the requested mail permissions. Calendar consent
   is optional; Passport creates the calendar account only when that scope was granted. Return to
   Passport; the account is usable as soon as it shows **Watching**. The account address comes from Google's userinfo endpoint.

Google may show **Google hasn't verified this app**. For a client you created for your own use,
choose **Advanced → Go to <your app name> (unsafe)** and review the permissions. If Google blocks
access rather than offering that link, check the test-user list and your Workspace administrator's
app-access policy. Google's [personal-use exception](https://support.google.com/cloud/answer/13464323)
allows limited personal apps to remain unverified. Gmail's restricted scopes can require verification
and a CASA security assessment for broader distribution; this setup does not make Passport a verified
public OAuth application.

External projects left in **Testing** typically issue refresh tokens that expire after seven days
with mail scopes. For daily use, **Google Auth Platform → Audience → Publishing status → Publish app**
can move your own project to production while it remains unverified under the personal-use exception.
Re-authorize after changing status. Review Google's
[OAuth token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)
and [unverified app limits](https://support.google.com/cloud/answer/7454865).

Google desktop apps support S256 PKCE and an optional client secret; Passport never puts the secret
in the authorization URL. See [Google's desktop flow](https://developers.google.com/identity/protocols/oauth2/native-app).

#### Gmail through IMAP and an app password

1. Open [Google Account](https://myaccount.google.com/) → **Security & sign-in → How you sign in to Google
   → 2-Step Verification** → enable it.
2. Open [App passwords](https://myaccount.google.com/apppasswords) (also reachable by searching account
   settings for **App passwords**). Enter a name such as `Passport` → **Create**. Copy the generated
   password into Passport's app-password field. If the option is absent, account security settings,
   Advanced Protection or an organization's policy may prohibit it. Google's
   [app-password guide](https://support.google.com/accounts/answer/185833) lists the conditions.
3. In Passport choose **IMAP / SMTP**. Use your full Gmail address as email and username,
   IMAP host `imap.gmail.com`, port `993`, TLS; SMTP host `smtp.gmail.com`, port `465`, TLS.
   SMTP username/password can remain blank to reuse IMAP credentials.
4. Click **Test connection**, then **Add account**. This path connects mail only; it does not connect a calendar.
   Do not enter your normal Google password. A Workspace administrator must allow IMAP access.

### Outlook.com and Microsoft 365

1. Open [Azure portal](https://portal.azure.com/) → **Microsoft Entra ID → App registrations →
   New registration**. Enter a name. For both personal and work accounts, select **Accounts in any
   organizational directory … and personal Microsoft accounts** → **Register**. A directory may
   restrict who can create registrations; use an authorized registration in that case.
2. On **Overview**, copy **Application (client) ID**.
3. **Authentication → Add a platform → Mobile and desktop applications** → add the custom redirect
   `http://127.0.0.1:<port>/oauth/callback` → **Configure**. Under **Advanced settings → Allow public
   client flows**, choose **Yes → Save**. Use port `53682` for the CLI one-shot listener instead.
4. If the portal rejects an HTTP `127.0.0.1` URI, **Manifest → Microsoft Graph App Manifest** → add it
   to `publicClient.redirectUris`, retaining other entries, then **Save**. Older manifest views call
   the corresponding field `replyUrlsWithType` and use type `InstalledClient`. Microsoft documents
   this portal limitation in [redirect URI restrictions](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).
5. **API permissions → Add a permission → Microsoft Graph → Delegated permissions** → select
   `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `openid`, `email` and optionally
   `Calendars.ReadWrite` → **Add permissions**. Tenant policy can require an administrator's consent;
   **Grant admin consent** is available to the administrator when appropriate.
6. In Passport, open the connect dialog, choose **Microsoft → Set up manually**, paste the client ID. Leave the secret
   empty for a public desktop client. Passport uses the `common` tenant and PKCE. An existing
   confidential-client registration may supply its own secret; it must permit the chosen redirect
   and client flow.
7. Select calendar access if wanted, click **Connect**, sign in with the intended account, grant
   permissions. The account is usable as soon as it shows **Watching**. Passport reads `/me` and uses `mail`, falling back to
   `userPrincipalName`, for the address. Repeat for other accounts.

The Graph adapter uses immutable message IDs and a folder hierarchy delta plus one message delta per
folder. Primary calendar sync uses `/me/calendarView/delta`; secondary-calendar delta sync remains
unsupported. Shared/delegated mailboxes, sovereign clouds and tenant-specific consent restrictions
need separate live verification; the wizard targets each signed-in user's own mailbox in the global cloud.

### Other IMAP providers

Open the connect dialog and choose **Set up manually → IMAP / SMTP**. Enter the account address, IMAP host, numeric port,
TLS mode, username and app password supplied by your service. Enter an SMTP host for sending.
Typical settings are IMAP `993` / TLS and SMTP `465` / TLS, or IMAP `143` / STARTTLS and SMTP `587`
/ STARTTLS. STARTTLS is required when implicit TLS is disabled; certificate checking stays enabled.
An omitted SMTP username or password reuses the IMAP credentials. Test connection validates IMAP login
and NOOP; SMTP submission is not tested and no message is sent by the test.

If special folders are not advertised, set the optional Drafts, Sent and Trash folder paths to the
exact paths your server uses. **Test connection** is non-persisting; **Add account** saves encrypted
credentials and starts watching for new mail. OAuth-only IMAP services need their own OAuth setup; use Gmail or Graph
above where possible. Microsoft deployments that disable password authentication cannot be connected
by entering an app password here.

## Watching for new mail, account controls and diagnostics

Passport keeps no copy of your mailbox. Connecting an account takes a change cursor at "now" and
fetches the label tree with counts; nothing older is downloaded. Searching, listing and reading go
to the provider on demand (`GET /api/emails` is provider search; `GET /api/emails/<id>` and
`GET /api/threads/<id>` read through a small local cache). A search across all accounts skips
accounts that need sign-in or fail and lists them as `skipped: [{ account, code,
retryAfterSeconds? }]`; it answers `429` only when every account is rate limited. There is no
backfill and no initial sync window: `sync.initialDays` is ignored, Passport logs a one-time
deprecation warning if your `passport.config.json` still has it, and the next settings save drops
it.

The watcher checks each mail account every 30 seconds (`watch.intervalSeconds`,
`PASSPORT_WATCH_INTERVAL_SECONDS`, 5–86400) with one provider change query in the `arrivals`
quota lane. IMAP accounts with IDLE also check immediately when the server signals a change.
Mail that is new since the last check and sits in the Inbox (or, for providers without an inbox
concept, outside Sent, Drafts, Spam and Trash), is not from one of your own addresses and has not
been triaged before becomes a durable arrival and is triaged. Label changes and deletions only
update or drop rows already in the local cache. The label tree and its counts refresh on connect
and at most every 10 minutes; the account's **in Inbox** count comes from that refresh.

Providers keep change history for a limited time (Gmail about a week). If Passport was off longer,
or the provider rejects the cursor, the watcher marks cached labels stale, runs one bounded sweep of
recent Inbox mail (`in:inbox newer_than:2d`, at most 100 messages, deduplicated against arrivals
already handled) and continues from a fresh cursor. Older unseen mail is not triaged; you can still
search and read it.

Every provider read declares its cost and goes through a per-account governor. When a provider rate
limits Passport (HTTP 429/503), the watcher backs off (30 seconds, doubling, at most 15 minutes, or
the provider's retry hint) and shows **Paused**; the account is never marked failed for it. Interactive
reads answer `429` with `Retry-After` instead of waiting. Invalid or revoked grants produce
**Re-authorize** and pause watching until you sign in again.

Calendars keep a bounded sync (`sync:<accountId>`, every `syncIntervalSeconds`). Arrivals wait at
most one minute for a related calendar to finish its first sync; after that, scheduling proposal
reasons include “calendar not synced, availability unverified”. At delayed-outbox release a new
event conflict returns a calendar proposal to Decisions with `AVAILABILITY_CHANGED`, requiring
review. Recurring events use the same supported rule expansion as scheduling; unsupported rules
return to review as `AVAILABILITY_UNVERIFIED`. Calendar cursor-expiry recovery upserts existing
events by provider identity, preserving local links, and removes unseen events only after a
successful full pass.

Settings → Accounts shows "Watching since <time> · last check <ago>" and the Inbox count; the
sidebar shows **Watching**, **Paused** or **Needs sign-in**. **Check now** (`POST
/api/accounts/<id>/sync`) runs the calendar sync and an immediate new-mail check. `GET
/api/accounts` returns `messageCount` (provider Inbox total) and `watch: { since, lastTickAt,
cursorAgeSeconds, status }`. Re-authorize the same address to keep local IDs and history. Removing
calendar permission pauses an existing companion calendar. Removing a mail account removes its
cached messages, watcher state, encrypted credentials and linked calendar; provider mail is
untouched. The audit log, people and matters remain.

The cache is bounded: the weekly `store.maintenance` job drops bodies older than 7 days (then least
recently used beyond 200 MB) and envelopes beyond the 100,000 most recently used. Drafts and mail
linked to a matter are kept; evicted mail is fetched again on the next read.

Use **Connection health → Run checks**, `GET /api/doctor`, or `passport doctor`. Checks cover private
storage/key permissions, config, a one-token model request when configured, token refresh, Gmail
profile / Graph `/me` / IMAP NOOP (or one cheap label read), watcher health (last check and cursor
age), calendar sync age, outbox hold and the built MCP stdio command. The model
check can incur the provider's minimum request charge. Missing model credentials are a warning and
do not prevent watching. CLI doctor exits nonzero for failed checks. Run after `pnpm build` so the
stdio entry point exists.

Use the **All accounts** filter on Decisions, Matters and Activity. It uses `accountId` in the URL;
account colour dots identify the source even in the combined view.

## Adapter audit and live verification checklist

Automated tests use hand-authored fixtures and fake endpoints. **No live Gmail, Graph or IMAP account
calls were made during this implementation.** Confirm these behaviors with your own registrations:

- Google Desktop + PKCE, optional secret, multiple signed-in Google accounts, mail-only consent and
  declined calendar consent. Check refresh after access-token expiry and seven-day Testing behavior.
- Google event-only consent can read primary-calendar metadata through the event feed; listing all
  calendars and free/busy require additional scopes and are not part of the default browser grant.
- Gmail history pagination, 404 expired history recovery, label changes, draft replacement, MIME send
  and real attachment encodings. Existing Gmail draft/message APIs already matched the documented API.
- Microsoft personal and organizational accounts through `common`, exact native redirect registration,
  admin consent, `/me` identity fallback, refresh-token rotation shared with the calendar, and revoke →
  Re-authorize → reconnect without duplicating the account.
- Graph folder delta hierarchy (including nested/hidden folders), message move tombstones, immutable
  IDs before and after sending a draft, throttling, 410 reset, and recurrence instances in primary
  calendar delta. Message metadata pagination continues past the history window to preserve delta.
- IMAP servers with large mailboxes, SEARCH SINCE day granularity, UIDVALIDITY resets, CONDSTORE,
  IDLE/reconnect, and SPECIAL-USE discovery. Test SMTP separately with an approved held send.
- Restart with every account configured; check that the watcher resumes from its saved cursor
  without re-triaging old mail, that `mail_search` and `mail_read` agree with the provider's own UI,
  and that multi-account filtering is complete.

Provider changes in this track: public-client Google PKCE with optional secret; removal of Google's
unsupported installed-app incremental-consent parameter; per-attempt scopes for both providers;
refresh-denial classification; Google event-feed calendar metadata; Graph folder hierarchy delta and
date-window body fetching while preserving next/delta links; IMAP date-window UID fetching; and small
read-only provider health probes. Provider mutations remain behind the existing action executor.

API references: [Gmail history](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list),
[Graph mail delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0),
[Graph folder delta](https://learn.microsoft.com/en-us/graph/api/mailfolder-delta?view=graph-rest-1.0),
[Google Calendar event feeds](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
