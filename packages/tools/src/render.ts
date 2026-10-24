import type { StoreTasks } from "@passport/types";
import type { Context } from "./context.js";
import { neutralize } from "./ondemand-support.js";
import { json, ToolError } from "./presentation.js";
import { register } from "./register.js";
import { renderHeight, sanitizeRenderHtml } from "./render-html.js";
import { schema as z } from "./schema.js";

const locks = new WeakMap<StoreTasks, Map<string, Promise<unknown>>>();
/** Failed render attempts per run (in memory); they count toward the per-run limit (R1-25). */
const failures = new WeakMap<StoreTasks, Map<string, number>>();
const RENDER_RUN_LIMIT = 10;

function failedRenders(tasks: StoreTasks): Map<string, number> {
  let runs = failures.get(tasks);
  if (!runs) {
    runs = new Map();
    failures.set(tasks, runs);
  }
  return runs;
}

/** Serialise concurrent calls, including calls through separate registries for the same store. */
async function serial<T>(tasks: StoreTasks, runId: string, write: () => Promise<T>): Promise<T> {
  let runs = locks.get(tasks);
  if (!runs) {
    runs = new Map();
    locks.set(tasks, runs);
  }
  const previous = runs.get(runId) ?? Promise.resolve();
  const next = previous.then(write, write);
  runs.set(runId, next);
  try {
    return await next;
  } finally {
    if (runs.get(runId) === next) {
      runs.delete(runId);
    }
  }
}

export function registerRender(ctx: Context): void {
  register(
    ctx,
    "render",
    "Show a digest, triage table or other structured output in the task. Supply a title and restricted HTML: headings, paragraphs, lists, tables, emphasis, code and quotes. Only span/div class attributes survive; links become visible text and URLs. No CSS, scripts, images or external loads. Use plain messages for plain prose. Maximum 64 KiB HTML, 10 renders per run; height optional (80–1200 px).",
    {
      title: z.string().trim().min(1).max(200),
      html: z.string().min(1).max(65536),
      height: z.number().int().min(80).max(1200).optional(),
    },
    false,
    async (args, call) => {
      const { tasks } = call.store;
      const { taskId, runId } = call.callContext;
      if (!tasks || !taskId || !runId) {
        throw new ToolError("TASK_REQUIRED", "Render from a task run.");
      }
      const run = await tasks.runs.byAgentRunId(runId);
      if (!run || run.taskId !== taskId || !["queued", "running"].includes(run.status)) {
        throw new ToolError("TASK_REQUIRED", "Render from an active run of this task.");
      }
      return serial(tasks, run.id, async () => {
        const failed = failedRenders(tasks);
        let count = failed.get(run.id) ?? 0;
        let afterSeq = 0;
        // Persisted items enforce the cap even when a registry is recreated or runs overlap.
        // The cap is checked before the input is parsed, and failed attempts count too.
        for (;;) {
          const page = await tasks.items.list({ taskId, afterSeq, limit: 500 });
          count += page.filter((item) => item.runId === run.id && item.kind === "render").length;
          if (count >= RENDER_RUN_LIMIT) {
            throw new ToolError(
              "RENDER_LIMIT",
              "At most 10 renders, including failed ones, are allowed per run.",
            );
          }
          if (page.length < 500) {
            break;
          }
          afterSeq = page.at(-1)!.seq;
        }
        let html: string, height: number;
        try {
          html = sanitizeRenderHtml(args.html);
          height = renderHeight(html, args.height);
        } catch (error) {
          failed.set(run.id, (failed.get(run.id) ?? 0) + 1);
          // Bound the in-memory record; the oldest runs are long finished.
          if (failed.size > 1000) {
            failed.delete(failed.keys().next().value!);
          }
          throw error;
        }
        if (call.callContext.signal?.aborted) {
          throw new ToolError("RUN_CANCELLED", "The run was stopped.");
        }
        const item = await tasks.items.append({
          taskId,
          runId: run.id,
          kind: "render",
          at: call.now(),
          untrusted: true,
          payload: { title: neutralize(args.title), html, height },
        });
        call.deps.bus.emit({ type: "task.item.appended", item });
        return json({ status: "rendered", itemId: item.id, title: neutralize(args.title), height });
      });
    },
    { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  );
}
