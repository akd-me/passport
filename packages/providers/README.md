# @passport/providers

Bring-your-own-provider implementations of the frozen `@passport/types` contracts. Gmail,
Microsoft Graph, IMAP/SMTP and JMAP normalize mail into `Email`/`Mailbox`; Google Calendar,
Graph Calendar and CalDAV normalize calendars. Deterministic in-memory providers support offline
development. There are no live-service tests, built-in OAuth clients, native modules, or credential logs.

## Use it in 20 lines

```ts
import { createProviderRegistry, MockMailProvider } from "@passport/providers";
import type { Account } from "@passport/types";

const registry = createProviderRegistry({
  onCredentials: (accountId, credentials) => store.accounts.setCredentials(accountId, credentials),
  resolveEmail: id => store.emails.get(id, { includeBodies: true }),
});
const setup = registry.describe("gmail"); // fields, scopes, URL builder, code exchange
const provider = registry.mail(account.kind as "gmail"); // a fresh instance per call
await provider.connect(account as Account, credentials);
for await (const delta of provider.sync(previousCursor)) {
  // Ingest mailbox/email/thread deltas before persisting the final cursor.
  await ingest(delta);
}
// The composition root's ActionExecutor owns permission, logging, undo and delayed sends.
// Do not expose provider mutations directly to agents or bypass that executor.
await provider.disconnect();
const testMail = new MockMailProvider(); // helpers: injectEmail, injectBlob, sentMail
await testMail.connect(mockAccount, {});
const arrival = testMail.waitForChanges(abortController.signal);
testMail.injectEmail({ subject: "New arrival", textBody: "Hello Alex" });
await arrival;
```

The snippet's `store`, account/credentials, `ingest`, cursor and signal are supplied by the composition
root. Only import this package's public root. Factory calls are independent; retain the connected
instance per account instead of calling the factory for every operation. Call `disconnect()` to close
IMAP/SMTP resources and clear HTTP credentials.

## Credentials and setup fields

`describe(kind).fields` is the UI/CLI schema. `secret: true` values belong in encrypted
`AccountCredentials`; other fields belong in `Account.settings`. UI code must convert IMAP port
fields to numbers and TLS fields to booleans (the string `"false"` is not a boolean).
`Account.emailAddress` is always the owner/submission identity. Account capabilities are exposed on
each mail adapter; calendar-only capabilities should be set by the composition root.

### Google: Gmail and Calendar

1. Create your own project in Google Cloud, enable Gmail API and/or Google Calendar API, and configure
   the OAuth consent screen. Add your Google account as a test user when the app is in testing mode.
2. Create an OAuth **Web application** client and register the exact callback URI used by your server,
   including its localhost port/path. Retain your client ID in `settings.clientId` and client secret in
   `credentials.clientSecret`. No Passport-owned OAuth client is used.
3. Call `descriptor.oauth.buildAuthUrl({ clientId, codeVerifier? }, redirectUri, randomState)` and send
   the user to that URL. Keep a cryptographically random state in the login session and check it on
   callback before exchanging the code. The descriptor does not own callback/session handling.
4. Pass a temporary merge of settings and secrets to
   `exchangeCode({ clientId, clientSecret, codeVerifier? }, redirectUri, code)`. Persist its returned
   credentials encrypted, then discard the temporary merge and PKCE verifier. Never persist the
   client secret in account settings. Google requests offline access and consent for refresh tokens.

Gmail scopes: `https://www.googleapis.com/auth/gmail.modify` (read, labels, drafts and send).
Calendar scopes: `https://www.googleapis.com/auth/calendar.events`,
`https://www.googleapis.com/auth/calendar.calendarlist.readonly`, and
`https://www.googleapis.com/auth/calendar.freebusy`.

Google Calendar settings: optional `calendarId` (default `primary`) and `timeZone` (IANA name).
Each account syncs one configured calendar; `listCalendars()` provides the available choices.
Date-only events use the calendar timezone; when needed it is fetched from calendar metadata.

