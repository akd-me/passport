import type { MailboxRole, MailLabel } from "@passport/types";
import { ProviderError } from "./errors.js";
import { GMAIL_LABEL_ROLES, type GmailLabel } from "./gmail-reader-normalize.js";
import type { GmailCall } from "./gmail-reader-support.js";
import { GMAIL_UNIT_COSTS } from "./quota-presets.js";

/** Unknown label ids trigger at most one `labels.list` per this interval. */
const LABEL_REFRESH_MS = 60_000;

/** Container words that map to a Gmail system label, or to a `q` scope with no label. */
const CONTAINER_WORDS: Readonly<Record<string, { labelId?: string; q?: string }>> = {
  inbox: { labelId: "INBOX" },
  sent: { labelId: "SENT" },
  drafts: { labelId: "DRAFT" },
  draft: { labelId: "DRAFT" },
  spam: { labelId: "SPAM" },
  junk: { labelId: "SPAM" },
  trash: { labelId: "TRASH" },
  starred: { labelId: "STARRED" },
  flagged: { labelId: "STARRED" },
  important: { labelId: "IMPORTANT" },
  unread: { labelId: "UNREAD" },
  archive: { q: "in:archive" },
  anywhere: { q: "in:anywhere" },
  all: {},
};

/** Resolved `container`: a label for `labelIds`, and/or a `q` term. */
export interface GmailScope {
  labelId?: string;
  q?: string;
}

/** Gmail system label ids (their display name is the id); user label ids look like `Label_12`. */
export const isSystemLabelId = (id: string): boolean =>
  /^(?:INBOX|SENT|DRAFT|SPAM|TRASH|STARRED|IMPORTANT|UNREAD|CHAT|CATEGORY_[A-Z]+)$/.test(id);

/**
 * Resolves a container without a `labels.list` call when possible: a role word, a system label
 * id, or an account mailbox handle wrapping either. Returns null when a label lookup is needed.
 */
export function quickScope(container: string): GmailScope | null {
  const word = CONTAINER_WORDS[container.toLowerCase()];
  if (word) {
    return word;
  }
  return isSystemLabelId(container) ? { labelId: container } : null;
}

/** Finds a label by id, or by display name (case-insensitive). */
export function findLabel(labels: readonly GmailLabel[], wanted: string): GmailLabel | undefined {
  const lower = wanted.toLowerCase();
  return labels.find((l) => l.id === wanted) ?? labels.find((l) => l.name.toLowerCase() === lower);
}

export function labelRole(id: string): MailboxRole {
  return id === "ALL" ? null : (GMAIL_LABEL_ROLES[id] ?? null);
}

/** Projects Gmail labels into `MailLabel`s; nested `A/B` names get the `A` label as parent. */
export function toMailLabels(labels: readonly GmailLabel[]): MailLabel[] {
  const byName = new Map(labels.map((l) => [l.name, l.id]));
  return labels.map((l) => {
    const slash = l.name.lastIndexOf("/");
    const parent = slash > 0 ? byName.get(l.name.slice(0, slash)) : undefined;
    return { id: l.id, name: l.name, role: labelRole(l.id), parentId: parent ?? null };
  });
}

/** The account's label list, fetched lazily (1 unit) and reused across reader calls. */
export class GmailLabelCache {
  private labelCache?: { at: number; labels: GmailLabel[] };
  constructor(private readonly accountId: () => string) {}

  clear(): void {
    this.labelCache = undefined;
  }

  async loadLabels(call: GmailCall): Promise<GmailLabel[]> {
    const labels =
      (await call.get<{ labels?: GmailLabel[] }>("labels", GMAIL_UNIT_COSTS.labelsList)).labels ??
      [];
    this.labelCache = { at: Date.now(), labels };
    return labels;
  }

  /** Label id → display name; refreshes the cache (1 unit) only for unknown user labels. */
  async labelNames(call: GmailCall, ids: string[]): Promise<Map<string, string>> {
    const known = () => new Map((this.labelCache?.labels ?? []).map((l) => [l.id, l.name]));
    let names = known();
    const unknown = ids.some((id) => !isSystemLabelId(id) && !names.has(id));
    if (unknown && (!this.labelCache || Date.now() - this.labelCache.at > LABEL_REFRESH_MS)) {
      await this.loadLabels(call);
      names = known();
    }
    return names;
  }

  /**
   * Resolves a container: a role word (`inbox`, `archive`, …), a system label id, a label id or
   * display name, or this account's mailbox handle. A cached user label with the exact name wins
   * over a role word. Unknown containers throw `NOT_FOUND`.
   */
  async scope(call: GmailCall, container: string): Promise<GmailScope> {
    const prefix = `${this.accountId()}:mailbox:`;
    const wanted = container.startsWith(prefix)
      ? decodeURIComponent(container.slice(prefix.length))
      : container;
    const cached = this.labelCache?.labels.find((l) => l.id === wanted || l.name === wanted);
    if (cached) {
      return { labelId: cached.id };
    }
    const quick = quickScope(wanted);
    if (quick) {
      return quick;
    }
    const label = findLabel(await this.loadLabels(call), wanted);
    if (!label) {
      throw new ProviderError("NOT_FOUND", "Label or folder does not exist");
    }
    return { labelId: label.id };
  }
}
