import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
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
    const finish = (error: ToolError | null, value?: Extracted) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) {
        reject(error);
      } else {
        resolve(value as Extracted);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new ToolError(
            "EXTRACTION_TIMEOUT",
            `Extraction took longer than ${Math.round(extraction.timeoutMs / 1000)} s and was stopped. Try a smaller pages or rows range.`,
          ),
        ),
      extraction.timeoutMs,
    );
    worker.once("message", (reply: WorkerReply) =>
      reply.ok ? finish(null, reply.value) : finish(new ToolError(reply.code, reply.message)),
    );
    worker.once("error", () =>
      finish(new ToolError("EXTRACTION_FAILED", "The attachment could not be parsed.")),
    );
    worker.once("exit", () =>
      finish(new ToolError("EXTRACTION_FAILED", "The extraction worker stopped unexpectedly.")),
    );
    worker.postMessage(job);
  });
}
