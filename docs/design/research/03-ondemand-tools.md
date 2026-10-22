# 03 — On-demand tool belt: fetch email when you need it, don't mirror the mailbox

Status: research + design, 2026-10-22. Read-only with respect to `/Volumes/FastBoy/passport`.
Audience: the engineer implementing this in TypeScript next week.

---

## 0. TL;DR

- **Gmail's quota now makes a full mirror expensive.** The Gmail API quota page (last updated
  2026-10-16) lists **6,000 quota units per user per minute**. `messages.get` costs **20 units,
  or 60 with `format=full|raw`**, and `threads.get` costs 40 (120 full). `messages.list` costs 5
  and `history.list` costs 2. Mirroring 20k messages with bodies, which is what `GmailMailProvider.sync` does today, costs about 1.2M units:
  **at least 200 minutes at 100% of the user's quota**, before retries. This is why commit `24e5da7`
  ("ride out Gmail rate limits instead of failing the initial sync") was needed. A metadata-only index
  of the same mailbox still costs about 400k units, roughly **67 minutes at full quota**.
  ([Gmail quota](https://developers.google.com/workspace/gmail/api/reference/quota))
- **Server-side search is good enough to work like `grep`.** Gmail's `q` takes the full Gmail search
  language (`from: to: subject: has:attachment filename: larger: newer_than: rfc822msgid: header: AROUND …`).
  Graph `$search` takes KQL over from/to/cc/bcc/participants/subject/body/attachment/received/size and returns up to 1,000 results.
  IMAP `SEARCH`, with `ESEARCH`/`SORT`/`THREAD` where the server supports them, works everywhere.
  A single `list` call on Gmail returns only ids, so building rows costs 20 units per row.
  That cost is what justifies a small cache.
- **Recommendation: option (c+), a lazily filled envelope cache.** It holds immutable headers forever and mutable labels
  with a freshness stamp, kept fresh by the change watcher. Bodies go in a TTL'd LRU. Credentials, the action log,
  change cursors, and agent-maintained **notes** for people and matters complete the local state.
  **No FTS over bodies and no backfill.** Proactive work is driven by `history.list` / Graph `delta` / IMAP `IDLE` polling,
  which costs about 2 Gmail units per poll.
- **The tool belt** has 14 read tools and 11 write tools (§2). Its core is `mail_search` (Grep),
  `mail_list` (ls/Glob), `mail_read` (Read), `mail_grep` (Grep -C over a bounded set), and `mail_changes` (git status).
  `provider_get` (a read-only raw GET) plus `mail_export` (materialize threads to files) together stand in for Bash.
  Every write still goes through `ActionExecutor`.
- **Smallest migration path:** keep the `Store.emails` interface for policy and the executor, but make it a read-through
  cache over the provider instead of a mirror. The `localId` scheme `${accountId}:email:${encodeURIComponent(providerId)}`
  (`packages/providers/src/errors.ts:56`) is already deterministic, so handles stay stateless.

---

## 1. Provider capability matrix

### 1.1 Summary table

| Capability | Gmail API | Microsoft Graph (Outlook) | IMAP (+ extensions) |
|---|---|---|---|
| **Query language** | Gmail search (`q`), same as the web UI. Full operator list in §1.2 | `$search` = KQL on messages (from, to, cc, bcc, participants, recipients, subject, body, attachment, hasAttachments, importance, kind, received, sent, size). `$filter` = OData on properties (receivedDateTime, isRead, from/emailAddress/address, conversationId, internetMessageId, categories, hasAttachments, flag/flagStatus …) | `SEARCH` keys: FROM TO CC BCC SUBJECT BODY TEXT HEADER, SINCE BEFORE ON, SENTSINCE…, LARGER SMALLER, SEEN UNSEEN FLAGGED ANSWERED DRAFT KEYWORD, UID sets, OR NOT. Gmail IMAP adds `X-GM-RAW` (full Gmail `q`), `X-GM-THRID`, `X-GM-LABELS` |
| **Combining** | One string with implicit AND, plus `OR`, `-`, `()`, `{}` | `$search` **cannot be combined with `$filter` or `$orderby`** on messages (400; see [Q&A](https://learn.microsoft.com/en-us/answers/questions/1184920/is-there-a-microsoft-graph-api-to-filter-and-searc), [guide](https://cli.nylas.com/guides/microsoft-graph-mail-query)). `$filter` + `$orderby` must list properties in the same order or you get `InefficientFilter` | Arbitrary boolean in SEARCH. `SORT` (RFC 5256) for server-side ordering |
| **Result cap** | Unbounded paging | `$search` returns **up to 1,000 results**, sorted by sent date ([doc](https://learn.microsoft.com/en-us/graph/search-query-parameter)). Community reports a ~250 cap and no `$skip` | Unbounded. `ESEARCH RETURN (MIN MAX COUNT ALL)` (RFC 4731) avoids huge UID lists. `PARTIAL` (RFC 9394) pages |
| **Paging** | `pageToken` / `nextPageToken`. `maxResults` default 100, **max 500** (messages.list) | `@odata.nextLink` (opaque, contains `$skip`; do not edit it). `$top` 1–1000 on list ([doc](https://learn.microsoft.com/en-us/graph/api/user-list-messages)) | UID sets / sequence sets. The client pages by slicing the UID list |
| **List response shape** | **ids + threadId only**. You need `messages.get` per row, batched | **Full objects with `$select`**: one request returns rows with headers, preview, and even bodies | `UID FETCH (ENVELOPE FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE)` for many messages in one round trip |
| **Batching** | `/batch/gmail/v1`: **max 100 calls, recommended ≤50**. Each call counts against quota individually ([doc](https://developers.google.com/workspace/gmail/api/guides/batch)) | `$batch`: **max 20 requests**. Outlook executes **4 at a time per mailbox**. Each inner request is throttled individually and can 429 ([doc](https://learn.microsoft.com/en-us/graph/json-batching)) | Pipelining. One command covers many UIDs |
| **Bulk modify** | `messages.batchModify`: up to 1,000 ids for **50 units** (vs `modify` at 5 each) | No bulk PATCH. Use `$batch` of 20 `PATCH`/`move` | `UID STORE` / `UID MOVE` (RFC 6851) on a set |
| **Thread fetch** | `threads.get` returns every message in the Gmail thread, across labels, incl. SENT. **40 units (120 full), whatever the thread length** | No thread endpoint for mailbox messages. `GET /me/messages?$filter=conversationId eq '…'` across all folders. Sort client-side (filter+orderby trips `InefficientFilter`). `conversationIndex` gives a tree order | `THREAD=REFERENCES` (RFC 5256) **within one mailbox**. Gmail `X-GM-THRID`. `OBJECTID` (RFC 8474) gives `THREADID`. Otherwise join on `References`/`In-Reply-To` across INBOX + Sent |
| **Message formats** | `minimal` (ids, labels, snippet), `metadata` (+ chosen `metadataHeaders`), `full` (parsed MIME tree, base64url parts), `raw` (RFC 5322). minimal/metadata = 20 units, full/raw = 60 | `$select` any property set. `body` (HTML default), **`Prefer: outlook.body-content-type="text"`** converts on the server. **`uniqueBody`** = only the new part of this message, with quoted history removed by Exchange. `internetMessageHeaders`. `/$value` = MIME | `BODY.PEEK[HEADER.FIELDS (…)]`, `BODY.PEEK[TEXT]<0.4096>` partial, `BODY[n.m]` per part, `BINARY` (RFC 3516) |
| **Attachments** | `messages.attachments.get` (20 units). Small parts inline in `full` | `GET …/attachments` (metadata) and `…/attachments/{id}/$value` (bytes). `referenceAttachment` = cloud link (not downloadable here). Upload sessions for >3 MB | `FETCH BODY[part]` |
| **Labels / folders** | Labels (many per message): `labels.list` 1 unit, `labels.get` 1 (exact `messagesTotal/Unread`, `threadsTotal/Unread`), create 5 | Folders (one per message, hierarchical) + **categories** (many per message, label-like). `mailFolders` + `childFolders`, `totalItemCount`/`unreadItemCount` | Folders via `LIST` (+ `SPECIAL-USE` roles), `STATUS (MESSAGES UNSEEN UIDNEXT HIGHESTMODSEQ)`. Keywords (`$Label1`, custom) if `PERMANENTFLAGS \*` |
| **Count / facets** | `labels.get` gives exact counts for one label. `resultSizeEstimate` is **approximate**. Exact count = page ids at 5 units per 500 | `$count=true` on `$filter` queries. Folder counts. `$search` count = page ids (≤1,000) | `ESEARCH RETURN (COUNT)`. `STATUS` |
| **"What changed since"** | `history.list(startHistoryId, historyTypes, labelId)`: 2 units/page. History is "typically available for at least one week", sometimes much less. **404 means start over** ([sync guide](https://developers.google.com/workspace/gmail/api/guides/sync)) | `messages/delta` **per folder**. `$filter` only `receivedDateTime ge/gt`. `$orderby` only `receivedDateTime desc`. **No `$search`**. `changeType=created` filter. `@removed` for moves out. 410 means expired ([doc](https://learn.microsoft.com/en-us/graph/api/message-delta)) | `CONDSTORE`/`QRESYNC` (RFC 7162): `CHANGEDSINCE modseq`, `VANISHED` for expunges. Otherwise compare UIDNEXT plus UID list |
| **Push** | `users.watch`: Pub/Sub topic in **your GCP project**, grant to `gmail-api-push@system.gserviceaccount.com`. **Pull or webhook** subscription. Renew at least every 7 days (daily recommended). **Max 1 event/s per user**, payload = `{emailAddress, historyId}` only ([doc](https://developers.google.com/workspace/gmail/api/guides/push)). 100 units per watch | Subscriptions to `me/mailFolders('inbox')/messages`: **public HTTPS `notificationUrl` required** (or Event Hubs/Event Grid). Max **10,080 min** (under 7 days), 1,440 min with resource data. Latency avg <1 min, max 3 min ([doc](https://learn.microsoft.com/en-us/graph/api/resources/subscription)) | `IDLE` (RFC 2177), one mailbox per connection. `NOTIFY` (RFC 5465) for many mailboxes where supported |
| **Contacts / people** | Not in Gmail API. **People API**: `people:searchContacts` (prefix match, **send an empty-query warmup first**), `otherContacts:search` (auto-saved correspondents). Needs `contacts.readonly` / `contacts.other.readonly` ([doc](https://developers.google.com/people/v1/contacts)) | `/me/people?$search=` (relevance-ranked people you interact with, up to 250 by default, `People.Read`). `/me/contacts` (`Contacts.Read`) | None (CardDAV is a separate protocol) |
| **Calendar search** | Calendar API `events.list(q, timeMin, timeMax, singleEvents=true, orderBy=startTime)` | `calendarView?startDateTime&endDateTime` (expands recurrences). Filter client-side. `$search` is not supported on events | CalDAV `REPORT calendar-query` (separate protocol) |
| **Free/busy** | `freeBusy.query` (`items` ≤50 calendars expanded, groups ≤100). Scopes `calendar.freebusy` / `calendar.events.freebusy` / `calendar.readonly` ([doc](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)) | `POST /me/calendar/getSchedule` (`availabilityViewInterval` 5–1440). **Not supported for personal Microsoft accounts.** Fails with error 5006 if a slot holds >1,000 entries ([doc](https://learn.microsoft.com/en-us/graph/api/calendar-getschedule)). Fallback: `calendarView` | CalDAV `free-busy-query` |
| **Rate limits** | **6,000 units/min per user per project**. 1,200,000/min per project. 80M units/day billing threshold. Rate errors arrive as 403 `rateLimitExceeded`/`userRateLimitExceeded` or 429 | Outlook: **10,000 requests / 10 min per app+mailbox**, **4 concurrent requests per mailbox**, 150 MB upload / 5 min ([doc](https://learn.microsoft.com/en-us/graph/throttling-limits)). Global: 130k req / 10 s per app. 429 + `Retry-After`. `x-ms-throttle-limit-percentage` appears once >80% of the limit is used | Server-specific: connection caps, bandwidth caps (Gmail IMAP has daily download limits). No per-call quota |

### 1.2 Gmail `q` operators (verified against [Gmail Help 7190](https://support.google.com/mail/answer/7190))

`from:` `to:` `cc:` `bcc:` `subject:` `after:`/`before:` (YYYY/MM/DD or epoch seconds) `older:`/`newer:`
`older_than:`/`newer_than:` (`d`,`m`,`y`) `OR` / `{ }` `AND` `-` `AROUND n` `label:` `category:`
(primary/social/promotions/updates/forums/reservations/purchases) `has:attachment|drive|document|spreadsheet|presentation|youtube`
`list:` `filename:` `"exact phrase"` `( )` `in:anywhere|inbox|sent|drafts|spam|trash|archive|snoozed`
`is:muted|important|starred|unread|read` `has:yellow-star…` `deliveredto:` `size:`/`larger:`/`smaller:` (`10M`)
`+word` `rfc822msgid:` `has:userlabels`/`has:nouserlabels` `label:encryptedmail` `header:Name:value`.

Notes for the implementer:
- `messages.list` skips SPAM/TRASH unless `includeSpamTrash=true`. `in:anywhere` searches both.
- `q` is **not allowed with the `gmail.metadata` scope**. Passport requests `gmail.modify`
  (`packages/providers/src/registry.ts:30`), which is fine.
- `after:`/`before:` with epoch seconds avoids time-zone ambiguity. Date strings are interpreted in the
  account's zone.
- `rfc822msgid:` is the universal way to re-find a message after its id goes stale (§5.2).

### 1.3 Gmail method costs that matter (verified, page updated 2026-10-16)

| Method | Units | Method | Units |
|---|---|---|---|
| `getProfile` | 1 | `messages.modify` | 5 |
| `labels.list` / `labels.get` | 1 / 1 | `messages.batchModify` (≤1,000 ids) | 50 |
| `history.list` | 2 | `threads.modify` | 10 |
| `messages.list` | 5 | `messages.trash` / `untrash` | 20 / 5 |
| `drafts.list` | 5 | `drafts.create` / `update` / `delete` | 10 / 15 / 10 |
| `threads.list` | 10 | `messages.send` / `drafts.send` | 100 / 100 |
| `messages.get` (minimal/metadata) | **20** | `watch` / `stop` | 100 / 50 |
| `messages.get` (full/raw) | **60** | `labels.create` | 5 |
| `threads.get` (minimal/metadata) | **40** | `messages.attachments.get` | 20 |
| `threads.get` (full) | **120** | `settings.filters.list` / `create` | 1 / 5 |

At 6,000 units/min a single user gets about **100 units/s**: five metadata rows per second, or under
two full messages per second. Every design decision below follows from this.

### 1.4 Graph details worth knowing

- **Ids:** always send `Prefer: IdType="ImmutableId"` (already done in `graph.ts:172`). Without it,
  ids change on every folder move. Immutable ids still change when an item moves to an archive mailbox or another
  mailbox ([immutable id doc](https://learn.microsoft.com/en-us/graph/outlook-immutable-id)).
- **Body handling:** list and get default to HTML. `Prefer: outlook.body-content-type="text"` returns
  server-converted text for both `body` and `uniqueBody`. `uniqueBody` is not returned unless `$select`ed.
- **Re-finding:** `GET /me/messages?$filter=internetMessageId eq '<id@host>'`.
- **Large pages:** `$top` near 1000 with heavy `$select` can return 504. Use 100–250 for rows with previews
  and ≤50 when selecting bodies.
- **Throttling headers:** `Retry-After` on 429. `x-ms-throttle-limit-percentage` (0.8–1.8) lets you slow down
  *before* you hit 429.
- **Push needs a public HTTPS endpoint.** A local-first desktop app does not have one, so poll `delta`.
  Polling every 30 s uses 20 of the 10,000 requests per 10 minutes.

### 1.5 IMAP extension cheat sheet

| Extension | RFC | Why the tool belt cares |
|---|---|---|
| IMAP4rev2 (includes ESEARCH, MOVE, …) | [9051](https://www.rfc-editor.org/rfc/rfc9051) | Modern baseline |
| ESEARCH | [4731](https://www.rfc-editor.org/rfc/rfc4731) | `RETURN (COUNT MIN MAX)`: cheap counts for `mail_count` |
| SORT / THREAD | [5256](https://www.rfc-editor.org/rfc/rfc5256) | Newest-first `mail_list`. Per-mailbox threads |
| CONDSTORE / QRESYNC | [7162](https://www.rfc-editor.org/rfc/rfc7162) | `mail_changes` without UID-list diffing |
| IDLE / NOTIFY | [2177](https://www.rfc-editor.org/rfc/rfc2177) / [5465](https://www.rfc-editor.org/rfc/rfc5465) | Proactive wake-ups |
| OBJECTID | [8474](https://www.rfc-editor.org/rfc/rfc8474) | Stable `EMAILID`/`THREADID` across moves |
| MOVE | [6851](https://www.rfc-editor.org/rfc/rfc6851) | Atomic move (UIDs change; `COPYUID` response gives the new one) |
| PARTIAL | [9394](https://www.rfc-editor.org/rfc/rfc9394) | Paged SEARCH results |
| Gmail X-GM-EXT-1 | [Google](https://developers.google.com/workspace/gmail/imap/imap-extensions) | `X-GM-RAW` (Gmail `q`), `X-GM-THRID`, `X-GM-MSGID`, `X-GM-LABELS` |

**JMAP** (RFC 8621; `packages/providers/src/jmap.ts` exists) fits this design better than any of the three:
`Email/query` with filter, sort and `collapseThreads`, `Email/get` with chosen properties, `SearchSnippet/get`,
`Thread/get`, `Email/changes`, and EventSource push. Treat it as "Graph-like" in every table below.

---

## 2. The tool set

### 2.1 Mapping to coding-agent primitives

| Claude Code primitive | What it does for code | Email equivalent | Notes |
|---|---|---|---|
| `LS` | List a directory | `mail_labels` (tree of labels/folders with counts) + `mail_list` (contents of one label/folder) | Cheap orientation |
| `Glob` | Find files by **name/shape**, not content | `mail_list` with structural filters only: container, date window, sender/domain pattern, `is:unread`, `has:attachment`, size | Never touches bodies. On Graph it is a pure `$filter` query, so it can sort |
| `Grep` | Find content across the tree | `mail_search` (server-side full text) | The workhorse |
| `Grep -C` / `rg` with a regex | Exact-pattern matches with context lines | `mail_grep` (regex over bodies of a **bounded** id set) | Fetch, then match locally. The agent narrows first |
| `Read` (with offset/limit, reads images and PDFs) | Read a file | `mail_read` (thread/message as clean text, offsets) + `mail_attachment_read` (pdf/docx/xlsx/ics/images) | Images go back as MCP image content so a multimodal host reads them itself |
| `git status` / `git log` | What changed | `mail_changes` | Agent-held cursor, backed by history/delta |
| `wc -l` / `sort \| uniq -c` | Counting | `mail_count` (exact counts + facets) | |
| `Edit` / `Write` | Mutate files | `draft_create` / `draft_update` / `label` / `archive` / … through `ActionExecutor` | Every write is policy-gated |
| `Bash` | Escape hatch + composition | **(1) `provider_get`**: read-only, allowlisted raw GET against the provider API for anything the belt doesn't model. **(2) `mail_export`**: write threads/attachments as `.md`/`.eml` into a scratch dir so a host agent with a real shell (Claude Code, Codex) can use its own `rg`, `jq` and scripts | Never a write passthrough. Writes must stay typed so policy can classify them |
| `CLAUDE.md` / memory files | Durable context the agent maintains | `notes_*` for people and matters (§4.3) + USER.md (exists) | Replaces derived tables over a mirror |
| `TodoWrite` | Task list | Matters' `nextStep` / `dueAt` | Exists |

### 2.2 Conventions shared by all tools

**Handles.** Every row carries an opaque `id` (the existing deterministic
`${accountId}:email:${encodeURIComponent(providerId)}`), a `threadId` of the same form, and `rfc822Id`
(the Message-ID header). `rfc822Id` lets a tool re-find the message after a move or id change (§5.2) without
asking the agent.

**Compact row** (≈250–400 bytes, so 25 rows ≈ 3k tokens):

```ts
interface MailRow {
  id: string;            // passport handle
  threadId: string;
  rfc822Id: string | null;
  account: string;       // accountId
  date: string;          // ISO UTC (internalDate / receivedDateTime / INTERNALDATE)
  from: string;          // "Name <addr>"; one string, not an array
  to: string[];          // first 3 + "+N more"
  subject: string;
  snippet: string;       // ≤160 chars, provider snippet/bodyPreview
  labels: string[];      // display names; Graph: [folderName, ...categories]
  unread: boolean;
  flagged: boolean;
  attachments: number;   // count; names come from mail_read
  listId?: string;       // present when List-Id/List-Unsubscribe is present (newsletter signal)
  auth?: "pass" | "fail" | "none"; // DMARC summary; only when headers were fetched
}
```

**Result envelope** (all reads):

```ts
interface ReadResult<T> {
  items: T[];
  nextPageToken?: string;      // opaque; encodes provider token + query + account
  approxTotal?: number;        // Gmail resultSizeEstimate / Graph @odata.count; label it approximate
  source: "provider" | "cache" | "mixed";
  staleAsOf?: string;          // when served from cache while offline/throttled
  cost: { gmailUnits?: number; graphRequests?: number; imapCommands?: number;
          budgetRemaining?: number; windowResetsAt?: string };
}
```

Returning `cost` on every call is deliberate. Agents adjust to costs they can see (Claude Code shows output sizes the same way).
It also lets the built-in agent's 12-call budget be expressed in quota units.

**Portable query mini-language.** `mail_search` accepts either `query` (portable) or `rawQuery`
(provider-native passthrough). The portable form is a Gmail-flavoured subset that every backend can translate:

| Portable | Gmail `q` | Graph | IMAP SEARCH |
|---|---|---|---|
| `from:x` | `from:x` | `$search="from:x"` | `FROM "x"` |
| `to:x` / `cc:x` | same | `to:x` / `cc:x` | `TO` / `CC` |
| `with:x` (any participant) | `{from:x to:x cc:x bcc:x}` | `participants:x` | `OR OR FROM x TO x CC x` |
| `subject:"a b"` | same | `subject:"a b"` | `SUBJECT "a b"` |
| bare words / `"phrase"` | same | bare KQL | `TEXT "…"` (slow on weak servers) |
| `has:attachment` | same | `hasAttachments:true` | `HEADER Content-Type multipart/mixed` (approximate; or BODYSTRUCTURE post-filter) |
| `filename:pdf` | same | `attachment:pdf` | post-filter on BODYSTRUCTURE |
| `after:2026-01-01` / `before:` | `after:<epoch>` | `received>=2026-01-01` (KQL) or `$filter receivedDateTime ge` | `SINCE 1-Jan-2026` |
| `newer_than:7d` | same | translate to `received>=` | translate to `SINCE` |
| `in:inbox` / `label:X` | same | path `/mailFolders/{id}/messages` (folder) or `categories/any(c:c eq 'X')` (`$filter` only) | `SELECT` mailbox / `KEYWORD` |
| `is:unread` / `is:starred` | same | `$filter isRead eq false` / `flag/flagStatus eq 'flagged'` | `UNSEEN` / `FLAGGED` |
| `larger:5M` | same | `size>5000000` (KQL) | `LARGER 5000000` |
| `rfc822msgid:<x>` | same | `$filter internetMessageId eq '<x>'` | `HEADER Message-ID "<x>"` |

On Graph the translator must choose a strategy: **`$search` path** (any free text, from/to/subject;
no sort, ≤1,000) or **`$filter` path** (only structured predicates; sortable, countable). Mixing free text with
`is:unread`/folder therefore means running `$search` scoped to the folder path and applying the
structured predicate **client-side** on the returned rows. Report this as
`{"translation":"graph:$search+clientFilter"}` in the result so the behaviour isn't a mystery. On Gmail the portable form passes through
almost unchanged.

**Latency classes**: **L0** local (<20 ms) · **L1** one provider round trip (150–500 ms) ·
**L2** fan-out/batch (0.5–3 s) · **L3** bulk or extraction (3–30 s; prefer returning partial results with `nextPageToken`).

**Write classes** follow `ACTION_REVERSIBILITY` in `@passport/types`: **R** read, **RW** reversible write
(executor stores an inverse), **IW** irreversible write (always held/asked as policy says).

### 2.3 Read tools

Quota column: Gmail units / Graph requests / IMAP round trips. "+20/miss" means 20 Gmail units per row that is
not already fresh in the envelope cache.

| # | Tool | Purpose | Input sketch | Backing calls | Latency | Cost (Gmail / Graph / IMAP) |
|---|---|---|---|---|---|---|
| 1 | `mail_accounts` | Accounts, capabilities, quota state, watcher health | `{}` | local | L0 | 0 |
| 2 | `mail_labels` | `ls /`: label/folder tree with roles and counts | `{account, counts?: bool}` | G: `labels.list` (+`labels.get` per label if counts). M: `mailFolders?$top=250` + `childFolders` recursion, `masterCategories`. I: `LIST "" *` (SPECIAL-USE) + `STATUS` | L1/L2 | 1 (+1/label) / 1–3 / 1+N |
| 3 | `mail_list` | `ls <label>` / Glob: newest first, structural filters only | `{account, container?: label\|folderId\|"inbox", filter?: {from?, fromDomain?, unread?, flagged?, hasAttachment?, after?, before?, largerThan?}, limit≤100=25, pageToken?}` | G: `messages.list(labelIds, q=structural)` + batch `messages.get(format=metadata, metadataHeaders=From,To,Cc,Subject,Date,Message-ID,List-Id,List-Unsubscribe)`. M: `GET /mailFolders/{id}/messages?$select=…&$filter=…&$orderby=receivedDateTime desc&$top=`. I: `UID SORT (REVERSE ARRIVAL)` or `UID SEARCH` + `UID FETCH (ENVELOPE FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (LIST-ID LIST-UNSUBSCRIBE)])` | L1–L2 | 5 + 20/miss (≤505) / 1 / 2 |
| 4 | `mail_search` | grep: server-side full-text + operators | `{account?: id\|"all", query?: string, rawQuery?: string, limit≤100=25, pageToken?, includeSpamTrash?=false, threads?: bool}` | G: `messages.list(q)` (or `threads.list(q)` when `threads:true`) + metadata batch. M: `GET /me/messages?$search="…"&$select=…&$top=` (or `$filter` path). I: `UID SEARCH CHARSET UTF-8 …` (+`X-GM-RAW` on Gmail IMAP) + FETCH | L1–L2 | 5 + 20/miss / 1 / 2 |
| 5 | `mail_count` | wc / facets: exact counts and top-k facets | `{account, query, cap≤10000=2000, facets?: ("from"\|"fromDomain"\|"label"\|"month")[], sample≤500=200}` | Count — G: page `messages.list` ids (5 units per 500). M: `$count=true` (`$filter` path) or page `$select=id` (`$search`, ≤1,000). I: `ESEARCH RETURN (COUNT)`. Facets: run over a `sample` of rows; envelope cache first | L1–L3 | count ≤ 5·⌈n/500⌉; facets +20/miss (**warn**: a 200-row cold sample costs ~4,000 units) / count 1, facets 1–2 / 1–2 |
| 6 | `mail_read` | Read: a thread (default) or one message as clean text | `{id\|threadId, view?: "thread"\|"message", format?: "text"\|"html"\|"headers"\|"raw", quoted?: "collapse"\|"full"="collapse", offset?, length≤60000=16000, messagesFrom?: number}` | G: `threads.get(format=full)` (120 flat) or `messages.get(full)` (60). M: `GET /me/messages?$filter=conversationId eq '…'&$select=…,uniqueBody,body,internetMessageHeaders&$expand=attachments($select=id,name,contentType,size,isInline)` with `Prefer: outlook.body-content-type="text"`. I: thread join (§5.3) + `BODY.PEEK[]` per message | L1–L2 | 120 (thread) or 60 (msg); 0 on cache hit / 1–2 / 2–6 |
| 7 | `mail_grep` | grep -C: regex over bodies of a bounded set | `{ids?: string[] ≤100, query?: string, maxMessages≤100=30, pattern: string, flags?: "i"\|"m", context?: 0–5=1, maxMatches≤200=50}` | Resolve set (via `mail_search` if `query`), then bodies: G: `threads.get(full)` for threads with ≥3 hits, else `messages.get(full)`. M: **one list call** with `$select=body` (bodies come back in list pages). I: `BODY.PEEK[TEXT]<0.65536>` partial fetch. Match locally on normalized text | L2–L3 | ≤60/msg (cache hits free); a 30-message cold run ≈ 1,800 / 1–2 / 1–2 |
| 8 | `mail_attachment_read` | Read an attachment as text (or image) | `{id, attachment: name\|index\|attachmentId, pages?: "1-5", sheet?: string, maxChars≤100000=20000, asImage?: bool}` | G: `messages.attachments.get` (+ metadata if part manifest not cached). M: `…/attachments/{id}/$value`. I: `FETCH BODY[part]`. Extract locally (§2.6) | L2–L3 | 20 (+20) / 1–2 / 1 |
| 9 | `mail_changes` | git status: what arrived or changed since a cursor | `{account, cursor?: string, limit≤200=50, kinds?: ("added"\|"labelChanged"\|"deleted")[]}`. Returns `{changes: MailRow+kind, cursor}` | G: `history.list(startHistoryId, historyTypes)` + metadata for added. M: inbox (and chosen folders) `delta` links. I: `SELECT … (QRESYNC (uidvalidity modseq))` or UIDNEXT diff. Without a cursor: last watcher position | L1 | 2/page + 20/added / 1/folder / 1–2 |
| 10 | `people_lookup` | Who is this? | `{query: email\|name, account?}` | Local note + structured person (policy state) + provider evidence: G: `messages.list(q="from:x")` & `"to:x in:sent"` (id-count only, capped) + newest row. Optional People API `searchContacts`/`otherContacts.search` if scopes granted. M: `/me/people?$search="x"`, `/me/contacts?$filter=emailAddresses/any(a:a/address eq 'x')`, `$search="participants:x"` `$top=1` | L1–L2 | ~30–60 / 2–3 / 2–3 |
| 11 | `people_history` | What have we exchanged? | `{email\|personId, limit≤100=20, pageToken?, direction?: "both"\|"from"\|"to"}` | G: `q="from:x OR to:x OR cc:x"` (or `{…}`) + metadata. M: `$search="participants:x"`. I: OR'd SEARCH across INBOX + Sent | L1–L2 | 5 + 20/miss / 1 / 2–4 |
| 12 | `calendar_search` | Find events in a range, optionally by text | `{account, range: {start,end} ≤ 366d, text?: string, attendee?: string, limit≤250=50, pageToken?}` | Google `events.list(q, timeMin, timeMax, singleEvents=true, orderBy=startTime)`. Graph `calendarView` (+ client filter on subject/attendees/location). CalDAV `calendar-query` | L1 | Calendar quota 1/page / 1/page / 1 |
| 13 | `calendar_free_busy` | Busy intervals for me (and others where allowed) | `{account, range ≤ 62d, who?: string[]}` | Google `freeBusy.query`. Graph `getSchedule` (work/school), else `calendarView` merge (personal MSA). CalDAV free-busy | L1 | 1 / 1 / 1 |
| 14 | `notes_read` / `notes_search` | Read/grep agent-maintained people and matter notes | `{path}` / `{pattern, kind?: "person"\|"matter"}` | local files/rows (§4.3) | L0 | 0 |
| 15 | `provider_get` | Bash-style escape hatch, **read-only** | `{account, path: string, query?: Record<string,string>}`. Allowlist: Gmail `users/me/{messages,threads,labels,history,drafts,settings/filters,settings/sendAs}` (GET); Graph `me/{messages,mailFolders,events,calendarView,people,contacts,mailboxSettings,outlook/masterCategories}` (GET) | direct GET through the same quota governor; response clipped to budget | L1 | per method |
| 16 | `mail_export` (MCP-only, host with filesystem) | Materialize threads/attachments to files for the host's own shell | `{ids?: string[], query?: string, max≤200=50, format: "md"\|"eml", includeAttachments?: bool}` → `{dir, files[]}` | as `mail_read`/`mail_attachment_read`; writes under `<dataDir>/scratch/<session>/` (0700, swept after 24 h) | L3 | ≤60/msg |

The tools from the existing catalogue that stay **local** (`list_pending_decisions`, `list_actions`, `get_trust`,
`get_user_profile`, `get_standing_rules`, `get_daily_log`, `explain_decision`, `find_free_slots`, …) are covered in §4.

### 2.4 Write tools (all go through `ActionExecutor`, unchanged policy semantics)

The executor needs a **pre-image** of the state each write changes so it can store an inverse. Without a mirror, the
executor snapshots it from the envelope cache if fresh, otherwise from the provider (Gmail `messages.get(minimal)`
for `labelIds`; Graph `$select=parentFolderId,isRead,flag,categories`; IMAP `FETCH FLAGS`). The snapshot is
part of the write's cost.

| Tool | Action type | Class | Backing calls | Latency | Cost (Gmail / Graph / IMAP) |
|---|---|---|---|---|---|
| `label` (`remove?: bool`) | label / unlabel | RW (destructive targets escalate, as today) | G: `batchModify` (≤1,000 ids). Create label on demand (`labels.create` 5). M: categories `PATCH` per message via `$batch` (Graph "labels" = categories; folders are not labels). I: `UID STORE +FLAGS (keyword)` | L1–L2 | 50 + snapshot 20/stale id / ⌈n/20⌉ batches / 1 |
| `archive` | archive | RW | G: `batchModify(remove INBOX)`. **Default to thread scope** (`threads.modify`, 10) to match Gmail UI semantics; expose `scope: "message"\|"thread"`. M: `move` to `archive` well-known folder. I: `UID MOVE` to `\Archive` (or `[Gmail]/All Mail`) | L1–L2 | 50 or 10/thread / n / 1 |
| `move` | move | RW (trash/junk → delete ceiling, as `destinationGuard` does) | G: `batchModify(add target, remove others)`. M: `POST …/move` (new id when not immutable). I: `UID MOVE` (+`COPYUID` → new identity in `MailChangeResult`) | L1–L2 | 50 / n / 1 |
| `mark_read` / `mark_unread` / `flag` / `unflag` | same | RW | G: `batchModify(UNREAD/STARRED)`. M: `PATCH isRead/flag`. I: `STORE \Seen/\Flagged` | L1 | 50 / n / 1 |
| `snooze` | snooze | RW (Passport-side; Gmail's snooze has no API) | archive now + scheduler un-archives at `until` | L1 | as archive |
| `draft_create` / `reply_draft` | draft_create | RW (inverse = draft_delete) | G: `drafts.create` (+ `threads.get(metadata)` for reply headers). M: `createReply`/`createReplyAll` then `PATCH` (preserves Exchange threading). I: `APPEND` to Drafts | L1–L2 | 10 + 40 / 2–3 / 1–2 |
| `draft_update` | draft_update | RW | G: `drafts.update` (15). M: `PATCH`. I: `APPEND` new + expunge old | L1 | 15 / 1–3 / 2 |
| `send` | send | **IW, held in outbox** (unchanged) | G: `drafts.send` / `messages.send`. M: `POST …/send` (Graph returns 202 with no id; keep the existing draft-first approach in `graph.ts:562`). I: SMTP + APPEND to Sent | L1 | 100 / 1–2 / 2 |
| `unsubscribe` | unsubscribe | **IW** | RFC 8058 one-click `POST` to `List-Unsubscribe` HTTPS, or mailto (= a `send`) | L1 | 0–100 |
| `calendar_respond` | calendar_respond | RW-ish (re-respondable) | Google `events.patch(attendees[self].responseStatus, sendUpdates)`. Graph `accept/decline/tentativelyAccept` | L1 | 1 / 1 |
| `calendar_event_create` | calendar_create | **RW if no attendees; IW if attendees.** Invitations go out immediately. Google: control with `sendUpdates=none\|all`. Graph sends invites on create when attendees are present; create without attendees first, then `PATCH` attendees after policy release | Google `events.insert`. Graph `POST /me/events` | L1 | 1 / 1–2 |
| `propose_meeting` | calendar_propose | IW (send) | draft + send, unchanged | L1 | as send |
| `label_by_query` / `archive_by_query` | label / archive | RW, one action, `dryRun` (unchanged) | ids via `messages.list(q)` paging (5/500) → `batchModify` per 1,000 ids. Graph: page ids (`$select=id`), then `$batch` 20 per call with 4 concurrency | L2–L3 | ≈ 5·⌈n/500⌉ + 50·⌈n/1000⌉ (+ snapshot) / ⌈n/20⌉ / 2 |
| `notes_write` (person/matter) | person_update / matter_update / matter_create | RW (inverse = previous content, same pattern as `profile_update`) | local | L0 | 0 |

`delete` (permanent) and `trash` stay unexposed to external agents, as `server.ts:31` already promises.

### 2.5 `mail_read` output shape (the most important tool to get right)

```jsonc
{
  "thread": { "id": "acc:thread:18f…", "subject": "Lease renewal", "messageCount": 7,
              "participants": ["Dana Ruiz <dana@acme.com>", "me"] },
  "messages": [
    { "id": "acc:email:18f…", "rfc822Id": "<CA+…@mail.gmail.com>",
      "date": "2026-10-20T14:03:00Z", "from": "Dana Ruiz <dana@acme.com>",
      "to": ["me"], "cc": [], "labels": ["INBOX"], "unread": true,
      "auth": { "dmarc": "pass", "dkim": "pass", "spf": "pass", "passport": "green" },
      "text": "Hi — attached is the renewal…\n\n[quoted 42 lines from 2026-10-18 collapsed; quoted:\"full\" to expand]",
      "attachments": [{ "index": 0, "name": "lease.pdf", "type": "application/pdf", "size": 182344 }],
      "listUnsubscribe": null }
  ],
  "truncated": false, "continueFrom": null,
  "source": "provider", "cost": { "gmailUnits": 120, "budgetRemaining": 5380 }
}
```

Rules:
- **Order is chronological.** For long threads, return the **last 5 messages in full and earlier ones as one-line
  headers** unless `messagesFrom` is given. This mirrors how `Read` defaults to the start of a file, except
  email is read from the end.
- **Quoted history collapse** has two layers:
  1. Provider help: Graph `uniqueBody` (Exchange-computed, reliable for Outlook-to-Outlook mail).
  2. Local heuristics in `packages/providers/src/normalize/`: `<div class="gmail_quote">`,
     `<blockquote type="cite">`, `#divRplyFwdMsg` / `#appendonsend` (Outlook), `On … wrote:` lines in
     ~10 locales, `-----Original Message-----`, `From: … Sent: … To: … Subject:` blocks, runs of `>` lines.
     Add **thread-aware dedup**: when the agent reads a whole thread, drop any trailing block that is an
     exact or near-exact (normalized whitespace) suffix of an earlier message in the same response.
- **Signature stripping** is optional (`-- \n` delimiter, mobile footers). Default off: signatures carry phone
  numbers and titles that agents use.
- Remote images and beacons are still stripped (existing behaviour). Links are kept as `text (host)`. Token-bearing
  URLs are shortened to the host unless `format:"html"`.

### 2.6 `mail_attachment_read` scope

| Type | Library (pure JS/WASM, satisfies CONTRACT "no native modules") | Output |
|---|---|---|
| `text/*`, `.csv`, `.json`, `.md` | built-in (charset detection via existing normalize) | text, `maxChars` window |
| `application/pdf` | `pdfjs-dist` (text layer) | text per page, `pages` range. Report `scanned: true` when a page has no text layer |
| `.docx` | `mammoth` (raw text) | text |
| `.xlsx`/`.xls`/`.ods` | `xlsx` (SheetJS) | per-sheet CSV, `sheet` + row window |
| `.pptx` | unzip + XML text (`fflate`) | slide text |
| `text/calendar` (`.ics`) | existing `caldav-ical.ts` parser | structured event summary |
| `message/rfc822` | existing `normalizeMime` | nested `mail_read` shape |
| `image/*` ≤ 2 MB | none (pass through) | **MCP `image` content block** so Claude/Codex read it natively. Built-in agent gets a "binary image, N bytes" note unless its LLM is multimodal |
| Graph `referenceAttachment` | — | `{ cloudLink: host only }` with `NOT_DOWNLOADABLE` |

**OCR (scanned PDFs, image text for non-multimodal models) is out of scope for v1.** `tesseract.js` is
WASM and works, but it adds 10–30 s per page and roughly 15 MB of language data. Revisit only if the built-in agent's
default model cannot see images. Hard limits: 25 MB download, 200 pages, 50k rows. Extraction runs in a
`worker_thread` with a 20 s timeout. Treat extracted text as untrusted data (same rule as bodies).

---

## 3. Where a cache is still justified

### 3.1 Options

| Option | State kept | Build cost | Pros | Cons |
|---|---|---|---|---|
| **(a)** Nothing but credentials + action log | creds, action log, outbox, cursors | 0 | Smallest attack surface. Nothing goes stale | Every listing costs 20 Gmail units per row. Policy pre-images always hit the provider. No offline at all. Re-reading the same thread burns 120 units each time |
| **(b)** Metadata-only index (headers, labels, threadIds; no bodies) | ~1 KB/message | Gmail: **~400k units ≈ 67 min at 100% quota** for 20k messages. Graph: 20–80 requests, **~1–2 min**. IMAP: one `FETCH 1:* (ENVELOPE …)`, ~20 MB, **~1–3 min** | Instant faceting and people graph. Sort and filter offline | On Gmail it is a backfill under another name and blocks the quota for an hour or more. Must be kept consistent (history expiry ⇒ reconcile). Duplicates what Gmail search already does well |
| **(c)** Lazy read-through cache keyed by message id, TTL | what the agent or triage touched | 0 up front | Pays only for what is used. Repeat reads are free | Cold facets stay expensive. Cache validity needs rules |

**Cost of (b) for a 1-year, 20k-message Gmail mailbox:**

```
ids:       messages.list, 500/page → 40 pages × 5 units           =       200 units
metadata:  20,000 × messages.get(format=metadata) × 20 units       =   400,000 units
                                                            total ≈   400,200 units
at 6,000 units/user/min (100% of quota, nothing left for the agent) ≈ 66.7 min
at a polite 50% budget (keep half for interactive use)             ≈ 133 min
batching: 50 calls/batch → 400 HTTP batches; 6 batches/min at full quota
alternative via threads (avg 2.5 msgs/thread → 8k threads):
           8,000 × threads.get(metadata) 40 + 16 × threads.list 10 ≈ 320,160 units ≈ 53 min
for comparison, today's full mirror (format=full, 60 units)        ≈ 1.2M units ≈ 200 min
```

On Graph, (b) is nearly free (10,000 requests / 10 min / mailbox, and one request returns up to 1,000
rows). On Gmail it is the expensive operation the redesign exists to avoid. Gmail IMAP could build (b) in a
couple of minutes with `X-GM-THRID`/`X-GM-LABELS`, but it requires the full `https://mail.google.com/` scope,
which is broader than `gmail.modify`. Note it as an option and do not adopt it by default.

### 3.2 Recommendation: **(c+) envelope cache + body LRU**

Envelope fields are **immutable** for a given message id in Gmail and in Graph (with immutable ids): from, to, cc, subject,
date, Message-ID, References, List-*, Authentication-Results, size, attachment manifest, snippet.
Labels, flags and folder are **mutable**. So:

```sql
-- one row per message the agent, triage or a write has touched
CREATE TABLE envelope (
  account_id      TEXT NOT NULL,
  provider_id     TEXT NOT NULL,
  thread_pid      TEXT NOT NULL,           -- Gmail threadId / Graph conversationId / IMAP thread key
  rfc822_id       TEXT,
  received_at     TEXT NOT NULL,
  from_addr       TEXT NOT NULL, from_name TEXT,
  to_json         TEXT NOT NULL, cc_json TEXT NOT NULL,
  subject         TEXT NOT NULL,
  snippet         TEXT NOT NULL,
  headers_json    TEXT NOT NULL,           -- list-id, list-unsubscribe(-post), auth-results, in-reply-to, references
  attachments_json TEXT NOT NULL,          -- [{name,type,size,blobId,partId}]
  verification_json TEXT NOT NULL,         -- computed once from headers (blue/green)
  labels_json     TEXT NOT NULL,           -- MUTABLE
  flags_json      TEXT NOT NULL,           -- MUTABLE: unread, flagged
  labels_fresh_at TEXT NOT NULL,           -- last time mutable state was confirmed
  touched_at      TEXT NOT NULL,           -- LRU
  PRIMARY KEY (account_id, provider_id)
);
CREATE INDEX envelope_rfc822 ON envelope(account_id, rfc822_id);
CREATE INDEX envelope_thread ON envelope(account_id, thread_pid);
CREATE INDEX envelope_from   ON envelope(from_addr, received_at);

-- bodies: separate, encrypted with the store key, TTL 7 days, cap 200 MB, LRU eviction
CREATE TABLE body_cache (
  account_id TEXT, provider_id TEXT, text_enc BLOB, html_enc BLOB,
  fetched_at TEXT, PRIMARY KEY (account_id, provider_id)
);
```

Rules:
1. **Fill-on-touch.** Any tool that fetches metadata or bodies writes the envelope (and the body, if fetched).
   `mail_list`/`mail_search` then skip `messages.get` for ids whose envelope exists **and** whose
   `labels_fresh_at` is newer than the last change-watcher tick that could have touched them.
2. **Keep mutable state fresh with the watcher, not by refetching.** `history.list` already returns
   `labelsAdded/labelsRemoved/messagesDeleted` for *every* message (2 units/page), so the watcher patches
   `labels_json` for cached ids and ignores the rest. Graph `delta` per watched folder and IMAP `CONDSTORE`
   do the same. If the watcher loses its cursor (404/410), mark every envelope's labels stale. Do **not**
   resync. The next read revalidates lazily.
3. **Eviction.** Envelopes are small (~1–1.5 KB). Keep up to 100k or 18 months of `touched_at`, then LRU.
   Bodies use TTL + size cap. **No FTS5 table over bodies.** A small FTS index over envelope subject/from
   is acceptable for "the thing I looked at yesterday", but search goes to the provider by default.
4. **Optional per-account "deep index" job** (option b), off by default. It runs at ≤30% of quota (1,800 units/min
   → 20k messages in ~3.7 h), only when the user explicitly wants people-graph analytics, and it uses the same envelope table. On Graph
   and JMAP accounts it can be on by default for the last 90 days because it costs a handful of requests.

What else stays local: **credentials** (encrypted, unchanged), **action log + outbox + trust** (unchanged),
**change cursors** (`syncState` keeps its shape), **notes for people and matters** (§4.3), **USER.md**, and the
**structured person security state** (relationship, verification, `lastSeenBlueAt`, `verifiedSelf`,
`downgradeAcknowledgedAt`). Policy reads that state, so it must not live in free-form notes.

### 3.3 Proactive work without a mirror

```
            ┌──────────────── per account watcher (apps/server, owner process only) ───────────────┐
 Gmail:     │ every 30 s (or on Pub/Sub pull message): history.list(startHistoryId=cursor,          │
            │   historyTypes=messageAdded,labelAdded,labelRemoved,messageDeleted)  → 2 units/page   │
 Graph:     │ every 30 s: GET inbox deltaLink (+ any folders with standing rules) → 1 req/folder    │
 IMAP:      │ IDLE on INBOX (fallback: STATUS UIDNEXT HIGHESTMODSEQ every 60 s)                      │
            └──────────────┬────────────────────────────────────────────────────────────────────────┘
                           │ added ids (INBOX, not from self, not already in action log)
                           ▼
            envelope fetch (metadata, 20 units) → verification (headers only) → people state update
                           ▼
            arrival queue (existing apps/server/src/arrivals.ts, durable kv entries) → wake agent
                           ▼
            triage agent uses the same tool belt (mail_read only if it needs the body: +60 units)
```

- **Gmail polling cost:** 2 units × 120 polls/hour = 240 units/hour, about 0.07% of hourly quota. A 100-message/day
  inbox adds ~2k units/day of metadata, plus ~6k if every message's body is read. **Prefer polling first.**
  `users.watch` + Pub/Sub **pull** works without a public endpoint, but each user needs a Pub/Sub topic in
  their own GCP project (BYO OAuth client makes this possible), an IAM grant to
  `gmail-api-push@system.gserviceaccount.com`, and a Pub/Sub scope. Ship it later as an opt-in latency upgrade.
  Notifications carry only `historyId`, so you still call `history.list`.
- **Graph:** webhooks require a public HTTPS URL, which a desktop app lacks. T3 Connect-style relays could
  provide one later. Poll `delta` with `changeType=created` on the inbox. That is 20 requests per 10 min.
- **Cursor loss is cheap now.** If `history.list` returns 404 or `delta` returns 410, set the cursor to "now"
  (`getProfile.historyId` / a fresh delta round with `$filter=receivedDateTime ge {lastSeen}`), then run one
  bounded sweep: `q="in:inbox newer_than:2d"` (Gmail) or the `$filter` window (Graph). Diff against
  arrival/action-log ids so nothing is triaged twice. This removes the CONTRACT's
  cursor-expiry reconciliation and tombstone machinery (`CONTRACT.md:84-91`), because no mirror needs reconciling.
- **Startup:** set the cursor to "now" on first connect. Do not backfill. **The agent is usable at second 0.**
  Today it is blocked until the initial sync finishes, which takes hours on Gmail.

---

## 4. How this changes the existing tool catalogue

Today the catalogue has 44 tools in `@passport/tools`. Every mail/calendar read uses `Store`. Policy (`policy.ts:262`) and the executor
(`executor-mail.ts`, `executor-context.ts`, `executor-dispatch.ts`, `executor-restoration.ts`) read and write
`store.emails`/`store.mailboxes` for pre-images, counterparty and destination checks.

### 4.1 Disposition table

| Existing tool | Disposition | New backing / name |
|---|---|---|
| `search_emails` | **Re-backed + renamed** | `mail_search` (provider query; portable or raw). Drop FTS5 `EmailQuery.text` |
| `get_email` | **Merged** | `mail_read({id, view:"message"})` |
| `get_email_body` | **Merged** | `mail_read` `offset/length/continueFrom` (keep the UTF-16 offset semantics) |
| `get_thread` | **Re-backed** | `mail_read({threadId})` via `threads.get` / conversationId filter |
| `list_mailboxes` | **Re-backed + renamed** | `mail_labels` |
| `summarize_thread` | **Re-backed** | Keep as `mail_read({view:"summary"})` or keep the name. It runs the existing LLM-free logic over provider data |
| `list_recent_from_person` | **Re-backed + renamed** | `people_history({direction:"from"})` |
| `search_people` / `list_people` / `get_person` | **Replaced** | `people_lookup` (notes + structured security state + provider contacts + mail evidence). `list_people` becomes `notes_search({kind:"person"})` |
| `list_matters` / `get_matter` | **Re-backed** | Notes-backed (§4.3). `get_matter` resolves refs lazily |
| `list_events` | **Re-backed + renamed** | `calendar_search` (provider; text filter added) |
| `free_busy` | **Re-backed** | `calendar_free_busy` (the existing `freeBusy` resolver path becomes the only path) |
| `find_free_slots` | **Unchanged logic** | Computes over provider intervals from `calendar_free_busy`. Recurrence expansion is no longer needed because providers expand (`singleEvents=true`, `calendarView`) |
| `preview_unsubscribe` | **Unchanged logic, re-backed input** | Reads `List-Unsubscribe(-Post)` from the envelope (fetch if missing) |
| `list_pending_decisions`, `list_actions`, `get_trust`, `get_user_profile`, `get_standing_rules`, `get_daily_log`, `explain_decision` | **Unchanged** | Local policy and audit state |
| `undo_action`, `cancel_held_action`, `add_standing_rule`, `remove_standing_rule` | **Unchanged** | Local |
| `archive_emails`, `label_emails`, `mark_read`, `move_emails` | **Same names OK; re-backed internals** | Accept passport handles, resolve pre-images via envelope cache/provider. Gmail → `batchModify`. Add `scope:"thread"` |
| `create_draft`, `reply_draft`, `send`, `unsubscribe`, `respond_to_event`, `propose_meeting`, `snooze` | **Unchanged surface** | Reply context comes from the provider. `send` stays outbox-held |
| `batch_archive_by_query`, `apply_label_by_query` | **Re-backed** | Query is a provider query string. Ids paged server-side. The 200-cap can rise to 1,000 (one `batchModify`) |
| `create_matter`, `update_matter`, `attach_to_matter`, `update_person` | **Re-backed** | Write notes and structured person state. `attach_to_matter` stores **refs** `{account, providerId, rfc822Id, threadPid, subject, date}`, not mirror row ids |
| — | **New** | `mail_list`, `mail_count`, `mail_grep`, `mail_attachment_read`, `mail_changes`, `mail_accounts`, `provider_get`, `mail_export`, `notes_read`/`notes_search`/`notes_write`, `calendar_event_create` (exposes `calendar_create`, which exists as an ActionType but has no tool today) |
| — | **Removed concepts** | FTS5 email index, full-body mirror, provider-tombstone (`$deleted`) semantics and `includeDeleted`, cursor-expiry reconciliation, windowed-snapshot rules |

### 4.2 Migration seam (keeps policy and executor nearly untouched)

The fastest safe path is **not** to rewrite policy or executor against provider calls. Instead:

1. Introduce `MailReader` in `@passport/types` (append-only; matches the "add, don't rename" rule):

   ```ts
   export interface MailQueryPage { rows: MailRow[]; nextPageToken?: string; approxTotal?: number }
   export interface MailReader {
     search(q: { query?: string; rawQuery?: string; container?: string; limit: number;
                 pageToken?: string; includeSpamTrash?: boolean; threads?: boolean }): Promise<MailQueryPage>;
     envelopes(providerIds: string[]): Promise<Map<string, Email /* bodies omitted */ | null>>;
     thread(threadProviderId: string, opts: { format: "text" | "html" }): Promise<Email[]>;
     body(providerId: string): Promise<Pick<Email, "textBody" | "htmlBody" | "attachments">>;
     countIds(query: string, cap: number): Promise<{ count: number; capped: boolean }>;
     changes(cursor: string | null, limit: number): Promise<{ added: string[]; labelChanged: string[];
                                                              deleted: string[]; cursor: string }>;
     findByRfc822(rfc822Id: string): Promise<string | null>; // providerId
   }
   export interface MailProvider { reader?(): MailReader } // optional; mock implements it first
   ```

2. Re-implement `Store.emails.get/getByProviderId` as **read-through**: envelope cache → `MailReader.envelopes`
   → upsert. `Store.emails.query` remains for cache-only uses. Tools stop using it for search.
   `policy.ts:262` (destructive-risk check on unread/flagged) and the executor's pre-image reads then work
   unchanged, as long as the cache treats any mutable state older than the last watcher tick as stale. Pass a
   `fresh: true` option on executor pre-image reads so they always revalidate labels before computing an inverse.
3. `Store.mailboxes` becomes a cached copy of `mail_labels`, refreshed on demand and by `labels.list` (1 unit)
   at watcher startup. `destinationGuard` keeps working.
4. Delete the sync service's full-mirror path in `apps/server/src/sync/`. Keep the watcher and arrivals queue.

### 4.3 People and matters as agent-maintained notes

Today `Person.stats`, `Matter.emailIds`, `Email.matterId` and `personIds` are derived over the mirror. Without one,
split each unit into **security state** (structured, executor-owned) and **knowledge** (free text, agent-owned),
following the CLAUDE.md / memory-file pattern:

```markdown
<!-- notes/people/dana@acme.com.md -->
---
emails: [dana@acme.com, d.ruiz@acme.io]
displayName: Dana Ruiz
# relationship, verification, verifiedSelf, lastSeenBlueAt live in the structured people table, not here
---
Leasing manager at Acme Properties (building on 5th). Prefers email, replies within a day.
Renewal is annual in November; last year we negotiated 3%.
- 2026-10-20: sent renewal PDF (acc:email:18f…), asked for signature by Nov 1.
```

```markdown
<!-- notes/matters/lease-renewal-2026.md -->
---
status: waiting
kind: housing
dueAt: 2026-11-01T00:00:00Z
people: [dana@acme.com]
refs:
  - { account: acc1, providerId: 18f2…, rfc822Id: "<CA+…@mail.gmail.com>", thread: 18f1…, date: 2026-10-20, subject: Lease renewal }
events: [{ account: cal1, providerId: 7k3… }]
---
## Where things stand
Dana sent the renewal at +3.5%; we want ≤3%.
## Next step
Reply with counter at 3% before Oct 28.
## Log
- 2026-10-20 renewal received
```

- Storage: keep them in SQLite (`notes(kind, key, frontmatter_json, body, updated_at)`) or as files under
  `<dataDir>/notes/`. Files are nicer for host agents (they can `Read` them via `mail_export`'s dir).
  SQLite keeps the existing encrypted-store story. Either way, **writes are `person_update` / `matter_update`
  actions in category `matters`, with the prior content as the inverse.** This is the `profile_update`
  pattern, already implemented for USER.md.
- **Derived numbers become on-demand queries.** `stats.sent/received/lastContactAt` → `people_lookup` runs
  `countIds("from:x")`, `countIds("to:x in:sent")` (5 units per 500 ids) and caches the result in the
  structured person row with a timestamp. A matter's thread list comes from its `refs`. "New mail on this matter"
  is a saved query in frontmatter (e.g. `watch: "from:dana@acme.com newer_than:30d"`) that the triage agent checks
  on arrival.
- **Counterparty class** for policy (`self | blue | green_known | stranger | service`) needs only: account/self
  addresses, human-approved contacts, and "have we ever sent to this address?" The last one is one
  `countIds("to:x in:sent", cap 1)` (5 units on Gmail), cached on the person row. The arrival watcher updates
  `lastSeenBlueAt` from headers it already fetched.

---

## 5. Failure modes

### 5.1 Rate limiting: telling the agent to slow down

- **Client-side governor per account, before the provider says no.** It holds a token bucket mirroring the real limits:
  Gmail 6,000 units/min (refill 100/s, burst ≤1,500), Graph 1,000 req/min and **4 in flight per mailbox**,
  IMAP 1 command pipeline per connection. Every adapter call declares its unit cost from §1.3.
  There are three **priority lanes**: interactive tool calls > arrival triage > deep index/warm-up. Background lanes may use
  at most 30% of the bucket while an interactive call is waiting.
- **Respect provider signals.** Gmail 403 `rateLimitExceeded`/`userRateLimitExceeded` and 429 (already detected in
  `http.ts:22-36`). Graph 429 `Retry-After`, and back off proactively when `x-ms-throttle-limit-percentage ≥ 0.9`.
- **Don't block a tool call for a minute.** `http.ts` currently retries GETs for 2+4+8+16+32 s. That suits
  background sync, but it outlasts MCP client tool timeouts and leaves the model idle. For the interactive lane, retry
  silently only when the wait is ≤5 s. Otherwise return a structured, non-fatal result:

  ```json
  { "isError": true, "error": "RATE_LIMITED", "retryAfterSeconds": 24, "scope": "gmail:user-quota",
    "partial": { "items": [ /* rows already fetched or served from cache */ ], "source": "mixed" },
    "hint": "Quota for this account resets in ~24s. Narrow the query, lower limit, or use rows already returned." }
  ```

  Add `cost.budgetRemaining` to *every* successful result (§2.2) so agents see the limit coming.
- **Cap expensive shapes up front.** `mail_count` facets with a cold sample >200, or `mail_grep` with >30 cold messages,
  return `{"error":"WOULD_EXCEED_BUDGET","estimatedUnits":…,"hint":"…"}` unless `confirmCost: true`.

### 5.2 Stale ids after moves/deletes

| Provider | Id stability | Recovery |
|---|---|---|
| Gmail | `id` stable across label changes. Gone only on permanent delete (404) | 404 → `rfc822msgid:` lookup (5 + 20 units), else `NOT_FOUND` |
| Graph | Stable across folder moves **with `IdType="ImmutableId"`**. Changes on move to archive mailbox / cross-mailbox | 404 → `$filter=internetMessageId eq '…'` → rewrite handle, return `{"idChanged": {"from":…, "to":…}}` |
| IMAP | `(mailbox, UIDVALIDITY, UID)` changes on every move. UIDVALIDITY reset invalidates all | `OBJECTID` `EMAILID` if advertised. Else `UID SEARCH HEADER Message-ID "<…>"` in likely mailboxes (Archive/All Mail, Sent, INBOX, recent move target from action log) |

Every handle and every matter ref carries `rfc822Id`, so recovery is automatic. Duplicate Message-IDs exist
(the same mail in Sent and Inbox; mailing-list copies). When `rfc822msgid:` matches more than one, prefer the same
`threadPid` and the non-SENT copy, and report `ambiguous: true` instead of guessing for writes.
Executor writes never auto-rebind silently. They fail with `STALE_ID` plus the candidate, and policy re-evaluates.
`policy/src/rebinding.test.ts` suggests that path partly exists.

### 5.3 Gmail `threadId` vs Graph `conversationId` vs IMAP threads

- **Gmail threadId:** Gmail's own grouping (References/In-Reply-To + similar subject), per user, one thread per
  message, spans labels and SENT. Labels are per message, but the UI acts per thread, hence `archive` defaults to
  `threads.modify`. Threads have a size cap (Gmail starts a new conversation after ~100 messages; treat as approximate).
- **Graph conversationId:** Exchange conversation (derived from the conversation topic/index), spans folders
  including Sent Items. A subject change can fork a new conversation. There is no `threads.get`: fetch with
  `$filter=conversationId eq '…'` and sort client-side. Outlook "conversation" ≠ Gmail thread for the same
  exchange. Never compare thread ids across accounts. Matters key on `rfc822Id` + `References`, not on thread ids.
- **IMAP:** `THREAD=REFERENCES` is per mailbox, so it misses your replies in Sent. Build threads client-side
  by fetching `Message-ID/In-Reply-To/References` headers from INBOX + Sent (+ Archive) for the window
  around the message, using `SEARCH HEADER References "<id>"` / `HEADER In-Reply-To "<id>"`. Gmail IMAP: use `X-GM-THRID`.
  `OBJECTID` servers: `THREADID`.
- The tool contract exposes `threadId` as an opaque, **account-scoped** handle and documents that thread
  boundaries are provider-defined.

### 5.4 HTML-to-text quality

- Prefer the sender's `text/plain` alternative when present and not "this email requires HTML". Detect
  placeholder plain parts (<200 chars with "view in browser"/"HTML") and fall back to HTML conversion.
- On Graph use the server conversion (`outlook.body-content-type="text"`) for `body`/`uniqueBody`. It is decent
  and saves a dependency for that provider.
- Local conversion (existing `htmlToText` in `normalize/`): keep paragraph and list structure, render tables as
  `col | col` rows (receipts and invoices depend on this), drop `display:none`/`mso-hide` preheaders, collapse
  tracking-link URLs to `text (host)`, and decode entities. Add a fixture corpus (Gmail, Outlook, Apple Mail, Mailchimp,
  Stripe receipt, calendar invite) with golden outputs to `packages/providers/src/fixtures/`.
- Always return `format:"html"` (sanitized) as an option so the agent can recover when text conversion fails.

### 5.5 Large result sets

- Default `limit` 25, max 100. Always return `nextPageToken` and an *approximate* total labelled as such.
  `mail_count` gives the exact number.
- Response budget: Claude Code warns above ~10k tokens of MCP output and truncates at a configurable max (25k by default;
  see [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)). The current 512 KiB `responseByteBudget` is
  far above that. **Default the MCP budget to ~64 KiB** (~16k tokens) and keep 512 KiB for the built-in agent if wanted.
- For "do X to all 3,000 newsletters": `archive_by_query` with `dryRun` → count + sample → one action that
  pages ids server-side (Gmail `batchModify` per 1,000). Never route thousands of ids through the model.
- Graph `$search` stops at 1,000. When `approxTotal` hits that ceiling, return `capped: true` and suggest a date-sliced
  query (`received>=…`) or the `$filter` path.

### 5.6 IMAP servers with weak SEARCH

- Capability-probe on connect (`CAPABILITY`: ESEARCH, SORT, THREAD=REFERENCES, CONDSTORE, QRESYNC, OBJECTID,
  X-GM-EXT-1, MOVE, IDLE, NOTIFY) and store it in `Account.settings`. Tools report what they used.
- `TEXT`/`BODY` search is often substring-only, ASCII-only, or very slow on large folders. Some servers do not
  index bodies at all. Strategy: push **cheap, universally supported keys** to the server (`SINCE`, `BEFORE`,
  `FROM`, `TO`, `SUBJECT`, flags), cap the candidate set (default 500 newest), then run the body predicate as a
  local `mail_grep` over `BODY.PEEK[TEXT]<0.65536>` partials. Return `{"searchMode":"server+localGrep","scanned":500,"capped":true}`.
- Without SORT: `UID SEARCH` then sort by UID descending (an arrival-order approximation). Without ESEARCH: count by
  UID list length.
- Without CONDSTORE: change detection = UIDNEXT plus a periodic UID-list diff (what `imap.ts` already does).

### 5.7 Offline operation

With no mirror, offline is **degraded by design**, and the UI and tools say so:
- Reads: serve from the envelope cache and body LRU with `source:"cache"` and `staleAsOf`. `mail_search` offline
  runs a local match over cached envelopes (subject/from/snippet) and states that it is partial.
  Notes, USER.md, the action log and trust work fully.
- Writes: the executor still decides policy offline. Approved writes wait as `held`/`queued` and execute on
  reconnect **after re-validating pre-images**. If labels changed meanwhile, recompute the inverse or re-ask
  the human for destructive changes. `send` keeps its outbox hold. Release happens only online.
- Proactive work resumes from the stored cursor. If it expired while offline, run the bounded sweep in §3.3.
- This gives up a v0.2 property ("search everything offline"). It should be an explicit product decision. The quota
  numbers in §3.1 make the trade clear.

---

## 6. Implementation order (one week)

1. **Day 1:** `MailReader` contract + mock implementation + governor (`packages/providers/src/quota.ts`, unit
   costs from §1.3, lanes, `cost` accounting). Make the interactive lane's retry bounded.
2. **Day 2:** Gmail `MailReader` (list/search with metadata batch via `/batch/gmail/v1`, `threads.get`,
   `countIds`, `history.list` changes, `rfc822msgid` lookup, `batchModify` in `applyChanges`).
3. **Day 3:** Graph `MailReader` (`$search` vs `$filter` translator, conversation fetch, `uniqueBody` + text Prefer,
   delta changes, internetMessageId lookup, `$batch` with 4-concurrency). IMAP: capability-driven search + local grep.
4. **Day 4:** envelope cache + body LRU in `@passport/store`. Read-through `Store.emails.get`. Watcher replaces
   sync. Arrivals queue fed by `changes()`.
5. **Day 5:** tools: `mail_search`, `mail_list`, `mail_read`, `mail_changes`, `mail_count`, `mail_grep`. Re-back
   existing read tools as aliases for one release. Default MCP response budget to 64 KiB.
6. **Follow-up:** `mail_attachment_read` (pdfjs/mammoth/SheetJS in a worker), notes-backed people/matters,
   `provider_get` allowlist, `mail_export`, Gmail Pub/Sub pull opt-in, deep-index opt-in.

Scope changes to flag for product: People API (`contacts.readonly`, `contacts.other.readonly`) and Graph
`People.Read`/`Contacts.Read` are **optional** additions. `people_lookup` works without them using mail evidence.
Gmail full IMAP scope is **not** recommended.

---

## Sources

- Gmail API usage limits and per-method quota units (updated 2026-10-16): https://developers.google.com/workspace/gmail/api/reference/quota
- Gmail search operators: https://support.google.com/mail/answer/7190
- Gmail `messages.list`: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
- Gmail sync (history validity, 404 → full sync): https://developers.google.com/workspace/gmail/api/guides/sync
- Gmail push notifications (watch, Pub/Sub pull/push, 1 event/s, 7-day renewal): https://developers.google.com/workspace/gmail/api/guides/push
- Gmail batch requests (100 max, ≤50 recommended, n calls = n quota): https://developers.google.com/workspace/gmail/api/guides/batch
- Gmail IMAP extensions: https://developers.google.com/workspace/gmail/imap/imap-extensions
- Google People API contacts / searchContacts warmup: https://developers.google.com/people/v1/contacts
- Google Calendar freeBusy.query: https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query
- Microsoft Graph throttling limits (Outlook: 10,000 req/10 min, 4 concurrent, 150 MB/5 min; batching behaviour): https://learn.microsoft.com/en-us/graph/throttling-limits
- Microsoft Graph `$search` (messages ≤1,000 results, KQL properties; people search): https://learn.microsoft.com/en-us/graph/search-query-parameter
- Microsoft Graph list messages (`$top` 1–1000, filter+orderby rules, `outlook.body-content-type`): https://learn.microsoft.com/en-us/graph/api/user-list-messages
- Microsoft Graph message delta (per folder, limited `$filter`/`$orderby`, no `$search`): https://learn.microsoft.com/en-us/graph/api/message-delta
- Microsoft Graph subscriptions (HTTPS notificationUrl, 10,080-min max for messages, latency): https://learn.microsoft.com/en-us/graph/api/resources/subscription
- Microsoft Graph JSON batching (20 requests, per-request 429): https://learn.microsoft.com/en-us/graph/json-batching
- Microsoft Graph getSchedule (not supported for personal accounts; 1,000-entry error): https://learn.microsoft.com/en-us/graph/api/calendar-getschedule
- Microsoft Graph immutable ids: https://learn.microsoft.com/en-us/graph/outlook-immutable-id
- `$search` + `$filter`/`$orderby` incompatibility (community/Q&A): https://learn.microsoft.com/en-us/answers/questions/1184920/is-there-a-microsoft-graph-api-to-filter-and-searc , https://cli.nylas.com/guides/microsoft-graph-mail-query , https://learn.microsoft.com/en-us/answers/a/658420
- IMAP: RFC 9051, 3501, 4731, 5256, 7162, 2177, 5465, 8474, 6851, 9394 (https://www.rfc-editor.org/rfc/rfcNNNN). JMAP Mail RFC 8621.
- Claude Code MCP output limits: https://code.claude.com/docs/en/mcp

### Verification notes

- Verified against fetched docs on 2026-10-22: Gmail quota numbers and method costs, Gmail operators, Gmail
  batch/push/sync rules, Graph Outlook throttling, `$search` 1,000 cap, list `$top` range, delta restrictions,
  subscription lifetimes, `$batch` 20 limit, getSchedule personal-account exclusion, Google freeBusy limits.
- From community sources, not official docs: Graph `$search` cannot combine with `$filter`/`$orderby` (consistent
  across sources and with observed 400s), and the ~250-result/no-`$skip` behaviour.
- From prior knowledge, not re-fetched; spot-check while implementing: Graph `uniqueBody` semantics,
  `internetMessageId` filter, Google `events.list` `q` field coverage, Gmail's ~100-message thread cap, Claude Code's exact
  MCP token thresholds, and whether `/me/people` works for personal Microsoft accounts.
