import { createRealBackend } from "../compose.js";
import { loadConfig } from "../config.js";
import { createDemoBackend } from "../demo/index.js";
import { ApiError } from "../errors.js";
import { getSchedulerService } from "./service.js";

/** Use a running server when available; otherwise operate on the local store without timers. */
export async function runJobsCommand(args: string[]) {
  const [command, id] = args;
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i < 0 ? undefined : args[i + 1];
  };
  const routine = {
    name: value("--name"),
    schedule: {
      type: "daily",
      at: value("--daily"),
      timeZone: value("--time-zone"),
    },
    routine: { instruction: value("--instruction") },
  };
  if (
    command !== "list" &&
    command !== "add-routine" &&
    (!["run", "pause", "resume"].includes(command ?? "") ||
      !id ||
      id.startsWith("--"))
  )
    throw new ApiError(
      "INVALID_COMMAND",
      "Use jobs list | run <id> | pause <id> | resume <id> | add-routine --name NAME --daily HH:MM --instruction TEXT [--time-zone ZONE] [--demo]",
    );
  const config = await loadConfig();
  if (!args.includes("--demo")) {
    const base = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`;
    let available = false;
    try {
      const health = await fetch(`${base}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const body = (await health.json()) as { ok?: boolean; mode?: string };
      available = health.ok && body.ok === true && body.mode === "real";
    } catch {
      /* No live server: the local command still works. */
    }
    if (available) {
      const path =
        command === "list" || command === "add-routine"
          ? "/api/jobs"
          : `/api/jobs/${encodeURIComponent(id!)}/${command}`;
      const response = await fetch(`${base}${path}`, {
        method: command === "list" ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        body: command === "add-routine" ? JSON.stringify(routine) : undefined,
      });
      const result = (await response.json()) as {
        error?: { code: string; message: string };
      };
      if (!response.ok)
        throw new ApiError(
          result.error?.code ?? "REQUEST_FAILED",
          result.error?.message ?? "Job command failed",
        );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  }
  const backend = args.includes("--demo")
    ? await createDemoBackend(config)
    : await createRealBackend(config);
  const service = getSchedulerService(backend);
  try {
    await service.ready;
    const result =
      command === "list"
        ? service.list()
        : command === "add-routine"
          ? await service.addRoutine(routine)
          : command === "run"
            ? await service.scheduler.runNow(id!)
            : await service.scheduler[command as "pause" | "resume"](id!);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await service.stop();
    await backend.close();
  }
}
