import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { GrepHits, GrepJob } from "../grep-match.js";
import { ToolError } from "../presentation.js";
import type { Extracted, ExtractJob, WorkerReply } from "./extract.js";
import { EXTRACTION_TIMEOUT_MS } from "./kinds.js";

/** Worker settings; tests swap in a slow worker or a shorter timeout. */
export const extraction: { timeoutMs: number; worker?: URL } = {
  timeoutMs: EXTRACTION_TIMEOUT_MS,
};

/**
 * The compiled worker sits next to this module (`dist/attachments/`, or `dist/server/` in the
 * published bundle). From a source checkout (vitest) the TypeScript entry runs through tsx.
 */
function workerEntry(): { url: URL; execArgv?: string[] } {
  if (extraction.worker) {
    return { url: extraction.worker };
  }
  const compiled = new URL("./attachment-worker.js", import.meta.url);
  if (existsSync(compiled)) {
    return { url: compiled };
  }
  return { url: new URL("./attachment-worker.ts", import.meta.url), execArgv: ["--import", "tsx"] };
}

/**
 * Extracts in a fresh worker thread with a heap cap. Past `extraction.timeoutMs` the worker is
 * terminated and `EXTRACTION_TIMEOUT` is thrown.
 */
export function runExtraction(job: ExtractJob): Promise<Extracted> {
  return runWorkerJob<Extracted>(job, extraction.timeoutMs, {
    timeout: new ToolError(
      "EXTRACTION_TIMEOUT",
      `Extraction took longer than ${Math.round(extraction.timeoutMs / 1000)} s and was stopped. Try a smaller pages or rows range.`,
    ),
    error: new ToolError("EXTRACTION_FAILED", "The attachment could not be parsed."),
    exit: new ToolError("EXTRACTION_FAILED", "The extraction worker stopped unexpectedly."),
  });
}

/** `mail_grep` matching limits; tests lower the timeout. */
export const grepLimits = { timeoutMs: 2000 };

/** Matches lines in a worker; past `grepLimits.timeoutMs` it is stopped (`PATTERN_TIMEOUT`). */
export function runGrep(job: GrepJob): Promise<GrepHits> {
  const failed = new ToolError("GREP_FAILED", "Matching failed.");
  return runWorkerJob<GrepHits>(job, grepLimits.timeoutMs, {
    timeout: new ToolError(
      "PATTERN_TIMEOUT",
      `The pattern took longer than ${grepLimits.timeoutMs / 1000} s and was stopped. Use a simpler pattern (no nested or adjacent open-ended quantifiers) or fewer messages.`,
    ),
    error: failed,
    exit: failed,
  });
}

function runWorkerJob<T>(
  job: ExtractJob | GrepJob,
  timeoutMs: number,
  errors: { timeout: ToolError; error: ToolError; exit: ToolError },
): Promise<T> {
  const { url, execArgv } = workerEntry();
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, {
      ...(execArgv ? { execArgv } : {}),
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    // Drain (and drop) library output so it can never reach the host's stdout.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error: ToolError | null, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) {
        reject(error);
      } else {
        resolve(value as T);
      }
    };
    const timer = setTimeout(() => finish(errors.timeout), timeoutMs);
    worker.once("message", (reply: WorkerReply | { ok: true; value: T }) =>
      reply.ok ? finish(null, reply.value as T) : finish(new ToolError(reply.code, reply.message)),
    );
    worker.once("error", () => finish(errors.error));
    worker.once("exit", () => finish(errors.exit));
    worker.postMessage(job);
  });
}
