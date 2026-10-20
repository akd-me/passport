# Connect your accounts

Passport uses your own OAuth registrations and models. Account passwords, client secrets and tokens
go through the encrypted credential store. OAuth verifiers and browser login states stay in memory;
authorization attempts expire after ten minutes. Use the local server on the same computer as your browser.

## Start a workspace

From a built checkout, run `passport init` (during development:
`pnpm --filter @passport/server exec tsx src/cli.ts init`). Choose a model provider and model, or `none`.
Cloud API keys are entered without terminal echo; explicitly entered keys are saved in the private
config file. You can instead set `PASSPORT_LLM_API_KEY` in the environment. `none` leaves mail usable
without an agent. The wizard creates the data directory, `master.key` and `passport.config.json`.
Keep the master key with any encrypted database backup. For unattended setup use
`passport init --llm none --skip-account`, or pipe `none\nskip\n` to `passport init`.

The CLI can connect a first mailbox with a one-shot callback listener on
`http://127.0.0.1:53682/oauth/callback`. It prints the URL and waits up to ten minutes. For a different
listener port set `PASSPORT_OAUTH_REDIRECT_URI`; register that exact callback for Microsoft.

Run `passport serve`, then open `http://127.0.0.1:3000/accounts`. An empty workspace opens the account
wizard at `/` too. `PASSPORT_PORT` changes the HTTP port. All browser instructions below use
`http://127.0.0.1:<port>/oauth/callback`; substitute the running server's port. Keep the original tab
open: it shows authorization progress and receives sync updates over WebSocket. The consent tab
returns to Accounts after connecting. Repeat for every personal, work and secondary mailbox.

## Gmail with your own desktop OAuth client

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
7. In Passport **Accounts → Add account → Gmail**, enter the client ID and optionally the client
   secret. Leave **Connect calendar too** checked for your primary calendar, or clear it for mail only.
   Click **Connect**. If the browser blocked the tab, use **Open authorization tab**.
8. Select the intended Google account and grant the requested mail permissions. Calendar consent
   is optional; Passport creates the calendar account only when that scope was granted. Return to
   Passport and wait for the initial sync. The account address comes from Google's userinfo endpoint.

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

### Gmail through IMAP and an app password

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
4. Click **Test connection**, then **Add account**. This path syncs mail; it does not connect a calendar.
   Do not enter your normal Google password. A Workspace administrator must allow IMAP access.

## Outlook.com and Microsoft 365

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
6. In Passport **Accounts → Add account → Microsoft Outlook**, paste the client ID. Leave the secret
   empty for a public desktop client. Passport uses the `common` tenant and PKCE. An existing
   confidential-client registration may supply its own secret; it must permit the chosen redirect
   and client flow.
7. Select calendar access if wanted, click **Connect**, sign in with the intended account, grant
   permissions, then wait for sync. Passport reads `/me` and uses `mail`, falling back to
   `userPrincipalName`, for the address. Repeat for other accounts.

The Graph adapter uses immutable message IDs and a folder hierarchy delta plus one message delta per
folder. Primary calendar sync uses `/me/calendarView/delta`; secondary-calendar delta sync remains
unsupported. Shared/delegated mailboxes, sovereign clouds and tenant-specific consent restrictions
need separate live verification; the wizard targets each signed-in user's own mailbox in the global cloud.

## Other IMAP providers

Choose **Accounts → Add account → IMAP / SMTP**. Enter the account address, IMAP host, numeric port,
TLS mode, username and app password supplied by your service. Enter an SMTP host for sending.
Typical settings are IMAP `993` / TLS and SMTP `465` / TLS, or IMAP `143` / STARTTLS and SMTP `587`
/ STARTTLS. STARTTLS is required when implicit TLS is disabled; certificate checking stays enabled.
An omitted SMTP username or password reuses the IMAP credentials. Test connection validates IMAP login
and NOOP; SMTP submission is not tested and no message is sent by the test.

If special folders are not advertised, set the optional Drafts, Sent and Trash folder paths to the
exact paths your server uses. **Test connection** is non-persisting; **Add account** saves encrypted
credentials and starts sync. OAuth-only IMAP services need their own OAuth setup; use Gmail or Graph
above where possible. Microsoft deployments that disable password authentication cannot be connected
by entering an app password here.

## Sync history, account controls and diagnostics

The default initial mail window is 30 days. Change it in `passport.config.json` before starting a
fresh account:

```json
{ "sync": { "initialDays": 30 } }
```

Incremental cursors are retained across restarts. Calendar cursor-expiry recovery upserts existing
events by provider identity, preserving local links, and removes unseen events only after a successful
full pass. Interrupted replacement retains existing events and retries from a null cursor. Sent mail,
drafts and self mail outside Inbox are ingested for history without triggering arrival triage.

Arrivals wait for related calendars to complete a full sync (30-second retries, up to ten minutes).
After that deadline, scheduling proposal reasons include “calendar not synced, availability unverified”.
Combined mail/calendar accounts keep a calendar-only sync checkpoint before emitting mail arrivals.
At delayed-outbox release a new event conflict returns a calendar proposal to Decisions with
`AVAILABILITY_CHANGED`, requiring review. Recurring events use the same supported rule expansion as scheduling; unsupported rules
return to review as `AVAILABILITY_UNVERIFIED`.

Incremental cursors are retained across restarts. Use **Load older mail → Days of history → Backfill**
or `POST /api/accounts/<id>/backfill?days=365` to widen a mail snapshot. Existing local messages stay
in place. Gmail uses `after:<epoch>`; Graph drains paged delta metadata but fetches bodies only inside
the window; IMAP searches by date and fetches matching UIDs. Graph must finish metadata pagination to
obtain a durable deltaLink even when a page crosses the date boundary. Provider folder totals can
therefore exceed the count of messages cached locally. Calendar windows follow each calendar adapter's
own rules (Graph: 30 days back / 365 forward; Google: complete primary event collection).

HTTP 429 and 503 trigger exponential delay with jitter and at most five retries. Exhausted retries
produce a visible sync error; later scheduled sync can retry. Invalid/revoked refresh grants produce
**Re-authorize** and pause automatic attempts. Re-authorize the same address to retain local IDs and
history. Removing calendar permission pauses an existing companion calendar. Removing a mail account
removes its local messages, encrypted credentials and linked calendar; provider mail is untouched.
The audit log, people and matters remain.

Use **Connection health → Run checks**, `GET /api/doctor`, or `passport doctor`. Checks cover private
storage/key permissions, config, a one-token model request when configured, token refresh, Gmail
profile / Graph `/me` / IMAP NOOP, sync age, outbox hold and the built MCP stdio command. The model
check can incur the provider's minimum request charge. Missing model credentials are a warning and
do not prevent mail sync. CLI doctor exits nonzero for failed checks. Run after `pnpm build` so the
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
- Restart with every account configured; compare recent message counts with the provider, widen
  history, and check duplicate-free ingestion and complete multi-account filtering.

Provider changes in this track: public-client Google PKCE with optional secret; removal of Google's
unsupported installed-app incremental-consent parameter; per-attempt scopes for both providers;
refresh-denial classification; Google event-feed calendar metadata; Graph folder hierarchy delta and
date-window body fetching while preserving next/delta links; IMAP date-window UID fetching; and small
read-only provider health probes. Provider mutations remain behind the existing action executor.

API references: [Gmail history](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list),
[Graph mail delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0),
[Graph folder delta](https://learn.microsoft.com/en-us/graph/api/mailfolder-delta?view=graph-rest-1.0),
[Google Calendar event feeds](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).
