import { parentPort } from "node:worker_threads";
import { type GrepJob, matchLines } from "../grep-match.js";
import { type ExtractJob, replyFor } from "./extract.js";

/**
 * Worker entry for CPU-bound work on untrusted input (one job per worker): attachment
 * extraction, and `mail_grep` matching so a catastrophic pattern cannot stall the host.
 * Libraries log through `console`; a worker's stdout is the host's, which for the MCP stdio
 * server is the protocol stream, so it is muted.
 */
for (const method of ["log", "info", "warn", "debug", "error", "trace"] as const) {
  console[method] = () => {};
}

parentPort?.once("message", async (job: ExtractJob | GrepJob) => {
  if ("grep" in job) {
    parentPort?.postMessage({ ok: true, value: matchLines(job.grep) });
    return;
  }
  parentPort?.postMessage(await replyFor(job));
});