See [Google's OAuth setup and authorization-code guide](https://developers.google.com/identity/protocols/oauth2/web-server),
[Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync), and
[Calendar incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync).

### Microsoft: Graph mail and Calendar

1. Create your own app registration in Microsoft Entra. Choose the account types you need (including
   personal Microsoft accounts when applicable) and register the server's exact callback URI.
2. Add delegated Graph permissions, then create your own client secret for a confidential server app.
   Save `clientId` and optional `tenantId` in settings, and `clientSecret` in encrypted credentials.
   `tenantId` defaults to `common`; a directory ID restricts sign-in to that tenant.
3. Use the descriptor's URL builder/code exchange as above. A public client must supply a PKCE
   `codeVerifier`; the URL builder derives an S256 challenge. Confidential clients can also use PKCE.
   Keep the verifier only for that login attempt and validate OAuth state in your callback.

Mail scopes: `offline_access`, `https://graph.microsoft.com/Mail.ReadWrite`,
`https://graph.microsoft.com/Mail.Send`. Calendar scopes: `offline_access`,
`https://graph.microsoft.com/Calendars.ReadWrite`.
Both Google and Microsoft adapters accept `access_token`, `refresh_token`, and `expires_at`
(epoch **milliseconds as a string**) in credentials, refresh proactively and once after a 401,
and call `onCredentials(accountId, updatedCredentials)` after rotation. Supply that callback to
persist rotations. Credentials are copied rather than mutating the caller's object.

Graph mail requests immutable IDs, traverses nested folders, and retains one delta link plus known
message IDs per folder. Moves retain a stable identity; a tombstone is checked globally before a
message is deleted locally. `send()` creates/uses a draft and submits `/messages/{id}/send`, giving
the caller an actual message identity; it deliberately uses that endpoint instead of `sendMail`,
whose 202 response has no message ID. A successful submit is server acceptance, not delivery proof.

Graph Calendar v1.0 delta sync supports the **primary** calendar: leave `calendarId` unset (the internal
alias is `default`). A non-default ID throws `NotImplementedError` on sync. Supply an explicit range;
without one, the first sync chooses 30 days back through 365 days forward. The range is saved in the
cursor; expanding/changing it requires a fresh sync and replacement of the old local view. Graph
calendar views materialize occurrences. RRULE writes are unsupported and throw. `getSchedule` support
and tenant permissions vary; service errors are surfaced instead of returning empty availability.

See [Microsoft's authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[mail delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0),
[calendar-view delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0), and
[getSchedule](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule?view=graph-rest-1.0).

### IMAP / SMTP

Settings: required `host`; optional `port` (993), `tls` (true), `username` (owner address),
`smtpHost` (required for sending), `smtpPort` (465), `smtpTls` (true), and `smtpUsername`.
For STARTTLS use IMAP port 143 with `tls: false`, or SMTP port 587 with `smtpTls: false`.
STARTTLS is required in those modes; certificate validation remains enabled. `draftsFolder`,
`sentFolder`, and `trashFolder` override SPECIAL-USE discovery when a server does not advertise roles.

Credentials: `password`, optional `smtpPassword` (otherwise uses the IMAP password). Create an app
password in your mail service's security settings when it requires one, usually after enabling
two-step verification; regular account passwords frequently do not work. Your organization may disable
app passwords/basic authentication. OAuth-based IMAP/SMTP can use `access_token` and optional
`smtpAccessToken`; obtain/refresh those through your own mail service configuration. This adapter does
not run an IMAP OAuth consent or refresh flow. Never disable TLS verification to solve login failures.

UIDVALIDITY/UIDNEXT/MODSEQ and known UID lists are stored in the opaque cursor. CONDSTORE fetches changed
messages; servers without MODSEQ are scanned. UID enumeration detects expunges. Message IDs encode the
folder, UIDVALIDITY and UID: a copy/move or UIDVALIDITY reset changes identity and is reconciled by sync.
Draft writes append MIME to Drafts and require APPENDUID/UIDPLUS to identify the result. An append whose
ID cannot be obtained throws `IMAP_UIDPLUS_REQUIRED`; resync Drafts before retrying. Updating a draft
appends a replacement and removes the old draft; callers must use the returned provider ID.

SMTP uses an explicit envelope (including Bcc) and removes Bcc from transmitted headers. On acceptance
it appends a private sent copy and deletes a submitted draft. If that cleanup fails,
`SubmissionAcceptedError` has code `SUBMISSION_ACCEPTED` and `messageId`: **do not retry submission**;
resync and repair the sent copy/draft instead. SMTP errors before acceptance use `SMTP_SEND_FAILED`.
`waitForChanges(signal)` monitors the Inbox through ImapFlow's automatic IDLE and cleans up listeners
when aborted/disconnected; periodic sync is still needed for other folders. Library logging is disabled.

See [ImapFlow's fetching guide](https://imapflow.com/docs/guides/fetching-messages/).

### JMAP mail

Settings: `sessionUrl`, the final authenticated HTTPS session discovery URL (typically
`https://mail.example/.well-known/jmap`); alternatively `host` constructs that URL. Optional
`jmapAccountId` selects a session account; otherwise the primary mail account is used. Credentials:
`token` or `access_token` (bearer); a server supporting Basic authentication may use `password` plus
`settings.username`. The setup descriptor offers bearer authentication. HTTP redirects are rejected;
use the final session URL if your service redirects discovery. API/download endpoints come from the
authenticated session and must use HTTPS.

Email/query + Email/get establish full sync, Email/changes advances state, and Email/set handles flags,
mailboxes and drafts. Submission needs the server's submission capability and an Identity matching the
account owner. Draft content is immutable in JMAP, so updates create a replacement and delete the old
draft. Deletes move to a trash-role mailbox and fail if none exists; they never silently destroy mail.
Attachment handles remain native JMAP blob IDs. A JMAP calendar adapter is **not implemented**;
`registry.calendar("jmap-calendar")` throws `NotImplementedError`.

See [JMAP Mail RFC 8621](https://jmap.io/spec/rfc8621/).

### CalDAV

Settings: required `calendarUrl`, the exact HTTPS **calendar collection** URL (not a principal or
calendar-home URL); optional `username` (owner address) and `timeZone` (IANA name for floating events,
default UTC). Credentials: `password` (usually an app password), or bearer `token`/`access_token`.
One collection is configured per account; principal/home discovery is not implemented.

Full sync uses calendar-query REPORT; incremental sync uses sync-collection and a sync-token. Without
sync-token support, repeated calendar-query/ETag scans detect modifications and removals. Cursors retain
resource ETags and VEVENT IDs. Stored recurrence masters/overrides are preserved individually; infinite
series are not expanded. Creates use conditional PUT (`If-None-Match: *`); updates/deletes use the
server ETag (`If-Match`) and preserve unrelated properties/overrides. Conflicts surface as `HTTP_412`.
Deleting a recurrence override alone or deleting a UID from a multi-UID resource throws explicitly.

RSVP changes the attendee's PARTSTAT via PUT. Sending an iTIP REPLY relies on the server's scheduling
support; Passport does not submit a separate scheduling message. Free/busy first tries free-busy-query
REPORT, then materialized non-recurring event bounds for unsupported REPORTs. The fallback throws for
recurrences instead of reporting incorrect free time. Busy periods may overlap and are not coalesced.
The XML reader handles namespaces, entities and CDATA, rejecting DTDs and external entity declarations.

See [CalDAV RFC 4791](https://www.rfc-editor.org/rfc/rfc4791) and
[WebDAV collection sync RFC 6578](https://www.rfc-editor.org/rfc/rfc6578).

### Mock mail and calendar

No configuration or credentials are needed. Forty deterministic mail fixtures include newsletters
with List-Unsubscribe/one-click headers, receipts, Sam's replies, two cold introductions, recruiters,
build notifications, a scheduling exchange, three calendar attachments, and explicit DKIM pass/fail
messages. Categories are represented by message content; the agent remains responsible for classification.
There are six deterministic calendar fixtures. Mail/calendar changes have revision cursors.

`MockMailProvider({ fixtures: false, now?, verifier? })` starts an empty inbox. `injectEmail(partialEmail)`
adds a message, `injectBlob(bytes, contentType)` adds attachment bytes, `sentMail` records submissions,
and `waitForChanges(signal)` wakes on changes or cancellation. Returned mail, sent records and bytes are
defensive copies. Mock helpers are for tests/development and do not apply policy themselves.

## Normalization, verification, and integration limits

- Every successful sync yields a final `{ kind: "cursor" }`, including empty syncs. Persist that cursor
  only after all preceding deltas are durably ingested. A thrown/interrupted sync has no commit cursor;
  retry from the previous one. `maxEmails` is a pagination-size hint, **not a total cap** that drops mail.
  IMAP ignores that hint. Gmail's optional `since` narrows the initial snapshot only. Google Calendar,
  CalDAV and mock calendar sync complete collections; their display ranges should be filtered by the store.
- `CURSOR_EXPIRED` requires clearing/reconciling that account's local snapshot and a full sync. Do not
  retain deleted records from the old snapshot. Cursors and blob handles are opaque and account/provider
  specific; do not edit them or reuse them between accounts. IMAP/Graph/CalDAV cursors grow with tracked
  identifiers so deletions can be reconciled after process restart.
- Adapter IDs are stable account-scoped strings. If the store generates its own ULIDs, remap every
  mailbox/email/thread/calendar reference consistently; retain native `providerId` for provider calls.
  Supply `resolveEmail` to resolve `DraftInput.inReplyToEmailId` from store IDs. Otherwise reply IDs must
  be the account-scoped IDs returned by the adapter. Draft replacements may return a new provider ID.
- Mutations take **provider IDs**, not store IDs. Graph/IMAP addToMailbox copies a message; Graph
  removeFromMailbox throws because a message requires a destination folder. IMAP removal moves to Trash.
  Gmail supports `$seen`, `$flagged`, `$junk`, `$notjunk`, and `label:<label ID or name>`; Graph supports
  `$seen`, `$flagged`, and `label:<category>`. Unsupported keywords throw. Draft state uses draft APIs.
  General delete moves to Trash for every mail adapter; draft deletion removes that draft.
- Draft attachment blob IDs must already be resolvable by that same adapter. Uploading new external
  blobs is outside the frozen provider interface. MIME attachments, HTML-to-text fallback, previews,
  address normalization, UTC conversion, List-Unsubscribe methods, and raw receiver headers are exposed.
  HTML-to-text is a text fallback, not an HTML sanitizer. Graph mail size is an estimate from exposed bodies
  and attachment metadata. Gmail send returns `messageId: null` because the submit response lacks that
  RFC Message-ID; the returned provider ID can be fetched later.
- `parseAuthenticationResults(headers)` reports DKIM/SPF/DMARC from Authentication-Results, with
  per-method ARC-Authentication-Results fallback. Duplicate explicit failures win conservatively.
  It does **not** perform DNS/DKIM verification or validate the ARC chain; trust these headers only across
  your receiving service's trusted boundary. `StubPassportVerifier` reads X-Passport-Signature and always
  returns `passport: "green"`. Inject `PassportVerifier` through registry/adapter options to wire real
  identity verification later. Message content never grants blue status.
- Gmail, Graph and JMAP push subscriptions/EventSource are not implemented (`push: false`); use periodic
  incremental sync. Contacts are unsupported (`contacts: false`). OAuth revocation, callback HTTP handlers,
  background scheduling, outbox holds, authorization policy and credential encryption belong to their
  respective packages. HTTP failures have stable codes and include neither remote bodies nor secrets.

Runtime dependencies: `imapflow`, `nodemailer`, `mailparser`, `ical.js`; `@types/mailparser` is a dev
dependency. Gmail/Graph/JMAP/CalDAV and OAuth use the injected/global `fetch` directly. Options also expose
`imapFactory`/`smtpFactory`, `now`, `onCredentials`, `resolveEmail`, and `verifier` for composition/testing.

## Validation

```sh
pnpm install
pnpm --filter @passport/types build
pnpm --filter @passport/providers typecheck
pnpm --filter @passport/providers test
pnpm --filter @passport/providers build
```

Tests use hand-authored, recorded-style MIME/JSON/iCalendar fixtures and fake HTTP/IMAP/SMTP transports.
The Vitest setup forbids global fetch. No credentials or live service access are required. The frozen
`@passport/types` package is unchanged.
