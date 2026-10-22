// Fake extraction worker for the timeout test: accepts the job and never answers.
import { parentPort } from "node:worker_threads";

parentPort.once("message", () => {
  setInterval(() => {}, 1000);
});
