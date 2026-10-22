import type { Account, MailboxRole } from "@passport/types";
import type { ImapFlow, ListResponse } from "imapflow";
import { ProviderError } from "./errors.js";
import { imapRole, imapRoles } from "./imap-reader-shared.js";
import type { ImapExtension, ImapSession } from "./imap-reader-support.js";
import type { QuotaGovernor } from "./quota.js";
import type { PassportVerifier } from "./verification.js";

/** What the reader needs from `ImapMailProvider`. */
export interface ImapReaderHost {
  /** The connected account; throws `NOT_CONNECTED` otherwise. */
  account(): Account;
  /** The live connection; throws when disconnected or failed. */
  client(): ImapFlow;
  /** Extensions probed on connect. */
  extensions(): ReadonlySet<ImapExtension>;
  /** Destinations of recent moves/copies (searched by `findByRfc822`). */
  moveTargets(): ReadonlySet<string>;
  options: { verifier?: PassportVerifier; governor?: QuotaGovernor; now?: () => Date };
}

/** LIST cache and container resolution (paths, SPECIAL-USE attributes, roles, handles). */
export class ImapMailboxes {
  private cache?: { client: ImapFlow; list: ListResponse[] };
  constructor(private readonly host: ImapReaderHost) {}

  /** `LIST "" *`, cached per connection unless `refresh`. */
  async list(session: ImapSession, refresh = false): Promise<ListResponse[]> {
    const client = this.host.client();
    if (refresh || this.cache?.client !== client) {
      session.commands++;
      this.cache = { client, list: await client.list() };
    }
    return this.cache.list;
  }

  /** Display name and role of a path, from the cached LIST. */
  describe(path: string): { name: string; role: MailboxRole } {
    const folder = this.cache?.list.find((f) => f.path === path);
    if (!folder) {
      return { name: path, role: path.toUpperCase() === "INBOX" ? "inbox" : null };
    }
    return { name: folder.name || folder.path, role: imapRole(folder) };
  }

  /**
   * Resolves a container to a path: a SPECIAL-USE attribute (`\Archive` falls back to `\All`), a
   * `<role>Folder` account setting, a role name (`"sent"`, `"spam"`), a path or name (any case),
   * or a mailbox handle. Null when nothing matches.
   */
  async resolve(session: ImapSession, spec: string): Promise<string | null> {
    const account = this.host.account();
    const prefix = `${account.id}:mailbox:`;
    const wanted = spec.startsWith(prefix) ? decodeURIComponent(spec.slice(prefix.length)) : spec;
    if (wanted.toUpperCase() === "INBOX" || wanted === "\\Inbox") {
      return "INBOX";
    }
    const list = (await this.list(session)).filter((f) => !f.flags.has("\\Noselect"));
    const lower = wanted.toLowerCase();
    const byPath = list.find(
      (f) => f.path.toLowerCase() === lower || f.name.toLowerCase() === lower,
    );
    if (byPath && !wanted.startsWith("\\")) {
      return byPath.path;
    }
    const attribute = wanted.startsWith("\\")
      ? wanted
      : Object.entries(imapRoles).find(
          ([, role]) => role === (lower === "spam" ? "junk" : lower),
        )?.[0];
    if (!attribute) {
      return null;
    }
    const role = imapRoles[attribute];
    const configured = role ? account.settings[`${role}Folder`] : undefined;
    if (typeof configured === "string" && configured) {
      return configured;
    }
    const fallbacks = attribute === "\\Archive" ? ["\\Archive", "\\All"] : [attribute];
    for (const use of fallbacks) {
      const found = list.find((f) => f.specialUse === use);
      if (found) {
        return found.path;
      }
    }
    return null;
  }

  /** Resolves several containers, dropping duplicates and symbolic ones the server lacks. */
  async resolveAll(session: ImapSession, specs: string[]): Promise<string[]> {
    const paths: string[] = [];
    for (const spec of specs) {
      const path = await this.resolve(session, spec);
      if (path === null && !spec.startsWith("\\")) {
        throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
      }
      if (path !== null && !paths.includes(path)) {
        paths.push(path);
      }
    }
    if (paths.length === 0) {
      throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
    }
    return paths;
  }
}
