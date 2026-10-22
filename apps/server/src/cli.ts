#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { serveStdio } from "@passport/mcp";
import { addAccount } from "./accounts.js";
import { apiToken, checkBind, getAuth } from "./auth.js";
import { serverClient } from "./cli/server-client.js";
import { createRealBackend } from "./compose.js";
import { loadConfig } from "./config.js";
import { createDemoBackend } from "./demo/index.js";
import { doctorCommand } from "./doctor.js";
import { ApiError } from "./errors.js";
import { resolveLlmSelection } from "./llm-selection.js";
import { logger } from "./logger.js";
import { readBootstrap, takeEnvironmentKey } from "./master-key.js";
import { authorizeOAuth } from "./oauth.js";
import { initializePassport } from "./onboarding/init.js";
import { acquireOwner, activeOwner } from "./owner-lock.js";
import { runJobsCommand } from "./schedulers/cli.js";
import { startServer } from "./server.js";
import { prepareHostEnvironment } from "./shell-env.js";

/** Exported for CLI tests; importing the package never starts a listener. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  // Before anything can spawn a child process that would inherit the key.
  readBootstrap();
  takeEnvironmentKey();
  const [command = "serve", subcommand, kind] = args;
  if (command === "mcp" && (subcommand === "install" || subcommand === "proxy")) {
    return (await import("./cli/mcp-install.js")).handleMcpCommand(args);
  }
  if (command === "jobs") {
    return runJobsCommand(args.slice(1));
  }
  if (command === "accounts" && subcommand === "connect") {
    return (await import("./setup/cli.js")).connectCommand(args.slice(2));
  }
  if (command === "init") {
    return initializePassport(undefined, args.slice(1));
  }
  if (command === "mcp" && ["--help", "-h", "help"].includes(subcommand ?? "")) {
    console.log(
      "passport mcp — mailbox tools over stdio (no background jobs)\npassport mcp install --client claude-code|codex|cursor|claude-desktop [--http] [--dry-run] [--user]",
    );
    return;
  }
  if (command === "doctor") {
    return doctorCommand(args.includes("--demo"));
  }
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(
      "passport init | doctor | serve [--allow-remote] | demo [--allow-remote] | token [--rotate] | sync [--demo] | triage <emailId> | accounts list [--demo] | accounts add <kind> [--demo] | accounts connect --provider gmail|microsoft [--no-calendar] [--agent codex|claude-code] | mcp | trust [--demo] | decisions [--demo] | jobs list|run|pause|resume|add-routine [--demo]",
    );
    return;
  }
  if (
    !["serve", "demo", "sync", "triage", "mcp", "accounts", "trust", "decisions", "token"].includes(
      command,
    )
  ) {
    throw new ApiError("INVALID_COMMAND", "Unknown command. Run passport --help.");
  }
  const config = await loadConfig();
  await prepareHostEnvironment(config, command);
  if (command === "token") {
    console.log(apiToken(config.dataDir, { rotate: args.includes("--rotate") }));
    return;
  }
  if (command === "serve" || command === "demo") {
    checkBind(config.host, args.includes("--allow-remote"), process.env, false);
  }
  if (["trust", "decisions", "sync", "triage"].includes(command) && !args.includes("--demo")) {
    const request = await serverClient(config);
    if (request) {
      if (command === "triage" && !subcommand) {
        throw new ApiError("INVALID_COMMAND", "Use triage <emailId>");
      }
      if (command === "sync") {
        const { accounts } = (await request("/api/accounts")) as { accounts: { id: string }[] };
        for (const account of accounts) {
          await request(`/api/accounts/${encodeURIComponent(account.id)}/sync`, "POST");
        }
        console.log("Sync complete.");
      } else {
        console.log(
          JSON.stringify(
            await request(
              command === "triage"
                ? `/api/agent/triage/${encodeURIComponent(subcommand!)}`
                : `/api/${command}`,
              command === "triage" ? "POST" : "GET",
            ),
            null,
            2,
          ),
        );
      }
      return;
    }
  }
  if (["serve", "sync", "triage"].includes(command) && !args.includes("--demo")) {
    await resolveLlmSelection(config, { log: command === "serve" });
  }
  let shutdownOwner: (() => void) | undefined;
  const owner = ["serve", "demo"].includes(command)
    ? acquireOwner(
        config.dataDir,
        () => {
          logger.error("Workspace owner lease lost; stopping background work.");
          process.exitCode = 1;
          shutdownOwner?.();
        },
        { host: config.host, port: config.port, mode: command === "demo" ? "demo" : "real" },
      )
    : undefined;
  let backend: Awaited<ReturnType<typeof createDemoBackend>>;
  try {
    backend =
      command === "demo" || (command !== "mcp" && args.includes("--demo"))
        ? await createDemoBackend(config)
        : await createRealBackend(config, {
            clientMode: command !== "serve",
            // Listing commands work without the master key; nothing they do needs credentials.
            readOnly:
              ["trust", "decisions"].includes(command) ||
              (command === "accounts" && subcommand === "list"),
          });
  } catch (error) {
    // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

    owner?.release();
    throw error;
  }
  const closeBackend = backend.close.bind(backend);
  backend.close = async () => {
    try {
      await closeBackend();
    } finally {
      owner?.release();
    }
  };
  if (command === "mcp") {
    if (!activeOwner(config.dataDir)) {
      console.error(
        "Passport serve is not running; stdio has no background jobs. Held/proposed actions wait for serve.",
      );
    }
    const server = backend.createMcpServer!();
    let closing: Promise<void> | undefined;
    const shutdown = () =>
      (closing ??= (async () => {
        await server.close();
        await backend.close();
      })());
    const previousClose = server.server.onclose;
    server.server.onclose = () => {
      previousClose?.();
      void shutdown();
    };
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
    try {
      await serveStdio(server);
    } catch (error) {
      // Preserve the existing error code and propagation after cleanup; do not expose raw payloads.

      await shutdown();
      throw error;
    }
    return;
  }
  if (command === "serve" || command === "demo") {
    const handle = startServer(backend, {
      allowRemote: args.includes("--allow-remote"),
    });
    void handle.ready.catch(() => {
      // MCP listener failed during startup.
      logger.warn("MCP listener failed during startup");

      process.exitCode = 1;
      void handle.close();
    });
    // Passport.app signs in with the token file itself and keeps the stdin pipe open while it
    // lives: EOF means its main process is gone, so stop rather than linger unowned.
    const desktop = process.env.PASSPORT_PARENT === "desktop";
    delete process.env.PASSPORT_PARENT;
    handle.server.on("listening", () => {
      const address = handle.server.address();
      const url = getAuth(backend).loginUrl(
        config.host,
        typeof address === "object" && address ? address.port : config.port,
      );
      logger.info(`${backend.mode} workspace → ${desktop ? new URL(url).origin : url}`);
    });
    handle.server.on("error", () => {
      logger.error("HTTP listener failed");
      void handle.close().finally(() => {
        process.exitCode = 1;
      });
    });
    const shutdown = () => {
      void handle.close().catch(() => {
        // MCP listener failed during shutdown.
        logger.warn("MCP listener failed during shutdown");

        process.exitCode = 1;
      });
    };
    shutdownOwner = shutdown;
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    if (desktop) {
      process.stdin.once("end", () => {
        logger.warn("Passport.app exited; stopping the server.");
        shutdown();
      });
      process.stdin.resume();
      // Watch the pipe without keeping the process alive once the server has closed.
      (process.stdin as { unref?: () => void }).unref?.();
    }
    return;
  }
  try {
    if (command === "triage") {
      if (!subcommand) {
        throw new ApiError("INVALID_COMMAND", "Use triage <emailId>");
      }
      console.log(
        JSON.stringify(
          await backend.agent.run({
            kind: "email.received",
            emailId: subcommand,
          }),
          null,
          2,
        ),
      );
    }
    if (command === "sync") {
      for (const account of await backend.store.accounts.list()) {
        await backend.syncAccount(account.id);
      }
      console.log("Sync complete.");
    }
    if (command === "trust") {
      console.log(
        JSON.stringify(
          {
            config: await backend.policy.getConfig(),
            categories: await backend.policy.getTrust(),
          },
          null,
          2,
        ),
      );
    }
    if (command === "decisions") {
      console.log(
        JSON.stringify(
          await backend.store.actions.query({ status: ["proposed", "held"] }),
          null,
          2,
        ),
      );
    }
    if (command === "accounts") {
      if (subcommand === "list") {
        console.log(JSON.stringify(await backend.store.accounts.list(), null, 2));
      } else if (subcommand === "add") {
        if (!backend.providerKinds.includes(kind as never)) {
          throw new ApiError(
            "INVALID_PROVIDER",
            `Choose a provider: ${backend.providerKinds.join(", ")}`,
          );
        }
        const descriptor = backend.providers.describe(kind as never),
          fields: Record<string, string> = {},
          output = new Writable({
            write(chunk, _encoding, done) {
              if (!muted) {
                stdout.write(chunk);
              }
              done();
            },
          });
        let muted = false;
        const rl = createInterface({
          input: stdin,
          output,
          terminal: !!stdout.isTTY,
        });
        try {
          const emailAddress = await rl.question("Email address: "),
            displayName = await rl.question("Display name: ");
          for (const field of descriptor.fields) {
            if (field.id === "emailAddress") {
              fields[field.id] = emailAddress;
            } else if (field.id === "displayName") {
              fields[field.id] = displayName;
            } else if (field.secret) {
              const env = `PASSPORT_SETUP_${field.id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
              if (process.env[env]) {
                fields[field.id] = process.env[env]!;
              } else if (field.id !== "codeVerifier") {
                stdout.write(`${field.label}${field.required ? "" : " (optional)"} (hidden): `);
                muted = true;
                try {
                  fields[field.id] = await rl.question("");
                } finally {
                  muted = false;
                  stdout.write("\n");
                }
              }
            } else {
              fields[field.id] = await rl.question(
                `${field.label}${field.required ? "" : " (optional)"}: `,
              );
            }
          }
          const credentials = descriptor.oauth
            ? await authorizeOAuth(descriptor, fields, {
                redirectUri: process.env.PASSPORT_OAUTH_REDIRECT_URI,
                onAuthUrl: (url, redirect) =>
                  console.log(
                    `Registered callback: ${redirect}\nOpen this URL to authorize Passport:\n${url}`,
                  ),
              })
            : undefined;
          const account = await addAccount(
            backend,
            {
              kind,
              emailAddress,
              displayName,
              fields,
            },
            credentials,
          );
          console.log(
            `Added ${account.displayName} (${account.id})${backend.mode === "demo" ? " for this ephemeral demo session" : ""}.`,
          );
        } finally {
          rl.close();
        }
      } else {
        throw new ApiError(
          "INVALID_COMMAND",
          "Use accounts list, accounts add <kind> or accounts connect --provider gmail|microsoft.",
        );
      }
    }
  } finally {
    await backend.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    // Keep the existing operational log and fallback; never include the caught payload.

    logger.error(
      error instanceof ApiError
        ? error.message
        : "Command failed. Check your configuration and provider credentials.",
    );
    process.exitCode = 1;
  });
}
