import { access, stat, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Account,
  AccountCredentials,
  CalendarProvider,
  MailProvider,
} from "@passport/types";
import type { Backend } from "./backend.js";
import { llmConfigured, loadConfig, validateConfig } from "./config.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
  accountId?: string;
}
export interface DoctorReport {
  at: string;
  checks: DoctorCheck[];
  ok: boolean;
}
type ProbeProvider = (MailProvider | CalendarProvider) & {
  checkConnection?: () => Promise<void>;
};

/** A fresh read-only connection validates OAuth refresh and service reachability. */
export async function probeAccount(
  backend: Backend,
  account: Account,
  credentials: AccountCredentials,
): Promise<void> {
  const provider: ProbeProvider = account.capabilities.mail
    ? backend.providers.mail(account.kind as MailProvider["kind"])
    : backend.providers.calendar(account.kind as CalendarProvider["kind"]);
  try {
    await provider.connect(account, credentials);
    if (provider.checkConnection) await provider.checkConnection();
    else if ("listCalendars" in provider) await provider.listCalendars();
    else {
      const iterator = provider
        .sync(null, { maxEmails: 1 })
        [Symbol.asyncIterator]();
      try {
        await iterator.next();
      } finally {
        await iterator.return?.();
      }
    }
  } finally {
    await provider.disconnect().catch(() => undefined);
  }
}

