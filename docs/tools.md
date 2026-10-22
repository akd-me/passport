# Passport tools

`@passport/tools` owns the tool definitions, JSON Schemas, validation, inference
and handlers consumed by both the built-in agent and the MCP server. Clients see
the same mailbox, calendar, people and matters and the same tool inputs.

Since v0.3, mail is read **on demand**: the `mail_*` tools call the provider's own
index through `MailReader` (`docs/design/on-demand.md`, research 03 §2). Nothing is
mirrored. When the host injects no readers (the demo, tests, accounts whose provider
has no `reader()`), the legacy mail tools keep reading the local Store and the new
tools return `ON_DEMAND_UNSUPPORTED`. Availability can prefer a host-injected connected
calendar provider. No tool reads account credentials or provider settings.

## Catalogue

Columns: **Class** is `R` (read), `RW` (reversible write, the executor stores an
inverse), `IW` (irreversible, held or asked as policy says). **Cost** is per call, in
Gmail units / Graph requests / IMAP commands; "+20/row" means 20 Gmail units per row
returned. Every on-demand result reports what it actually spent in `cost`.

### On-demand mail reads (v0.3)

| Tool | Class | Cost (Gmail / Graph / IMAP) | Purpose |
| --- | --- | --- | --- |
| `mail_accounts` | R | 0 (local) | Accounts, capabilities and whether on-demand reads are available |
| `mail_labels` | R | 1 (+1/label with `counts`) / 1–3 / 1+N | `ls /`: label and folder tree with roles and optional counts |
| `mail_list` | R | 5 +20/row / 1 / 2 | `ls <label>`: newest-first rows with structural filters only |
| `mail_search` | R | 5 +20/row / 1 / 2 (per account) | `grep`: portable `query` or native `rawQuery`; `account:"all"` fans out and merges by date |
| `mail_count` | R | 5 per 500 ids; facets +20/row / 1–2 / 1–2 | `wc`/`uniq -c`: exact count to `cap`, top-10 facets over a sample |
| `mail_read` | R | 120 thread, 80 message / 1–2 / 2–6 | `Read`: thread or message as clean text, quotes collapsed, windows |
| `mail_attachment_read` | R | 20 / 1–2 / 1 | Read one attachment as text (PDF, Office, sheets, invites, emails) or as an image |
| `mail_grep` | R | ≤60/message / 1–2 / 1–2 | `grep -C`: regex over a bounded set's bodies, with context lines |
| `mail_changes` | R | 2 +20/added / 1 per folder / 1–2 | `git status`: arrivals, label changes and deletions since a cursor |
| `people_history` | R | as `mail_search` | Mail with, from or to an address or a known person |
| `provider_get` | R | per method | Read-only, allowlisted raw GET (needs `MailReader.rawGet`) |
| `mail_export` | R (writes local files) | ~120/thread (+20/attachment) | MCP only, with `scratchDir`: threads as `.md` / `.eml` (and attachments) for the host's shell |
| `watch_conversation` | task state | 0 | Wake the calling [task](tasks.md) when someone else replies on a conversation, a bounce or auto-reply arrives, or after 14 days |
| `unwatch_conversation` | task state | 0 | Stop watching one conversation (or all) and hand the task back |

Input shapes (all limits are enforced):

