import type { TaskItem, TaskRun } from "@passport/types";

export type ToolCallItem = Extract<TaskItem, { kind: "tool_call" }>;
export type TimelineEntry =
  | { kind: "run"; key: string; run: TaskRun }
  | { kind: "item"; key: string; item: TaskItem }
  | { kind: "tools"; key: string; calls: ToolCallItem[] };

/**
 * Timeline order: items by `seq`; a run header before the first item of each run; consecutive
 * `tool_call` items of one run collapse into one group. Runs without items yet (queued) go last.
 */
export function buildTimeline(items: TaskItem[], runs: TaskRun[] = []): TimelineEntry[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const headed = new Set<string>();
  const entries: TimelineEntry[] = [];
  for (const item of [...items].sort((a, b) => a.seq - b.seq)) {
    const run = item.runId ? byId.get(item.runId) : undefined;
    if (run && !headed.has(run.id)) {
      headed.add(run.id);
      entries.push({ kind: "run", key: `run-${run.id}`, run });
    }
    const last = entries.at(-1);
    if (
      item.kind === "tool_call" &&
      last?.kind === "tools" &&
      last.calls[0]!.runId === item.runId
    ) {
      last.calls.push(item);
    } else if (item.kind === "tool_call") {
      entries.push({ kind: "tools", key: `tools-${item.seq}`, calls: [item] });
    } else {
      entries.push({ kind: "item", key: `item-${item.seq}`, item });
    }
  }
  const pending = runs
    .filter((run) => !headed.has(run.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const run of pending) {
    entries.push({ kind: "run", key: `run-${run.id}`, run });
  }
  return entries;
}

type Outcome = "done" | "asked" | "planned" | "queued";
interface Category {
  id: string;
  write: boolean;
  /** Counted by email ids in the input (archive 40) rather than by call. */
  perEmail?: boolean;
  phrase: (n: number, outcome: Outcome) => string;
}

const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "archived 40" when it ran; "asked to archive 40" when it became a proposal. */
const write =
  (done: string, base: string, noun?: [string, string]) => (n: number, outcome: Outcome) => {
    const count = noun ? plural(n, noun[0], noun[1]) : String(n);
    const lead =
      outcome === "done"
        ? done
        : outcome === "asked"
          ? `asked to ${base}`
          : outcome === "queued"
            ? `queued to ${base}`
            : `planned to ${base}`;
    return `${lead} ${count}`;
  };

const CATEGORIES: Record<string, Category> = {
  send: {
    id: "send",
    write: true,
    phrase: write("sent", "send", ["message", "messages"]),
  },
  archive: { id: "archive", write: true, perEmail: true, phrase: write("archived", "archive") },
  label: { id: "label", write: true, perEmail: true, phrase: write("labelled", "label") },
  move: { id: "move", write: true, perEmail: true, phrase: write("moved", "move") },
  read_mark: {
    id: "read_mark",
    write: true,
    perEmail: true,
    phrase: (n, o) => write("marked", "mark")(n, o).concat(" read"),
  },
  draft: { id: "draft", write: true, phrase: write("drafted", "draft", ["reply", "replies"]) },
  calendar: {
    id: "calendar",
    write: true,
    phrase: write("answered", "answer", ["invite", "invites"]),
  },
  matter: { id: "matter", write: true, phrase: write("updated", "update", ["matter", "matters"]) },
  unsubscribe: {
    id: "unsubscribe",
    write: true,
    phrase: write("unsubscribed from", "unsubscribe from", ["list", "lists"]),
  },
  snooze: { id: "snooze", write: true, perEmail: true, phrase: write("snoozed", "snooze") },
  watch: {
    id: "watch",
    write: true,
    phrase: (n) => `watched ${plural(n, "conversation", "conversations")}`,
  },
  write: { id: "write", write: true, phrase: write("made", "make", ["change", "changes"]) },
  search: { id: "search", write: false, phrase: (n) => `searched ${times(n)}` },
  read: { id: "read", write: false, phrase: (n) => `read ${plural(n, "message", "messages")}` },
  people: {
    id: "people",
    write: false,
    phrase: (n) => `looked up ${plural(n, "person", "people")}`,
  },
  calendar_read: {
    id: "calendar_read",
    write: false,
    phrase: (n) => `checked the calendar ${times(n)}`,
  },
  other: { id: "other", write: false, phrase: (n) => `checked ${plural(n, "thing", "things")}` },
};

const TOOLS: Record<string, keyof typeof CATEGORIES> = {
  send: "send",
  archive_emails: "archive",
  batch_archive_by_query: "archive",
  label_emails: "label",
  apply_label_by_query: "label",
  move_emails: "move",
  mark_read: "read_mark",
  create_draft: "draft",
  reply_draft: "draft",
  respond_to_event: "calendar",
  propose_meeting: "calendar",
  create_matter: "matter",
  update_matter: "matter",
  attach_to_matter: "matter",
  update_person: "matter",
  unsubscribe: "unsubscribe",
  snooze: "snooze",
  watch_conversation: "watch",
  unwatch_conversation: "write",
  undo_action: "write",
  cancel_held_action: "write",
  notes_write: "write",
  add_standing_rule: "write",
  remove_standing_rule: "write",
  mail_search: "search",
  mail_grep: "search",
  search_emails: "search",
  notes_search: "search",
  search_people: "people",
  people_lookup: "people",
  people_history: "people",
  get_person: "people",
  list_people: "people",
  list_recent_from_person: "people",
  mail_read: "read",
  get_email: "read",
  get_email_body: "read",
  get_thread: "read",
  summarize_thread: "read",
  mail_list: "read",
  list_events: "calendar_read",
  free_busy: "calendar_read",
  find_free_slots: "calendar_read",
};

export function categoryOf(name: string): Category {
  return CATEGORIES[TOOLS[name] ?? (name.startsWith("mail_") ? "read" : "other")]!;
}

/** `emailIds=[40 items]` → 40; `emailIds=["…"]` → 1; anything else counts as one. */
function emailCount(inputSummary: string): number {
  const many = inputSummary.match(/emailIds=\[(\d+) items\]/);
  if (many) {
    return Number(many[1]);
  }
  return 1;
}

function outcomeOf(call: ToolCallItem): Outcome {
  if (call.payload.planned) {
    return "planned";
  }
  const status = call.payload.resultSummary.match(/status (\w+)/)?.[1];
  return status === "proposed" ? "asked" : status === "held" ? "queued" : "done";
}

/**
 * One line for a collapsed group, T3's rule: name at most two categories, writes before reads,
 * and never over-claim (a proposal "asked to archive", a failed call is not counted as done).
 */
export function summarizeTools(calls: ToolCallItem[]): string {
  const buckets = new Map<string, { category: Category; outcome: Outcome; n: number }>();
  let failed = 0;
  for (const call of calls) {
    if (call.payload.isError) {
      failed++;
      continue;
    }
    const category = categoryOf(call.payload.name);
    const outcome = category.write ? outcomeOf(call) : "done";
    const key = `${category.id}:${outcome}`;
    const bucket = buckets.get(key) ?? { category, outcome, n: 0 };
    bucket.n += category.perEmail ? emailCount(call.payload.inputSummary) : 1;
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.values()].sort(
    (a, b) => Number(b.category.write) - Number(a.category.write) || b.n - a.n,
  );
  const named = ranked.slice(0, 2).map((b) => b.category.phrase(b.n, b.outcome));
  const rest = ranked.slice(2).length;
  let text = named.join(", ");
  if (rest) {
    text += ` and ${plural(rest, "other step", "other steps")}`;
  }
  if (failed) {
    text = text ? `${text}; ${failed} failed` : `${plural(failed, "call", "calls")} failed`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
