import type { SQLInputValue } from "node:sqlite";
import type {
  Matter,
  NoteKind,
  NotesSearchHit,
  NotesSearchInput,
  Person,
  StoreNotes,
} from "@passport/types";
import { NOTES_SNIPPET_MAX } from "@passport/types";
import { StoreError } from "./errors.js";
import { checkNotesPattern, type FieldMatch, matchInWorker } from "./notes-regex.js";
import type { StoreDatabase } from "./store-database.js";
import { like, type Row } from "./store-query.js";

/** Rows per kind a `pattern` search inspects (newest first); notes are local and small. */
export const NOTES_PATTERN_SCAN = 10_000;
const MAX_LIMIT = 200;
/** Patterns are case-insensitive and multiline (`^`/`$` match lines). */
const FLAGS = "imu";

/** Inline case-insensitive substring search; patterns run in a worker (`matchInWorker`). */
function textMatches(input: NotesSearchInput, records: NoteRecord[]): FieldMatch[] {
  const needle = (input.text ?? "").trim().toLowerCase();
  return records.map(({ fields }) => {
    for (const [field, [, value]] of fields.entries()) {
      const index = value ? value.toLowerCase().indexOf(needle) : -1;
      if (index >= 0) {
        return [field, index];
      }
    }
    return null;
  });
}

interface NoteRecord {
  kind: NoteKind;
  id: string;
  name: string;
  updatedAt: string;
  fields: Array<[NotesSearchHit["field"], string | null | undefined]>;
}

/** The matching line of `value` around `index`, clipped to `NOTES_SNIPPET_MAX`. */
function snippetAt(value: string, index: number): string {
  const start = value.lastIndexOf("\n", index) + 1;
  const end = value.indexOf("\n", index);
  const line = value.slice(start, end < 0 ? undefined : end);
  if (line.length <= NOTES_SNIPPET_MAX) {
    return line;
  }
  const from = Math.max(0, Math.min(index - start - 60, line.length - NOTES_SNIPPET_MAX));
  return line.slice(from, from + NOTES_SNIPPET_MAX);
}

export function createNotesRepository(
  db: StoreDatabase,
  matterById: (id: string) => Matter | null,
): StoreNotes {
  const people = (input: NotesSearchInput, limit: number): Row[] => {
    if (input.pattern !== undefined) {
      return db.all(
        "SELECT p.data FROM people p ORDER BY json_extract(p.data, '$.updatedAt') DESC, p.id LIMIT ?",
        [NOTES_PATTERN_SCAN],
      );
    }
    const text = like((input.text ?? "").trim());
    return db.all(
      `SELECT p.data FROM people p WHERE p.display_name LIKE ? ESCAPE '\\'
        OR COALESCE(json_extract(p.data, '$.notes'), '') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM person_emails pe WHERE pe.person_id = p.id AND pe.email LIKE ? ESCAPE '\\')
      ORDER BY json_extract(p.data, '$.updatedAt') DESC, p.id LIMIT ?`,
      [text, text, text, limit] satisfies SQLInputValue[],
    );
  };
  const matters = (input: NotesSearchInput, limit: number): Row[] => {
    if (input.pattern !== undefined) {
      return db.all("SELECT m.data FROM matters m ORDER BY m.updated_at DESC, m.id LIMIT ?", [
        NOTES_PATTERN_SCAN,
      ]);
    }
    const text = like((input.text ?? "").trim());
    return db.all(
      `SELECT m.data FROM matters m WHERE json_extract(m.data, '$.title') LIKE ? ESCAPE '\\'
        OR json_extract(m.data, '$.summary') LIKE ? ESCAPE '\\'
        OR COALESCE(json_extract(m.data, '$.notes'), '') LIKE ? ESCAPE '\\'
      ORDER BY m.updated_at DESC, m.id LIMIT ?`,
      [text, text, text, limit],
    );
  };
  return {
    search: async (input) => {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? 25)));
      if (input.pattern !== undefined) {
        checkNotesPattern(input.pattern, FLAGS);
      } else if (!(input.text ?? "").trim()) {
        throw new StoreError("INVALID_QUERY", "Provide text or pattern");
      }
      const records: NoteRecord[] = [];
      if (input.kind !== "matter") {
        for (const row of people(input, limit)) {
          const person = db.parse<Person>(row);
          records.push({
            kind: "person",
            id: person.id,
            name: person.displayName,
            updatedAt: person.updatedAt,
            fields: [
              ["name", person.displayName],
              ["email", [person.primaryEmail, ...person.emails].join("\n")],
              ["notes", person.notes],
            ],
          });
        }
      }
      if (input.kind !== "person") {
        for (const row of matters(input, limit)) {
          const matter = db.parse<Matter>(row);
          records.push({
            kind: "matter",
            id: matter.id,
            name: matter.title,
            updatedAt: matter.updatedAt,
            fields: [
              ["name", matter.title],
              ["summary", matter.summary],
              ["notes", matter.notes],
            ],
          });
        }
      }
      const matches =
        input.pattern === undefined
          ? textMatches(input, records)
          : await matchInWorker(
              input.pattern,
              FLAGS,
              records.map(({ fields }) => fields.map(([, value]) => value ?? "")),
            );
      const hits = records.flatMap((record, index): NotesSearchHit[] => {
        const match = matches[index];
        if (!match) {
          return [];
        }
        const [field, value] = record.fields[match[0]]!;
        const { kind, id, name, updatedAt } = record;
        return [{ kind, id, name, field, snippet: snippetAt(value ?? "", match[1]), updatedAt }];
      });
      return hits
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    mattersByRef: async (query, limit = 20) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [query.account];
      for (const [column, value] of [
        ["provider_id", query.providerId],
        ["thread_pid", query.threadPid],
        ["rfc822_id", query.rfc822Id],
      ] as const) {
        if (value) {
          where.push(`r.${column} = ?`);
          params.push(value);
        }
      }
      if (!where.length) {
        throw new StoreError("INVALID_QUERY", "Provide providerId, threadPid or rfc822Id");
      }
      const ids = db
        .all(
          `SELECT DISTINCT m.id AS id, m.updated_at FROM matter_refs r JOIN matters m ON m.id = r.matter_id
          WHERE r.account_id = ? AND (${where.join(" OR ")})
          ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`,
          [...params, Math.min(MAX_LIMIT, Math.max(1, limit))],
        )
        .map((row) => row.id as string);
      return ids.map(matterById).filter((matter): matter is Matter => matter !== null);
    },
  };
}

/** Rebuilds the matter_refs index rows of one matter from its `refs`. Inside a transaction. */
export function indexMatterRefs(db: StoreDatabase, matter: Matter): void {
  db.run("DELETE FROM matter_refs WHERE matter_id = ?", [matter.id]);
  (matter.refs ?? []).forEach((ref, position) => {
    db.run(
      `INSERT OR IGNORE INTO matter_refs(matter_id, account_id, provider_id, rfc822_id, thread_pid, date, position)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        matter.id,
        ref.account,
        ref.providerId,
        ref.rfc822Id ?? null,
        ref.threadPid ?? null,
        ref.date,
        position,
      ],
    );
  });
}
