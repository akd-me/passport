import { parentPort } from "node:worker_threads";
import { type ExtractJob, replyFor } from "./extract.js";

/**
 * Extraction worker entry (one job per worker). Libraries log through `console`; a worker's
 * stdout is the host's, which for the MCP stdio server is the protocol stream, so it is muted.
 */
for (const method of ["log", "info", "warn", "debug", "error", "trace"] as const) {
  console[method] = () => {};
}

parentPort?.once("message", async (job: ExtractJob) => {
  parentPort?.postMessage(await replyFor(job));
});