/** Diagnostics never expose remote error bodies, keys, or token-bearing URLs. */
export async function runDoctor(
  backend: Backend,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    probe?: typeof probeAccount;
  } = {},
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [],
    now = options.now?.() ?? Date.now();
  const check = async (
    name: string,
    operation: () => Promise<string>,
    accountId?: string,
  ) => {
    try {
      checks.push({ name, status: "ok", detail: await operation(), accountId });
    } catch {
      checks.push({
        name,
        status: "error",
        detail: "Check failed; review configuration and connection settings.",
        accountId,
      });
    }
  };
  if (backend.mode === "demo")
    checks.push({
      name: "Storage",
      status: "ok",
      detail: "Demo uses ephemeral storage.",
    });
  else {
    await check("Data directory", async () => {
      const probe = join(
        backend.config.dataDir,
        `.doctor-${crypto.randomUUID()}`,
      );
      await writeFile(probe, "", { flag: "wx", mode: 0o600 });
      await unlink(probe);
      return "Writable";
    });
    await check("Master key", async () => {
      if (process.env.PASSPORT_MASTER_KEY) return "Configured in environment";
      const key = await stat(join(backend.config.dataDir, "master.key"));
      if (!key.isFile() || (key.mode & 0o777) !== 0o600 || key.size < 32)
        throw new Error();
      return "Present, mode 0600";
    });
  }
  await check("Configuration", async () => {
    validateConfig(backend.config);
    return "Valid";
  });
  if (backend.mode === "demo" || !llmConfigured(backend.config.llm))
    checks.push({
      name: "LLM",
      status: "warning",
      detail:
        backend.mode === "demo"
          ? "Demo agent; no network ping"
          : "No model key configured. Mail sync remains available.",
    });
  else
    await check("LLM", async () => {
      const llm = backend.config.llm,
        anthropic = llm.provider === "anthropic";
      const base =
        llm.baseUrl ??
        (anthropic
          ? "https://api.anthropic.com/v1"
          : llm.provider === "ollama"
            ? "http://localhost:11434/v1"
            : "https://api.openai.com/v1");
      const endpoint = new URL(base);
      if (
        !["http:", "https:"].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.search ||
        endpoint.hash
      )
        throw new Error();
      endpoint.pathname = endpoint.pathname.replace(/\/$/, "") || "/v1";
      endpoint.pathname += anthropic ? "/messages" : "/chat/completions";
      const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          "content-type": "application/json",
          ...(anthropic
            ? { "x-api-key": llm.apiKey!, "anthropic-version": "2023-06-01" }
            : llm.apiKey
              ? { authorization: `Bearer ${llm.apiKey}` }
              : {}),
        },
        body: JSON.stringify({
          model: llm.model,
          messages: [{ role: "user", content: "Reply OK" }],
          ...(llm.provider === "openai"
            ? { max_completion_tokens: 1 }
            : { max_tokens: 1 }),
        }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error();
      return "One-token request accepted";
    });
  for (const account of await backend.store.accounts.list()) {
    const name = `${account.emailAddress} (${account.kind})`;
    if (backend.mode === "demo")
      checks.push({
        name,
        status: "warning",
        detail: "Demo account; provider network checks are disabled.",
        accountId: account.id,
      });
    else if (account.settings.reauthorizationRequired === true)
      checks.push({
        name,
        status: "error",
        detail: "Re-authorize this account from Accounts.",
        accountId: account.id,
      });
    else
      await check(
        name,
        async () => {
          const credentials =
            (await backend.store.accounts.getCredentials(account.id)) ?? {};
          await (options.probe ?? probeAccount)(backend, account, credentials);
          return [
            "gmail",
            "graph",
            "google-calendar",
            "graph-calendar",
          ].includes(account.kind)
            ? "Provider reachable; token valid or refreshed"
            : "Provider reachable; authentication accepted";
        },
        account.id,
      );
    const age = account.lastSyncAt
      ? now - Date.parse(account.lastSyncAt)
      : Infinity;
    checks.push({
      name: `${account.emailAddress} sync`,
      accountId: account.id,
      status:
        age <= Math.max(600000, backend.config.syncIntervalSeconds * 3000) &&
        !account.lastSyncError
          ? "ok"
          : "warning",
      detail:
        account.lastSyncError ??
        (Number.isFinite(age)
          ? `Last success ${Math.max(0, Math.floor(age / 60000))} minutes ago`
          : "Initial sync has not completed"),
    });
  }
  const policy = await backend.policy.getConfig();
  checks.push({
    name: "Outbox hold",
    status: policy.outboxHoldMinutes > 0 ? "ok" : "warning",
    detail: `${policy.outboxHoldMinutes} minutes`,
  });
  await check("MCP stdio", async () => {
    await access(process.execPath, constants.X_OK);
    // Compiled package ships cli.js; a from-source run (tsx) has cli.ts next to this file.
    const candidates = ["./cli.js", "./cli.ts"].map((rel) => fileURLToPath(new URL(rel, import.meta.url)));
    let cli: string | null = null;
    for (const candidate of candidates) {
      try {
        await access(candidate);
        cli = candidate;
        break;
      } catch {
        /* try next */
      }
    }
    if (!cli) throw new Error(`CLI entry not found next to ${import.meta.url}`);
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} mcp`;
  });
  return {
    at: new Date(now).toISOString(),
    checks,
    ok: !checks.some((c) => c.status === "error"),
  };
}

export function printDoctor(report: DoctorReport): void {
  console.table(
    report.checks.map(({ name, status, detail }) => ({
      Check: name,
      Status: status,
      Detail: detail,
    })),
  );
}

/** Inspect prerequisites before composition can create a directory or repair key permissions. */
export async function doctorCommand(demo = false): Promise<void> {
  let config;
  try {
    config = await loadConfig();
  } catch {
    printDoctor({
      at: new Date().toISOString(),
      ok: false,
      checks: [
        {
          name: "Configuration",
          status: "error",
          detail:
            "Cannot load passport.config.json; fix its JSON and configuration values.",
        },
      ],
    });
    process.exitCode = 1;
    return;
  }
  if (!demo) {
    const checks: DoctorCheck[] = [];
    try {
      await access(config.dataDir, constants.W_OK);
    } catch {
      checks.push({
        name: "Data directory",
        status: "error",
        detail:
          "Missing or not writable. Run passport init to create a workspace.",
      });
    }
    if (!process.env.PASSPORT_MASTER_KEY) {
      try {
        const key = await stat(join(config.dataDir, "master.key"));
        if (!key.isFile() || (key.mode & 0o777) !== 0o600 || key.size < 32)
          throw new Error();
      } catch {
        checks.push({
          name: "Master key",
          status: "error",
          detail:
            "Missing, empty or not mode 0600. Initialize a new workspace, or restore its existing private master key.",
        });
      }
    }
    if (checks.length) {
      printDoctor({ at: new Date().toISOString(), ok: false, checks });
      process.exitCode = 1;
      return;
    }
  }
  const backend = demo
    ? await (await import("./demo/index.js")).createDemoBackend(config)
    : await (await import("./compose.js")).createRealBackend(config, { clientMode: true });
  try {
    const report = await runDoctor(backend);
    printDoctor(report);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await backend.close();
  }
}
