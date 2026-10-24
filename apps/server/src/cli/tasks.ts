import { setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  type ActionRecord,
  type Page,
  TASK_STATUSES,
  type Task,
  type TaskDetail,
  type TaskItem,
  type TaskRun,
  TRUST_LEVELS,
} from "@passport/types";
import { loadConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { serverClient } from "./server-client.js";

const help = `passport task start "<message>" [--account <id>] [--mode <permissionMode>] [--plan] [--wait]
passport task send <id> "<text>" [--steer] [--wait]
passport task show <id> [--items N]
passport task list [--status inbox,working,snoozed,settled,archived]
passport task approve <actionId>
passport task reject <actionId>

Every command accepts --json. Tasks require passport serve with the same configuration.
Modes: ${TRUST_LEVELS.join(", ")} (clamped to the server's trust dial).
Show includes the latest 20 items by default; --items 0 omits the timeline.
--wait polls once per second for this run, then prints its summary.
Exit codes: 0 success, 2 needs you (approval, question, failed/stopped run), 1 error.`;

type Request = NonNullable<Awaited<ReturnType<typeof serverClient>>>;
type Started = { task: Task; run: TaskRun };
type Items = { items: TaskItem[]; lastSeq: number };
const MAX_POLL_FAILURES = 5;

function transientPollError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return [
      "SERVER_UNAVAILABLE",
      "SERVICE_UNAVAILABLE",
      "REQUEST_FAILED",
      "INTERNAL_ERROR",
      "RATE_LIMITED",
    ].includes(error.code);
  }
  return (
    error instanceof TypeError ||
    error instanceof SyntaxError ||
    (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
  );
}

function invalid(message: string): never {
  throw new ApiError("INVALID_COMMAND", `${message} Run passport task --help.`);
}

function taskLine(task: Task): string {
  return `${task.id}  ${task.status}${task.needsUser ? ` · needs ${task.needsUser}` : ""}  ${task.title}`;
}

function runLines(run: TaskRun): string[] {
  return [
    `Run ${run.id}: ${run.status}`,
    ...(run.summary ? [run.summary] : []),
    ...(run.error ? [`Error: ${run.error}`] : []),
    ...(run.actionIds.length ? [`Actions: ${run.actionIds.join(", ")}`] : []),
  ];
}

/** Payloads are plain text, including new additive item kinds from later work items. */
function itemLine(item: TaskItem): string {
  const payload = item.payload;
  const text =
    "text" in payload
      ? payload.text
      : "summary" in payload
        ? `${"actionId" in payload ? `${payload.actionId}: ` : ""}${payload.summary}`
        : "name" in payload
          ? `${payload.name}${payload.planned ? " (planned)" : ""}: ${payload.inputSummary} → ${payload.resultSummary}${payload.isError ? " (error)" : ""}`
          : JSON.stringify(payload);
  return `#${item.seq} ${item.kind}: ${text}`;
}

async function waitForRun(request: Request, started: Started): Promise<Started> {
  let failures = 0;
  const taskPath = `/api/tasks/${encodeURIComponent(started.task.id)}`;
  const path = `${taskPath}/runs/${encodeURIComponent(started.run.id)}`;
  for (;;) {
    let delay = 1000;
    try {
      const run = (await request(path)) as TaskRun;
      if (["completed", "failed", "cancelled"].includes(run.status)) {
        // Read the current task once for needsUser/exit status; its recent-runs list is irrelevant.
        const { task } = (await request(taskPath)) as TaskDetail;
        return { task, run };
      }
      failures = 0;
    } catch (error) {
      // Polling is read-only: tolerate a short outage, but surface permanent or repeated failures.
      if (!transientPollError(error) || ++failures >= MAX_POLL_FAILURES) {
        throw error;
      }
      delay = Math.min(1000, 250 * 2 ** (failures - 1));
    }
    await setTimeout(delay);
  }
}

/** The API is ascending-only; retain a bounded tail while walking its pages. */
async function latestItems(request: Request, taskId: string, count: number): Promise<Items> {
  let items: TaskItem[] = [];
  let lastSeq = 0;
  if (!count) return { items, lastSeq };
  for (;;) {
    const page = (await request(
      `/api/tasks/${encodeURIComponent(taskId)}/items?afterSeq=${lastSeq}&limit=500`,
    )) as Items;
    if (!page.items.length) return { items, lastSeq };
    if (page.lastSeq <= lastSeq) {
      throw new ApiError("INVALID_RESPONSE", "The server returned a non-advancing timeline page.");
    }
    items = [...items, ...page.items].slice(-count);
    lastSeq = page.lastSeq;
    if (page.items.length < 500) return { items, lastSeq };
  }
}

async function listTasks(request: Request, status?: string): Promise<Page<Task>> {
  const query = new URLSearchParams({ limit: "500" });
  if (status) query.set("status", status);
  const items: Task[] = [];
  let total: number | undefined;
  const cursors = new Set<string>();
  for (;;) {
    const page = (await request(`/api/tasks?${query}`)) as Page<Task>;
    items.push(...page.items);
    total ??= page.total;
    if (!page.nextCursor) return { items, total, nextCursor: null };
    if (cursors.has(page.nextCursor)) {
      throw new ApiError("INVALID_RESPONSE", "The server returned a repeated task cursor.");
    }
    cursors.add(page.nextCursor);
    query.set("cursor", page.nextCursor);
  }
}

