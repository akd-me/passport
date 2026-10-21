import type { SQLInputValue } from "node:sqlite";
import type { Matter, Person, Store } from "@passport/types";
import { nowIso } from "@passport/types";
import { StoreError } from "./errors.js";
import type { StoreDatabase } from "./store-database.js";
import { latest, like, limitOf, type Row, unique } from "./store-query.js";

export function createPeopleRepositories(db: StoreDatabase) {
  function savePerson(person: Person): Person {
    const seen = new Set<string>();
    const emails = [...person.emails, person.primaryEmail]
      .filter((email) => {
        const normalized = email.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) {
          return false;
        }
        seen.add(normalized);
        return true;
      })
      .map((email) => email.trim());
    const saved = { ...person, emails };
    db.put("people", person.id, saved, {
      relationship: person.relationship,
      display_name: person.displayName,
    });
    db.replaceIds("person_emails", "person_id", person.id, "email", emails);
    return db.get<Person>("people", person.id)!;
  }
  const people: Store["people"] = {
    get: async (id) => db.get("people", id),
    getByEmail: async (email) => {
      const row = db.one(
        "SELECT p.data FROM people p JOIN person_emails pe ON pe.person_id = p.id WHERE pe.email = ? COLLATE NOCASE ORDER BY p.id LIMIT 1",
        [email.trim()],
      );
      return row ? db.parse<Person>(row) : null;
    },
    list: async (q = {}) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.relationship !== undefined) {
        where.push("p.relationship = ?");
        params.push(q.relationship);
      }
      if (q.text) {
        where.push(
          "(p.display_name LIKE ? ESCAPE '\\' OR COALESCE(json_extract(p.data, '$.notes'), '') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM person_emails pe WHERE pe.person_id = p.id AND pe.email LIKE ? ESCAPE '\\'))",
        );
        params.push(like(q.text), like(q.text), like(q.text));
      }
      return db.rows(
        `SELECT p.data FROM people p ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.display_name COLLATE NOCASE, p.id LIMIT ?`,
        [...params, limitOf(q.limit)],
      );
    },
    upsert: async (person) => db.transaction(() => savePerson(person)),
    delete: async (id) =>
      db.transaction(() => {
        for (const table of ["email_people", "matter_people", "person_emails"]) {
          db.run(`DELETE FROM ${table} WHERE person_id = ?`, [id]);
        }
        db.run("DELETE FROM people WHERE id = ?", [id]);
      }),
    merge: async (keepId, mergeId) =>
      db.transaction(() => {
        const keep = db.get<Person>("people", keepId);
        const merge = db.get<Person>("people", mergeId);
        if (!keep || !merge) {
          throw new StoreError("NOT_FOUND", "Both people must exist to merge them");
        }
        if (keepId === mergeId) {
          return keep;
        }
        for (const [table, ownerColumn] of [
          ["email_people", "email_id"],
          ["matter_people", "matter_id"],
        ] as const) {
          for (const row of db.all(
            `SELECT ${ownerColumn} AS owner, position FROM ${table} WHERE person_id = ?`,
            [mergeId],
          )) {
            db.run(
              `INSERT INTO ${table}(${ownerColumn}, person_id, position) VALUES (?, ?, ?) ON CONFLICT(${ownerColumn}, person_id) DO NOTHING`,
              [row.owner as string, keepId, row.position as number],
            );
          }
          db.run(`DELETE FROM ${table} WHERE person_id = ?`, [mergeId]);
        }
        const saved = savePerson({
          ...keep,
          emails: [...keep.emails, ...merge.emails],
          stats: {
            sent: keep.stats.sent + merge.stats.sent,
            received: keep.stats.received + merge.stats.received,
            lastContactAt: latest(keep.stats.lastContactAt, merge.stats.lastContactAt),
          },
          lastSeenBlueAt: latest(keep.lastSeenBlueAt, merge.lastSeenBlueAt),
          updatedAt: nowIso(),
        });
        db.run("DELETE FROM people WHERE id = ?", [mergeId]);
        return saved;
      }),
  };
  function readMatter(row: Row): Matter {
    const matter = db.parse<Matter>(row);
    matter.emailIds = db.ids("matter_emails", "matter_id", matter.id, "email_id");
    matter.eventIds = db.ids("matter_events", "matter_id", matter.id, "event_id");
    matter.personIds = db.ids("matter_people", "matter_id", matter.id, "person_id");
    return matter;
  }
  const matters: Store["matters"] = {
    get: async (id) => {
      const row = db.one("SELECT data FROM matters WHERE id = ?", [id]);
      return row ? readMatter(row) : null;
    },
    list: async (q = {}) => {
      const where: string[] = [];
      const params: SQLInputValue[] = [];
      if (q.status !== undefined) {
        where.push(`m.status IN (${q.status.map(() => "?").join(",")})`);
        params.push(...q.status);
      }
      if (q.personId !== undefined) {
        where.push(
          "EXISTS (SELECT 1 FROM matter_people mp WHERE mp.matter_id = m.id AND mp.person_id = ?)",
        );
        params.push(q.personId);
      }
      if (q.text) {
        where.push(
          "(json_extract(m.data, '$.title') LIKE ? ESCAPE '\\' OR json_extract(m.data, '$.summary') LIKE ? ESCAPE '\\')",
        );
        params.push(like(q.text), like(q.text));
      }
      return db
        .all(
          `SELECT m.data FROM matters m ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.updated_at DESC, m.id DESC LIMIT ?`,
          [...params, limitOf(q.limit)],
        )
        .map((row) => readMatter(row));
    },
    upsert: async (matter) =>
      db.transaction(() => {
        db.put("matters", matter.id, matter, {
          status: matter.status,
          updated_at: matter.updatedAt,
        });
        for (const [kind, column, ids] of [
          ["emails", "email_id", matter.emailIds],
          ["events", "event_id", matter.eventIds],
        ] as const) {
          db.run(`UPDATE ${kind} SET matter_id = NULL WHERE matter_id = ?`, [matter.id]);
          db.run(`DELETE FROM matter_${kind} WHERE matter_id = ?`, [matter.id]);
          unique(ids).forEach((id, position) => {
            db.setMatterLink(kind, id, matter.id);
            db.run(`UPDATE matter_${kind} SET position = ? WHERE ${column} = ?`, [position, id]);
          });
        }
        db.replaceIds("matter_people", "matter_id", matter.id, "person_id", matter.personIds);
        return readMatter(db.one("SELECT data FROM matters WHERE id = ?", [matter.id])!);
      }),
    delete: async (id) =>
      db.transaction(() => {
        db.run("UPDATE emails SET matter_id = NULL WHERE matter_id = ?", [id]);
        db.run("UPDATE events SET matter_id = NULL WHERE matter_id = ?", [id]);
        for (const table of ["matter_emails", "matter_events", "matter_people"]) {
          db.run(`DELETE FROM ${table} WHERE matter_id = ?`, [id]);
        }
        db.run("DELETE FROM matters WHERE id = ?", [id]);
      }),
  };
  return { people, matters };
}