- `mail_labels({account?: id|"all", counts?=false})`
- `mail_list({account?, container?, filter?: {from?, fromDomain?, unread?, flagged?, hasAttachment?, after?, before?, largerThan?}, limit≤100=25, pageToken?})`
- `mail_search({account?: id|"all", query? | rawQuery?, container?, limit≤100=25, pageToken?, includeSpamTrash?=false, threads?=false})`
- `mail_count({account?, query? | rawQuery?, cap≤10000=2000, facets?: ("from"|"fromDomain"|"label"|"month")[], sample≤500=200, confirmCost?=false})`
- `mail_read({id, view?: "thread"|"message"="thread", format?: "text"|"html"|"headers"="text", quoted?: "collapse"|"full"="collapse", offset?=0, length≤60000=16000, messagesFrom?})`
- `mail_attachment_read({id, attachment: {attachmentId? | index? | name?}, pages?: "1-5", rows?: "1-500", sheet?, maxChars≤100000=20000, offset?=0, asImage?=false})`
- `mail_grep({ids?≤100 | query? | rawQuery?, account?, maxMessages≤100=30, pattern, flags?: ""|"i"|"m"|"im"="i", context 0–5=1, maxMatches≤200=50, confirmCost?=false})`
- `mail_changes({account?, cursor?, limit≤200=50, kinds?: ("added"|"labelChanged"|"deleted")[]})`
- `people_history({email | personId, account?: id|"all", direction?: "both"|"from"|"to"="both", limit≤100=25, pageToken?})`
- `provider_get({account?, path, query?: Record<string,string>})`
- `mail_export({ids? | query?, account?, max≤200=50, format?: "md"|"eml"="md", includeAttachments?=false})` → `{dir, fileCount, files[], attachmentsDir?, attachments?, skippedAttachments?}`
- `watch_conversation({threadHandle, account?})` → `{watching, threadHandle, since}`; needs a task run (`ToolContext.taskId`), else `TASK_REQUIRED`. `threadHandle` must be a thread handle (a row's `threadId`), else `INVALID_INPUT`; a settled or archived task answers `TASK_SETTLED`
- `unwatch_conversation({threadHandle?})` → `{watching: threadHandle[]}`
- Both are write tools: in plan mode they return `{ status: "planned" }` and change nothing

`account` may be omitted when exactly one account is connected; `mail_search`,
`mail_labels` and `people_history` then fan out to every account with a reader.

The portable query language: `from:` `to:` `cc:` `bcc:` `with:` (any participant)
`subject:` `has:attachment` `filename:` `after:`/`before:` (`YYYY-MM-DD` or epoch
seconds) `newer_than:`/`older_than:` (`7d`, `2m`, `1y`) `in:` `label:`
`is:unread|read|starred` `larger:`/`smaller:` `list:` `rfc822msgid:`, bare words,
`"phrases"`, `OR`, `-` negation and parentheses. Anything else fails with
`INVALID_QUERY`; pass provider syntax through `rawQuery` instead.

### People and matters as notes (v0.3)

People and matters are notes the agent maintains, like memory files, next to a small
structured table the policy reads (`docs/design/on-demand.md` §2 principle 5, research 03
§4.3). On a `Person`, `relationship`, `verification`, `verifiedSelf`, `lastSeenBlueAt`,
`downgradeAcknowledgedAt` and `stats` are **security state**: they are never free text and
`notes_write` never changes them (`PERSON_SECURITY_FIELDS`). Knowledge lives in
`Person.notes`, `Matter.notes` (markdown), `Matter.refs` (provider references
`{account, providerId, rfc822Id?, threadPid?, date, subject}` that survive cache eviction;
the source of truth for a matter's conversations, while `emailIds` stays for v0.2 rows) and
`Matter.watch` (a saved portable query the triage agent checks on arrival).

| Tool | Class | Cost | Purpose |
| --- | --- | --- | --- |
| `notes_read` | R | 0 (local) | A person or matter as a frontmatter-like header of structured fields plus the notes body |
| `notes_search` | R | 0 (local) | Substring (or `regex: true`) search over names, addresses, summaries and notes; returns matching-line snippets |
| `notes_write` | RW | 0 | `mode: "append"` adds one dated line (`- 2026-10-20: …`); `"replace"` rewrites the body |
| `people_lookup` | R | ~3 reads per account (Gmail: 5 + 5 + 25) | Security state, notes, cached stats and fresh evidence: messages from them (`countIds`, cap 3), whether we ever sent to them (`countIds`, cap 1), the newest exchange |

- `notes_read({kind: "person"|"matter", id? | email? (person) | matterId? (matter)})` →
  `{kind, id, fields, notes, markdown, source: "cache", untrusted}`
- `notes_search({pattern≤500, regex?=false, kind?, limit≤100=25})` → `{items: NotesSearchHit[]}`
  (with `regex: true`: at most 200 characters, no backreferences or nested quantifiers)
  (`{kind, id, name, field: "name"|"email"|"summary"|"notes", snippet, updatedAt}`)
- `notes_write({kind, id, notes≤64000, mode?="append", accountId?, reason})` → write result
- `people_lookup({query: address | name, account?: id|"all"})` →
  `{person, notes, candidates?, evidence: {received, receivedCapped, sentEver, newest, perAccount} | null, source, cost}`

Writes are `person_update` / `matter_update` actions in category `matters` (low risk,
reversible). A patch that touches only knowledge fields is inverted to the **prior** content
of those fields (the `profile_update` pattern), so undo restores the notes without rolling
back security state or matter status written since. `create_matter` and `update_matter`
accept `notes`, `refs` and `watch`; `attach_to_matter` stores a ref per email from its cached
envelope (and still fills `emailIds`). `get_matter` returns the notes and resolves `refs`
lazily to rows through the read-through envelope cache (no bodies; unresolvable refs keep
their stored subject and date with `row: null`). Subjects, names and notes are neutralized
and framed as untrusted: notes are agent-written but may quote mail.

The built-in triage agent appends one dated line per arrival to the matter's notes
(`- 2026-10-20: other “Lease renewal” from Dana (acc:email:…): …`, tagged `[watch]` when the
matter's watch matched) and, for non-routine mail, to the sender's notes. It checks the
`watch` queries of at most five open matters per arrival (those involving the message's
people first) with one `(<watch>) rfc822msgid:<id>` search each in the arrivals lane; matches
are offered to the model first. The MCP resources `passport://people/{id}` and
`passport://matters/{id}` include the notes (and a matter's watch and newest refs). Each
resource opens with an untrusted-data line; names, addresses, subjects, previews, titles and
summaries are neutralised, and the notes come last as a neutralised `> ` block quote so they
cannot forge a section such as `## References`.

### Other reads

| Tool | Class | Purpose |
| --- | --- | --- |
| `list_matters` | R | Workspaces filtered by status, person or text |
| `get_matter` | R | Matter with notes, refs resolved to rows, attached/linked mail, events and people |
| `list_people` | R | Deprecated (use `notes_search({kind:"person"})` or `people_lookup`): contacts by relationship or text, including notes |
| `get_person` | R | One contact and relationship context |
| `search_people` | R | Name/address search with relationship filter |
| `list_events` | R | Events overlapping a UTC range |
| `free_busy` | R | Clipped, merged busy intervals, excluding cancelled/declined events |
| `find_free_slots` | R | Duration-sized slots within a window, working hours and IANA time zone |
| `list_pending_decisions` | R | Proposed actions and delayed outbox holds |
| `list_actions` | R | Compact, filtered action audit log |
| `get_trust` | R | Category trust and global/external limits |
| `get_user_profile` | R | USER.md Markdown |
| `get_standing_rules` | R | Bullet rules from USER.md's Standing rules section |
| `get_daily_log` | R | Actions proposed/executed on a UTC date, grouped by current status |
| `explain_decision` | R | Historical policy reason, current category trust and relevant constraints |
| `preview_unsubscribe` | R | Supported method, transport and destination host/address; no request or send |

### Deprecated aliases

These names stay for existing clients. With readers configured they forward to the
new tools and return the new shapes plus a `deprecated` note; without readers (or for
store-only filters) they read the local Store as before.

| Old name | Alias of | Notes |
| --- | --- | --- |
| `search_emails` | `mail_search` | `text`, `keywords` (`$seen`, `$flagged`), `after`/`before`, `mailboxId`, `accountId`, `limit`, `cursor` translate; `threadId`, `matterId`, `personId`, `category`, `includeDeleted` or ascending sort keep the store path |
| `get_email` | `mail_read({view:"message"})` | 2,000 characters unless `full: true` (then quotes are kept) |
| `get_email_body` | `mail_read({view:"message", offset, length})` | Quotes kept; `length` capped at 60,000 |
| `get_thread` | `mail_read` | |
| `list_mailboxes` | `mail_labels({counts:true})` | |
| `list_recent_from_person` | `people_history({direction:"from"})` | |
| `summarize_thread` | `mail_read` thread data | Same LLM-free summary over the provider thread |

### Writes

Mail inference uses stored classifications and sender relationships: legal and
money classifications win; List-Unsubscribe normally means newsletters; otherwise
the message category or triage applies. Outgoing draft/send inference distinguishes
known contacts from strangers using every To/CC/BCC recipient. Unknown or mixed
recipients use the more conservative class. Verified identity alone does not make
a stranger a known contact. Scheduling and unsubscribe have dedicated categories.
Write tools accept mail handles (`acc:email:…`) as well as local ids.

| Tool | Class | Purpose | Policy category / action |
| --- | --- | --- | --- |
| `archive_emails` | RW | Archive a batch from one account | Mail inference / archive |
| `label_emails` | RW | Add label; `remove: true` removes it | Mail inference / label or unlabel |
| `mark_read` | RW | Mark a batch read | Mail inference / mark_read |
| `move_emails` | RW | Move within an account; destructive destinations pass through the delete ceiling | Mail inference / move |
| `create_draft` | RW | Create a reviewable draft | Outgoing inference / draft_create |
| `reply_draft` | RW | Threaded reply or reply-all, deduplicating recipients and self aliases | Outgoing inference / draft_create |
| `send` | IW | Submit one existing draft or an inline draft to policy/outbox | Outgoing inference / send |
| `unsubscribe` | IW | Header one-click/mailto, HTTPS link, or explicit reply | unsubscribe / unsubscribe |
| `respond_to_event` | RW | Accept, decline or tentatively respond to an invite | scheduling / calendar_respond |
| `propose_meeting` | IW | Submit supplied slots and invitation draft | scheduling / calendar_propose |
| `create_matter` | RW | Create a living workspace and initial attachments, notes, refs and watch | matters / matter_create |
| `update_matter` | RW | Patch editable workspace fields, including notes, refs and watch | matters / matter_update |
| `attach_to_matter` | RW | Attach existing emails (stored as provider refs), events or people | matters / matter_attach |
| `update_person` | RW | Patch editable contact fields | matters / person_update |
| `notes_write` | RW | Append a dated line to, or replace, person or matter notes | matters / person_update or matter_update |
| `snooze` | RW | Snooze mail and/or a matter until a future UTC time | Mail inference, or matters for matter-only snooze / snooze |
| `undo_action` | RW | Undo the trusted stored inverse by ID under current actor policy | Original category / executor.undo lifecycle |
| `cancel_held_action` | RW | Cancel this actor's own held action | Original action category / executor.cancelHold lifecycle |
| `batch_archive_by_query` | RW | One archive action for a query's matches (1,000 via reader, 200 from the store); supports dryRun | Mail inference / archive |
| `apply_label_by_query` | RW | One label action for a query's matches (1,000 via reader, 200 from the store); supports dryRun | Mail inference / label |
| `add_standing_rule` | RW | Append an exact one-line rule; preserve other USER.md sections | matters / profile_update |
| `remove_standing_rule` | RW | Remove an exact bullet rule; preserve other sections | matters / profile_update |

## On-demand results

Every on-demand result carries `source` (`provider`, `cache` or `mixed`) and `cost`
(`gmailUnits` / `graphRequests` / `imapCommands`, `budgetRemaining`, `windowResetsAt`);
fan-out results sum the units and report the lowest `budgetRemaining`. Every result also
carries `nextPageToken`: opaque and bound to the query (a fan-out token encodes each
account's position), or `null` when there is nothing more. Collections add `approxTotal`,
which is a provider estimate: use `mail_count` for exact numbers. `capped: true` marks a
provider result ceiling (Microsoft Graph `$search` stops at 1,000 results; narrow with
`after:`/`before:`). `translation` explains a non-pass-through query translation.

Rows are compact `MailRow`s (about 300 bytes): `id` and `threadId` handles, `rfc822Id`,
`account`, `date`, `from`, `to` (first three, then `+N more`), `subject`, `snippet`
(≤160), `labels`, `unread`, `flagged`, `attachments` (count), `listId?`, `auth?`.

**Untrusted data.** Every string field except ids, handles, cursors and cost comes from
senders or the provider: subjects, snippets, names, addresses, label names, headers,
attachment names and types, bodies, grep lines, participants and `provider_get` bodies (keys
too). Each result has an `untrusted` notice, and those strings are neutralised: every `$` (and
fullwidth `＄`, `﹩`), an `@` or `＠` that is not inside a `local@domain.tld` address, and a `/`
or `／` at the start of a line (after any indentation, including non-breaking and ideographic
spaces; NEL counts as a line break) are followed by an invisible U+200B so host agents never
treat them as skills, mentions or slash commands. Neutralising twice changes nothing.
`rfc822Id`, `inReplyTo` and `references` are returned only as a single well-formed
`<local@domain>` id (else `null`), so a duplicated or forged header cannot inject a line.
Offsets in `mail_read` refer to the neutralised text, so windows stay consistent between
calls; a window that would start mid-line on a live `/` or `@` begins at the previous
non-blank character instead (its `offset` says so).

**Rate limits.** Interactive reads never block on long backoff. A throttled call returns
`{isError: true, error: "RATE_LIMITED", retryAfterSeconds, scope, hint, partial?}`;
`partial.items` holds rows already fetched (for example from accounts that answered a
fan-out search). Nothing is thrown to the model and query writes submit nothing.

**Cost guards.** `mail_count` facets over more than 200 rows (or more than the account's
remaining budget) and `mail_grep` over more than 30 messages return
`{isError: true, error: "WOULD_EXCEED_BUDGET", estimatedUnits, hint}` unless
`confirmCost: true`.

**`mail_read`.** Messages are chronological. Without `messagesFrom`, the last five are in
full and earlier ones are one-line `earlier` headers (`messagesFrom` reports where the full
messages start). Quoted history is collapsed (`[quoted N lines collapsed; quoted:"full" to
expand]`): reply attributions in common locales, Outlook `Original Message` and
`From:/Sent:` blocks, `>` runs, and Gmail/Outlook/Apple HTML quote containers; forwarded
messages are kept. HTML-only bodies become text with links shown as `text (host)` and images
dropped. `offset`/`length` window the concatenated bodies of the full messages (UTF-16 units);
each shown message has its stream `offset`, cut messages carry `truncated`/`continueFrom`, and
the top-level `continueFrom` is where to resume (after any MCP re-truncation it is the lowest
per-message resume point, so no text is skipped). `format:"html"` returns sanitized `htmlBody`
(remote images and beacons stripped); `format:"headers"` returns threading and authentication
headers without bodies. Attachments are listed with `index`, `attachmentId`, `name`, `type` and
`size`; inline parts (embedded images) follow with `inline: true` and no `index`. Pass any of
`index`, `attachmentId` or `name` to `mail_attachment_read`.

**`mail_attachment_read`** downloads one attachment of a message (`id` is a message handle,
`messages[].id` from `mail_read`) and extracts it in a `worker_threads` worker (512 MB heap,
20 s wall clock; past it the worker is terminated and the call fails with
`EXTRACTION_TIMEOUT`). The type comes from the declared MIME type, then the file extension,
then magic bytes:

| Type | Library (pure JS) | Result |
| --- | --- | --- |
| `text/*`, `.csv`, `.json`, `.md`, `.xml`, `.html` | built in (BOM, UTF-8, else Windows-1252; HTML to text) | `text` |
| PDF | `pdfjs-dist` text layer | `--- page N ---` blocks; `pages` range (≤200 pages per call, `pageLimit` when cut); `pages: {from, to, total}`; `scanned: true` and `scannedPages` when a page has no text layer (no OCR) |
| `.docx` | `mammoth` raw text | `text` |
| `.xlsx` / `.xls` / `.ods` | `xlsx` (SheetJS) | CSV per sheet (`# Sheet: name` headed) or one `sheet`; `rows` window per sheet, ≤50,000 rows per call (`rowLimit` when cut); `sheets: [{name, rows}]`, `rows: {from, to, total}` |
| `.pptx` | `fflate` + slide XML | `--- slide N ---` blocks with speaker notes; `slides` |
| `text/calendar` (`.ics`) | built in | `calendar: {method, events: [{summary, start, end, location, organizer, attendees, description, status, recurrence, uid}]}` and a readable `text` |
| `message/rfc822` (`.eml`) | built in (minimal MIME) | `message: {from, to, cc, subject, date, rfc822Id, attachments}` and the text part |
| PNG / JPEG / GIF / WebP ≤ 2 MB | none | MCP: an `image` content block next to the JSON (`kind: "image"`, `bytes`, `mimeType`). Other hosts get `{kind: "image", bytes, note}` unless `asImage: true` |

`maxChars`/`offset` window the extracted (neutralised) text: the result has `offset`,
`totalChars`, `truncated` and `continueFrom`. Extracted text and every string field are
untrusted data, neutralised like bodies. Results carry `account`, `message`, `attachment:
{name, type, size, inline}`, `kind`, `source` and `cost`. Errors: `ATTACHMENT_TOO_LARGE`
(`size`, `limit`: 25 MB), `NOT_DOWNLOADABLE` (Graph reference attachments; `cloudLink` is
the host only), `INVALID_ATTACHMENT_REF`, `UNSUPPORTED_TYPE` (metadata plus `head`: magic
type, printable ratio and printable runs of the first 512 bytes, never a hexdump),
`SHEET_NOT_FOUND`, `EXTRACTION_FAILED` (corrupt or password-protected files),
`EXTRACTION_TIMEOUT` and `NOT_IMPLEMENTED` (provider without `MailReader.attachment`).

Bundle impact: the four libraries are bundled only into the published package's
`dist/server/attachment-worker.js` (≈2.8 MB minified; `cli.js` is unchanged), so they are not
runtime dependencies of `@akd-me/passport`. Installed in the workspace they take about
35 MB (`pdfjs-dist`, mostly fonts, CMaps and source maps), 7.8 MB (`xlsx`), 1.9 MB
(`mammoth`, plus `jszip`, `@xmldom/xmldom` and smaller dependencies) and 0.8 MB (`fflate`). `xlsx` comes from the SheetJS CDN
tarball (0.20.3; the npm release is stale and has known advisories), and pdf.js's optional
native `@napi-rs/canvas` (rendering only) is excluded with `ignoredOptionalDependencies`.

**`mail_grep`** resolves its set from `ids` (messages or whole threads) or a query
(`maxMessages` rows), fetches bodies four at a time per account and matches the pattern per
line (JavaScript regex; lines over 500 characters are clipped in the output). Results list
`id`, `threadId`, `date`, `from`, `subject`, `line`, `text`, `before` and `after`. Patterns are
model-supplied and the text is attacker-controlled, so a pattern over 200 characters, with a
backreference, or with a repeated group that contains a quantifier or alternation (`(a+)+`,
`(\w+\s?)*`, `(a|aa)*`) is refused with `INVALID_INPUT`, and matching runs in the attachment
worker thread: past 2 s it is stopped with `PATTERN_TIMEOUT` and the server keeps serving.
`matchCount` counts matches found; over the response budget trailing matches are dropped
(`truncated: true`, `omittedItems`).

**`mail_changes`** without a cursor returns no changes and a cursor at "now"; Passport never
backfills. `expired: true` means the cursor was too old and a fresh one was issued.

**`provider_get`** allows GET only under — Gmail: `users/me/{messages, threads, labels,
history, drafts, settings/filters, settings/sendAs}`; Graph: `me/{messages, mailFolders,
events, calendarView, people, contacts, mailboxSettings, outlook/masterCategories}` — and
rejects `..`, `$batch` and other prefixes with `PATH_NOT_ALLOWED`. Gmail and Graph implement
`MailReader.rawGet(path, query)`; IMAP and JMAP do not and return `ON_DEMAND_UNSUPPORTED`.
Over the response budget, lists in the body lose trailing items (`truncated: true`,
`omittedItems`); a body that still does not fit becomes `body: null` with `bodyText`, its JSON
clipped to the budget, and `totalBytes`.

**`mail_export`** writes under `<scratchDir>/<session>/` (directory 0700, files 0600): one
Markdown file per thread (`<subject>-<thread hash>.md`, headed by an untrusted-content note,
header lines neutralised and each body block-quoted with `> ` so a body cannot forge another
message's section) or one `.eml` per message (`<thread hash>-<message hash>.eml`; hashes are
16 hex characters of SHA-256 over the full id, so Graph ids sharing a long prefix never
collide). The scratch directory may be writable by a sandboxed host shell, so nothing follows a
symlink: the session and `attachments/` directories must be real directories owned by this
user whose real path stays inside the scratch root (else `INVALID_PATH`), and every file is
created with `O_CREAT|O_EXCL` after unlinking whatever was at its path. The result always
keeps `dir`; over the response budget `files` loses trailing entries (`fileCount` is the
total). With
`includeAttachments`, each non-inline attachment's raw bytes go to `attachments/` as
`<thread hash>-<message hash>-<index>-<name>`: names are reduced to a single safe path component
(no `/`, `\`, control characters or leading dots), each file is at most 25 MB and one call
writes at most 200 MB; anything skipped is listed in `skippedAttachments` with a reason
(`ATTACHMENT_TOO_LARGE`, `TOTAL_LIMIT`, `NOT_DOWNLOADABLE`, …). The host removes sessions
older than 24 h with `sweepScratchDir(scratchDir)` (exported by `@passport/tools` and
`@passport/mcp`; it inspects entries with `lstat`, skips symlinks and never throws); the
Passport server sweeps at start and from its maintenance job.

Errors use stable codes: `ON_DEMAND_UNSUPPORTED`, `RATE_LIMITED`, `WOULD_EXCEED_BUDGET`,
`NOT_FOUND`, `STALE_ID`, `INVALID_QUERY`, `INVALID_CURSOR`, `INVALID_INPUT`, `PATH_NOT_ALLOWED`,
`PATTERN_TIMEOUT`, `INVALID_PATH`, `EXPORT_COLLISION`, plus the attachment codes above.

### Known limitations (review R4)

- **R4-6 (notes_search):** resolved. With `regex: true` the store applies the same pattern
  lint as `mail_grep` (≤ 200 characters, no backreferences, no nested quantifiers) and matches
  in a worker thread with a 2 s limit (`PATTERN_TIMEOUT`). Plain-text search stays inline.
- **R4-2 (mail_export):** directories are checked with `lstat` before files are created by
  path; Node has no `openat`, so a process that swaps a checked directory for a symlink in the
  instant between the check and the write is not stopped. Files themselves are never written
  through a symlink.
- **R4-3:** provider normalisation still joins duplicate `Message-ID` headers; the tools return
  such values as `null` rather than repairing them, and server-side consumers must validate
  them too.

## Results and write behavior

Tool results are plain JSON objects. MCP encodes each result in one text block.
Every submitted write returns `actionId`, `status`, `outcome`, `reason` (the policy
reason), and `holdUntil`, plus compatible audit fields. `actionReason` preserves
the caller's requested explanation. Errors carry `isError: true`.

- `proposed` / `ask`: waiting for a human; it has not executed.
- `held` / `hold`: delayed outbox; cancellable until release, not delivered.
- `executed` / `allow`: the executor completed it.
- `rejected` / `deny`: refused by policy; an error result explains the decision.

Other lifecycle states, including failed execution, remain visible in the log.
Unexpected provider/dependency exceptions return a redacted error; do not assume
a write succeeded without its action result. Raw action parameters, provider
results, credentials and provider exception text are not returned.

Bodies are limited to 2,000 characters unless `full: true`. Remote images and
hidden image beacons are stripped from HTML even with `full: true`; no assets are
fetched. List/search reads normally return IDs and short previews. Limits default
to 25 and max at 100. Mail writes accept 1–100 IDs; query writes select up to 200
and submit exactly one action. Cross-account query matches are rejected before
submission: add `query.accountId` to scope them. `dryRun: true` returns count,
known total, cap indicator and five sample previews without submitting. An empty
query batch returns zero matches without an action.

Every tool response has a total serialized UTF-8 byte budget: 64 KiB over MCP
(`DEFAULT_MCP_RESPONSE_BYTE_BUDGET`, about 16k tokens) and 512 KiB for the built-in agent's
registry (`DEFAULT_RESPONSE_BYTE_BUDGET`). Both are configurable with `responseByteBudget` on
the registry or MCP constructor (minimum 1024). `full: true`
respects the budget, including across multiple emails. Truncated body views return
`truncated: true` and a `continueFrom` offset. MCP accounts for protocol JSON escaping;
resource contents use the same cap with truncation details in `_meta`. When clipping bodies is
not enough, trailing list items are dropped (grep matches, provider lists, export files; at
least one item per list stays) with `omittedItems`; only when that fails too are metadata
strings cut, and finally the call returns `RESPONSE_TOO_LARGE`; request fewer results.

On the store path, `get_email_body({emailId,offset:0,length:16000})` returns `textBody`, sanitized `htmlBody`,
`offset`, `totalLength`, `truncated`, and (when more remains) `continueFrom`. Offsets and
lengths are UTF-16 code units. Length defaults
to 16,000 and accepts 1–1,000,000. Continue at the returned offset until `truncated: false`.
When the text and HTML chunks have different lengths, consume only through `continueFrom`
in each format before advancing. No provider request is made.

On the store path, `search_emails`, `batch_archive_by_query`, and `apply_label_by_query`
exclude provider tombstones by default. Set `includeDeleted: true` in the email query for history access.
`get_email` by ID still returns a tombstone with `deleted: true`; thread/matter histories
include tombstones. Triage screens money/legal/stranger requests before routine signals,
preserves existing money/legal classifications, and only proposes playbooks for categories
in `alwaysAsk`, explaining the approval requirement. Always-ask label edits also ask.

Example query write:

```json
{
  "query": { "accountId": "account-id", "category": "newsletters" },
  "dryRun": true,
  "reason": "Review newsletter archive batch"
}
```

`find_free_slots` accepts `durationMinutes`, `window: {start,end}` in UTC,
`timeZone` (default UTC), and `workingHours: {start:"09:00",end:"17:00",days:[1,2,3,4,5]}`.
Days are Sunday=0 through Saturday=6. The maximum window is 31 days. It observes
zone offsets and daylight-saving changes and returns earliest non-overlapping
slots, with `limitReached` when capped. It does not reserve time.

`summarize_thread` returns a page of participants/timeline/questions and the
actual last message, plus `nextCursor` for remaining source messages (the reader
alias summarizes the last `limit` messages of the provider thread; `nextCursor` is null). Questions
are candidates extracted from unquoted question marks, not a claim that every
question is unresolved. `get_daily_log` includes older actions executed on the
requested date and groups by their current status. `explain_decision` separates
the historical decision from current trust/config; changing trust does not
retroactively approve or re-run an action.

`preview_unsubscribe` prefers an HTTPS one-click header, then header mailto,
then an HTTPS header link. Reply is shown as an explicit alternative, never
selected automatically. It exposes destination hosts/addresses, not token-bearing
URLs. It does not infer body links or call a provider.

Standing-rule writes replace the complete USER.md through a `profile_update`
action, with the previous effective Markdown captured at execution for undo.
`getEffectiveProfile(store)` supplies the complete default template when unset; reads,
first rule edits, MCP resources, agent prompts and inverse capture share it. A pending
proposal leaves USER.md unchanged. Review pending profile edits against subsequent
human changes before approving a whole-document replacement.

`undo_action` calls `executor.undo(actionId, {actor,reason})`. The executor loads its
private snapshot by ID, evaluates the caller under the current external ceiling,
and logs the inverse before execution. Below effective `full_access`, an external
agent can undo only actions created by the same external `actor.id`. Destructive
restorations and protected identity changes remain denied. Proposed undos wait for
human approval; executed undos mark the original `undone`. Snapshots cannot be
submitted or edited as public action params. Cancellation uses the existing
executor lifecycle after an actor ownership check. No tool approves decisions,
changes trust, releases the outbox, or purges mail.

A single `destinationGuard` covers `label`, `unlabel`, `move`, `archive`,
`unarchive`, and `delete`, including query writes. It resolves label names/local
IDs/provider IDs to mailbox roles and follows `parentId` through all ancestors. Role-less
Trash, Deleted Items, Deleted Messages, Bin, Junk, Spam, [Gmail]/Trash and [Gmail]/Spam
names match case-insensitively; descendants are also destructive. Adding a `trash` or `junk` mailbox, or removing
the last safe mailbox so that only trash/junk remains, is destructive. Folder
membership removals that would discard the last folder are also destructive.
These actions escalate to `other` (preserving `money`/`legal`), carry trusted
`destructive` metadata, have at least medium risk, and use the same external deny
rule as delete. A harmless-looking label sequence cannot bypass the ceiling.

`update_person` asks for human approval when changing a self person's addresses
or relationship, assigning self status, or adding an address to a known person.
Self identity changes are denied to external agents at every trust level.
`verifiedSelf` is derived by the executor after human approval and is absent from
the tool schema. Classification trusts self addresses only from account/configured
addresses or human-verified self contacts. `downgradeAcknowledgedAt` clears a
persistent blue-to-green warning through a human-approved person update; external
agents cannot acknowledge it. A later blue message resets the warning baseline.

On label-capable accounts, a missing label is created through the provider within
the same label action, then persisted locally. Its ID is recorded in the inverse;
undo removes membership from those messages and leaves the created label in place.
Gmail, JMAP and mock providers implement creation. IMAP and the current Graph
folder adapter advertise no label support; newsletter/receipt triage attaches a
matter and archives without requiring a label.

Availability queries include the complete proposal range and older recurring
masters, with no default 50-event cap. `free_busy`, `find_free_slots`, and agent
scheduling share recurrence expansion: DAILY/WEEKLY/MONTHLY, INTERVAL, BYDAY
(including monthly ordinal weekdays), COUNT, UNTIL, and WKST. Expansion preserves
the event's wall time across DST changes. Unsupported rules fail explicitly.
Cancelled/declined occurrences are excluded; overrides with `recurringEventId`
and `originalStart` replace or cancel their master occurrence. Current Google and
CalDAV adapters do not retain exception identities, so local fallback cannot
honour their unexposed cancellations; prefer provider availability in that case.
Working-hours slot calculation still uses the requested IANA time zone.

## External and built-in agents

The registry receives its actor from trusted host code. MCP always uses
`{kind:"external-agent",id:transportId}` and respects `externalAgentCeiling`.
Stdio allocates a random identity at server startup; HTTP uses the authenticated session ID.
Client names are audit labels in action reasons and cannot claim undo/cancellation ownership. HTTP bearer auth authenticates access to the MCP
listener; it does not grant higher trust. Tools accept no actor/category override.
Resources and prompts remain available at `passport://matters/{id}`,
`passport://people/{id}`, `passport://user-profile`, `passport://decisions`,
`triage_inbox` and `summarize_matter`.

The built-in runtime uses `{kind:"agent",id:runId}` with the same definitions and
handlers. Its triage pipeline supplies trusted, code-derived identity snapshots
and classification/email metadata context; this is not part of model-facing
schemas and is ignored for external actors. Manual instructions have a 12-call
budget across reads and writes. New registry tool names automatically appear in
the system prompt and available-tool list. `run()` returns and persists
`toolBudget: {callsMade,llmCalls,inputTokens,outputTokens,totalTokens}`. Token
counts use reported LLM usage, not estimates; absent usage counts as zero.

Both actors use the same executor, global mode, category trust and always-ask
rules. The built-in agent additionally runs triage, people/matter inference and
scheduled digests; MCP clients can build their own workflows from the same tools.

## Install a client

After `pnpm build`, run the installed `passport` CLI (or
`node /absolute/path/to/apps/server/dist/cli.js`):

```sh
passport mcp install --client claude-code
passport mcp install --client claude-code --user
passport mcp install --client codex
passport mcp install --client cursor
passport mcp install --client claude-desktop
passport mcp install --client codex --http --dry-run
```

Installation merges Passport's connection entry, preserves unrelated keys, backs
up an existing file as `<file>.bak-<timestamp>-<id>`, and writes atomically with
0600 permissions. `--dry-run` prints the redacted planned config and writes no
config, backup or token file. Codex config edits preserve unrelated TOML text and
Passport tool/time-out settings; unsupported inline/dotted Passport table forms
fail without overwriting the file. Convert these to `[mcp_servers.passport]` first.

Stdio uses the absolute current Node executable and built server entry; clients
launch `passport mcp`, which keeps stdout exclusive to MCP and opens the store in client mode
without background jobs or an arrival queue. It can coexist with `serve`; without a live owner,
it prints a stderr notice and held/proposed submissions wait for `serve`. Nondefault data
directories are included as `env.PASSPORT_DATA_DIR` (Codex) or `env: { PASSPORT_DATA_DIR }`
(JSON clients). Printed previews redact secret-bearing keys recursively, including unrelated
existing entries; actual config and backups retain their values. Example project
`.mcp.json` for Claude Code (user scope instead writes `~/.claude.json`):

```json
{
  "mcpServers": {
    "passport": {
      "type": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/apps/server/dist/cli.js", "mcp"]
    }
  }
}
```

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.passport]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/apps/server/dist/cli.js", "mcp"]
```

Cursor `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "passport": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/apps/server/dist/cli.js", "mcp"]
    }
  }
}
```

Claude Desktop on macOS uses the same stdio JSON as Cursor in
`~/Library/Application Support/Claude/claude_desktop_config.json`.

### HTTP clients

Start `passport serve` to run the authenticated MCP listener on
`http://127.0.0.1:4318/mcp` by default. `PASSPORT_MCP_PORT` changes its port.
The listener and installer share `PASSPORT_MCP_TOKEN` when set; otherwise they
read/create `<dataDir>/mcp-token` (32 random bytes as hex, created with 0600).
`PASSPORT_DATA_DIR` selects the same data directory for both commands. The URL
prints once at listener startup; tokens never print. Treat the generated client
config as private because it contains the bearer token.

Add `--http` to installation for any client. `PASSPORT_MCP_URL` or `--url` can
specify another endpoint. The token must match that endpoint. The installer
copies the same token into the config; restarting a server with a different env
override requires updating its client configs.

Claude Code HTTP `.mcp.json` (the installer substitutes the real token):

```json
{
  "mcpServers": {
    "passport": {
      "type": "http",
      "url": "http://127.0.0.1:4318/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Codex HTTP:

```toml
[mcp_servers.passport]
url = "http://127.0.0.1:4318/mcp"
http_headers = { Authorization = "Bearer <token>" }
```

Cursor HTTP:

```json
{
  "mcpServers": {
    "passport": {
      "url": "http://127.0.0.1:4318/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Claude Desktop's local config uses a dependency-free Passport stdio bridge:

```json
{
  "mcpServers": {
    "passport": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/apps/server/dist/cli.js", "mcp", "proxy", "--url", "http://127.0.0.1:4318/mcp"],
      "env": { "PASSPORT_MCP_TOKEN": "<token>" }
    }
  }
}
```

Configuration references: [Claude Code](https://code.claude.com/docs/en/mcp),
[Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Cursor](https://cursor.com/docs/mcp), and
[Claude Desktop local configuration](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Host integration

`createMailboxMcpServer({store,executor,policy,bus,clientName?,freeBusy?,responseByteBudget?,readers?,scratchDir?})`
and `createToolRegistry({...,readers?,scratchDir?,scratchSession?})` take the on-demand
seams: `readers` is a `MailReaderResolver` (`accountId → MailReader | null`); `scratchDir`
(for example `<dataDir>/scratch`) enables `mail_export`, with one random session directory
per MCP server; the host calls `sweepScratchDir(scratchDir)` periodically. `imageContent: true`
(set by the MCP server) tells the registry the host renders `IMAGE_CONTENT` (a symbol-keyed
`{data, mimeType}` on a result) as image content, so `mail_attachment_read` returns images
without `asImage`. The built-in agent
passes `readers` and no `scratchDir`. A trusted per-call `ToolContext.readers` (second
`handler` argument, never model-supplied) overrides the registry's resolver for that call. `createMailboxMcpServer(...)`,
`createAgentRuntime(...)`, and `createToolRegistry(...)` accept an optional
`freeBusy(accountId,range)` resolver. Return provider intervals for a connected
calendar account, or `null` when none is connected; an empty array means confirmed
free time. Resolver failures propagate rather than silently declaring time free.
Without a resolver, availability uses the local store. Results identify
`source: "provider" | "local_store" | "mixed"`. The libraries now
import `@passport/tools` from the workspace. Host-created HTTP listeners must
supply `serveHttp(server,{port,token,host?})`: every request, including session
GET/DELETE, requires the bearer. The default bind remains `127.0.0.1`; only an
explicit `host` changes it. Host/Origin validation still applies. The server app
already loads and passes the shared token through its small listener seam.

Custom executors must implement `profile_update` in category `matters`: capture
prior USER.md immediately before execution, write `store.kv["user_profile"]`,
and persist a `profile_update` inverse containing the prior Markdown. The
reference executor does this; custom/in-memory fakes need the new case if they
execute standing-rule writes. Existing agent identity/emailPatch conventions
remain supported. The host still owns provider sync, human approval and outbox
release scheduling; neither MCP nor the registry starts these lifecycles.