function parseCommand(command: string, args: string[]): ReturnType<typeof parseArgs> {
  const valueOptions: Record<string, string[]> = {
    start: ["account", "mode"],
    send: [],
    show: ["items"],
    list: ["status"],
    approve: [],
    reject: [],
  };
  const booleanOptions: Record<string, string[]> = {
    start: ["plan", "wait"],
    send: ["steer", "wait"],
  };
  const allowed = valueOptions[command];
  if (!allowed) invalid("Unknown task command.");
  try {
    return parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        ...Object.fromEntries(allowed.map((name) => [name, { type: "string" as const }])),
        ...Object.fromEntries(
          (booleanOptions[command] ?? []).map((name) => [name, { type: "boolean" as const }]),
        ),
      },
    });
  } catch {
    invalid("Unknown or incomplete task option.");
  }
}

function validateOptions(command: string, parsed: ReturnType<typeof parseCommand>) {
  const { values, positionals } = parsed;
  const expected = command === "send" ? 2 : command === "list" ? 0 : 1;
  if (positionals.length !== expected || positionals.some((value) => !value.trim())) {
    invalid(`task ${command} expects ${expected} nonempty argument${expected === 1 ? "" : "s"}.`);
  }
  const mode = values.mode as string | undefined;
  if (mode !== undefined && !TRUST_LEVELS.some((level) => level === mode)) {
    invalid(`--mode must be one of ${TRUST_LEVELS.join(", ")}.`);
  }
  const count = values.items === undefined ? 20 : Number(values.items);
  if (
    values.items !== undefined &&
    (!/^\d+$/.test(String(values.items)) || !Number.isSafeInteger(count))
  ) {
    invalid("--items must be a nonnegative integer.");
  }
  const status = values.status as string | undefined;
  if (status?.split(",").some((value) => !TASK_STATUSES.some((status) => status === value))) {
    invalid(`--status must be a comma-separated list of ${TASK_STATUSES.join(", ")}.`);
  }
  if (values.account !== undefined && !String(values.account).trim())
    invalid("--account needs an id.");
  return { count, status };
}

async function submitMessage(
  request: Request,
  command: string,
  parsed: ReturnType<typeof parseCommand>,
): Promise<Started> {
  const { values, positionals } = parsed;
  const id = positionals[0] ?? "";
  const started = (await request(
    command === "start" ? "/api/tasks" : `/api/tasks/${encodeURIComponent(id)}/messages`,
    "POST",
    command === "start"
      ? {
          message: id,
          ...(values.account ? { accountIds: [values.account] } : {}),
          ...(values.mode ? { permissionMode: values.mode } : {}),
          ...(values.plan ? { interactionMode: "plan" } : {}),
        }
      : { text: positionals[1], mode: values.steer ? "steer" : "queue" },
  )) as Started;
  return values.wait ? waitForRun(request, started) : started;
}

async function execute(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || ["--help", "-h", "help"].includes(command)) {
    console.log(help);
    return;
  }
  const parsed = parseCommand(command, rest);
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(help);
    return;
  }
  const { count, status } = validateOptions(command, parsed);
  const request = await serverClient(await loadConfig(), { requireServer: true });
  if (!request) throw new ApiError("SERVER_UNAVAILABLE", "Start passport serve to use tasks.");
  const print = (value: unknown, lines: string[]) =>
    console.log(values.json ? JSON.stringify(value, null, 2) : lines.join("\n"));
  const id = positionals[0] ?? "";
  if (command === "start" || command === "send") {
    const started = await submitMessage(request, command, parsed);
    print(started, [
      taskLine(started.task),
      ...runLines(started.run),
      ...(started.task.needsUser === "approval" && started.task.pendingActionIds?.length
        ? [`Pending approvals: ${started.task.pendingActionIds.join(", ")}`]
        : []),
    ]);
    if (values.wait) {
      process.exitCode =
        started.task.needsUser || ["failed", "cancelled"].includes(started.run.status) ? 2 : 0;
    }
  } else if (command === "show") {
    const detail = (await request(`/api/tasks/${encodeURIComponent(id)}`)) as TaskDetail;
    const items = await latestItems(request, id, count);
    print({ ...detail, ...items }, [
      taskLine(detail.task),
      `Mode: ${detail.task.permissionMode} · ${detail.task.interactionMode}`,
      ...detail.runs.flatMap(runLines),
      ...items.items.map(itemLine),
    ]);
  } else if (command === "list") {
    const page = await listTasks(request, status);
    print(page, page.items.length ? page.items.map(taskLine) : ["No tasks."]);
  } else {
    const action = (await request(
      `/api/actions/${encodeURIComponent(id)}/${command}`,
      "POST",
      {},
    )) as ActionRecord;
    print(action, [
      `Action ${action.id}: ${action.status}`,
      ...(action.error ? [`Error: ${action.error}`] : []),
    ]);
    if (action.status === "failed") process.exitCode = 2;
  }
}

/** CLI owns presentation and exit codes; all task state stays on the running server. */
export async function runTaskCommand(args: string[]): Promise<void> {
  try {
    await execute(args);
  } catch (error) {
    const failure = {
      code: error instanceof ApiError ? error.code : "COMMAND_FAILED",
      message:
        error instanceof ApiError
          ? error.message
          : "Command failed. Check your configuration and server connection.",
    };
    console.error(args.includes("--json") ? JSON.stringify({ error: failure }) : failure.message);
    process.exitCode = 1;
  }
}
