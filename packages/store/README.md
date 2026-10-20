# @passport/store

Reference implementation of every `Store` repository from `@passport/types`, using
Node's built-in `node:sqlite` (`DatabaseSync`, FTS5, JSON1). Also exports monotonic
ULIDs, `nowIso`, `StoreError`, and the synchronous `InMemoryEventBus`. No native
addons or runtime dependencies beyond `@passport/types`.

```ts
import { openStore, newId, nowIso, InMemoryEventBus } from "@passport/store";

// Set PASSPORT_MASTER_KEY to a strong secret before opening a persistent store.
const store = openStore({ path: "./passport.sqlite" });
await store.migrate(); // Required; safe to call again, including after reopening.
await store.kv.set("USER.md", "Prefer concise replies.");
const page = await store.emails.query({ text: '"project update" OR schedul*', limit: 20 });
const next = page.nextCursor
  ? await store.emails.query({ text: '"project update" OR schedul*', limit: 20, cursor: page.nextCursor })
  : null;
const bus = new InMemoryEventBus();
const unsubscribe = bus.on("email.updated", event => console.log(event.emailId));
bus.emit({ type: "email.updated", emailId: newId() });
unsubscribe();
await store.kv.set("lastOpenedAt", nowIso());
await store.close();
```

`openStore({ path: ":memory:" })` is useful for tests. Every lifecycle and repository
method is async, although SQLite operations run synchronously. The caller creates
parent directories, owns the store lifetime, and awaits `migrate()` before use.
Migrations are ordered SQL strings tracked atomically in `schema_version`.
Persistent databases use WAL, a 5-second busy timeout, and foreign keys for owned
join rows. Relationships may reference records that have not synced yet.

Credentials use AES-256-GCM, fresh 96-bit nonces, 128-bit authentication tags, and
the account ID as authenticated associated data. A versioned binary envelope is
the only credential value stored. Supply `masterKey` explicitly or set
`PASSPORT_MASTER_KEY`; the explicit option takes precedence. Nonempty key strings
are derived into 256-bit keys using scrypt with the fixed namespace salt
`passport/store/aes-256-gcm/v1`. Use a strong, randomly generated secret. No key is
persisted in the database. A file-backed store fails immediately without a key;
an in-memory store may generate an ephemeral one. Decryption with the wrong key,
a moved blob, or damaged ciphertext throws `CREDENTIAL_DECRYPTION_FAILED`.
Keep the same key across restarts; key rotation is not part of the Store API.

Email lists omit both bodies unless `includeBodies: true`; `get()` and provider-ID
lookup include them by default. Metadata-only upserts preserve existing bodies;
explicit `null` clears them. Full email and event upserts replace other fields.
`patchMany` replaces supplied fields, including the complete keywords object and
membership arrays. Undefined patch properties and missing IDs in patch/delete
batches are ignored. Nested values
remain JSON; queried IDs, dates, categories, statuses, and action metadata use
indexed scalar columns. Bodies are separate columns to avoid loading them in lists.

Email search accepts FTS5 `MATCH` syntax, including phrases, prefixes, boolean
operators, and field qualifiers `subject:`, `from:`, `preview:`, and `textBody:`.
The index includes sender names/addresses, and updates/deletes are maintained by
triggers inside the writing transaction. Blank search text means no text filter;
malformed FTS syntax rejects the query. Keyword `has` means a JSON value of `true`;
`not` accepts absent or false keywords. `after`/`before` are exclusive UTC timestamp
bounds. `matterId: null` selects unassigned emails; omitting it does not filter.

Email pagination orders by `(receivedAt, id)` in the requested direction. Action
pagination orders by `(createdAt, id)` descending. Both use opaque base64url
cursors, default to 50 results, and return the total matching the filters before
the cursor. Keep filters and sort unchanged between pages; changing the sort or
passing a malformed cursor throws `INVALID_CURSOR`. Limits must be positive safe
integers. Paging is a live view, not a database snapshot across requests.
Event ranges select overlaps of half-open intervals `[start, end)` and default to
50 rows. People and matter text filters are literal, case-insensitive SQLite
substring searches over names/email/notes and title/summary respectively.

Email/event matter IDs and matter memberships stay synchronized in both
directions; each email or event belongs to at most one matter. Deleting a record
cleans its memberships; deleting a matter clears member records' matter IDs.
`people.merge` retains the kept person's profile, unions email addresses without
case duplicates, sums sent/received counts, keeps the latest contact/blue dates,
repoints email and matter joins, and deletes the merged person atomically.
Account deletion removes account-owned data, credentials, sync state and their
memberships, while retaining the action audit log, people and matters.

The store is a persistence layer: callers must create ActionRecords and enforce
policy through their ActionExecutor. It does not automatically publish events or
generate audit actions. Trust/config getters return `null` before initial setup;
the policy engine owns default initialization. `dueHeld(now)` selects only held
records with a non-null `holdUntil <= now`, ordered by hold time and ID.

The event bus snapshots subscriptions, invokes typed handlers then catch-all
handlers synchronously, and isolates/logs handler failures using safe metadata.
Returned unsubscribe functions are idempotent. Rejections from async consumers
are also caught, but the bus does not await them.

Nothing is stubbed. Errors carry a `code` (`StoreError` for semantic errors, Node's
SQLite error code for SQL failures). Only the package root is public.

Run `pnpm --filter @passport/types build`, then
`pnpm --filter @passport/store typecheck && pnpm --filter @passport/store test`.
Tests primarily use isolated in-memory databases; a temporary file tests restart,
key configuration, on-disk encryption, and wrong-key behavior.

Availability callers use `events.query({range,includeRecurring:true,limit:2147483647})`
to include older series masters and provider-exposed override/cancellation records
without the default 50-event cap. Ordinary range queries retain overlap semantics;
expansion belongs to the shared tools availability layer. Person records persist
optional `verifiedSelf` and `downgradeAcknowledgedAt` fields without a migration.

Email queries and FTS exclude provider tombstones (`keywords.$deleted === true`) by default,
including totals and pagination. Use `emails.query({includeDeleted:true,...filters})` for
thread/matter history or reconciliation that needs the previous inclusive behavior. ID and
provider-ID lookups still return tombstones. Clearing `$deleted` makes the message searchable
again; tombstone filtering does not remove bodies, FTS entries, or memberships.
