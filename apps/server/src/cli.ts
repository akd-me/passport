#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { realpathSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createRealBackend } from "./compose.js";
import { createDemoBackend } from "./demo/index.js";
import { addAccount } from "./accounts.js";
import { startServer } from "./server.js";
import { logger } from "./logger.js";
import { ApiError } from "./errors.js";

/** Exported for CLI tests; importing the package never starts a listener. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const [command = "serve", subcommand, kind] = args;
  if (command === "mcp") {
    console.error(
      "Mailbox MCP stdio will be wired at integration via createMailboxMcpServer. No MCP server was started.",
    );
    return;
  }
  if (command === "--help" || command === "help") {
    console.log(
      "passport serve | demo | sync [--demo] | accounts list [--demo] | accounts add <kind> [--demo] | mcp | trust [--demo] | decisions [--demo]",
    );
    return;
  }
  if (
    !["serve", "demo", "sync", "accounts", "trust", "decisions"].includes(
      command,
    )
  )
    throw new ApiError(
      "INVALID_COMMAND",
      "Unknown command. Run passport --help.",
    );
  const config = await loadConfig(),
    backend =
      command === "demo" || args.includes("--demo")
        ? await createDemoBackend(config)
        : await createRealBackend(config);
  if (command === "serve" || command === "demo") {
    const handle = startServer(backend);
    handle.server.on("listening", () => {
      const address = handle.server.address();
      logger.info(
        `${backend.mode} workspace → http://${config.host}:${typeof address === "object" && address ? address.port : config.port}`,
      );
    });
    handle.server.on("error", () => {
      logger.error("HTTP listener failed");
      void handle.close().finally(() => {
        process.exitCode = 1;
      });
    });
    const shutdown = () => {
      void handle.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  try {
    if (command === "sync") {
      for (const account of await backend.store.accounts.list())
        await backend.syncAccount(account.id);
      console.log("Sync complete.");
    }
    if (command === "trust")
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
    if (command === "decisions")
      console.log(
        JSON.stringify(
          await backend.store.actions.query({ status: ["proposed", "held"] }),
          null,
          2,
        ),
      );
    if (command === "accounts") {
      if (subcommand === "list")
        console.log(
          JSON.stringify(await backend.store.accounts.list(), null, 2),
        );
      else if (subcommand === "add") {
        if (!backend.providerKinds.includes(kind as never))
          throw new ApiError(
            "INVALID_PROVIDER",
            `Choose a provider: ${backend.providerKinds.join(", ")}`,
          );
        const descriptor = backend.providers.describe(kind as never),
          fields: Record<string, string> = {},
          rl = createInterface({ input: stdin, output: stdout });
        try {
          const emailAddress = await rl.question("Email address: "),
            displayName = await rl.question("Display name: ");
          for (const field of descriptor.fields) {
            if (field.id === "emailAddress") fields[field.id] = emailAddress;
            else if (field.id === "displayName") fields[field.id] = displayName;
            else if (field.secret) {
              // Secrets are never echoed by readline; supply them through a named environment variable.
              const env = `PASSPORT_SETUP_${field.id.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
              if (process.env[env]) fields[field.id] = process.env[env]!;
              else if (field.required)
                throw new ApiError(
                  "MISSING_CREDENTIAL",
                  `Set ${env} privately in your environment before adding this provider.`,
                );
            } else
              fields[field.id] = await rl.question(
                `${field.label}${field.required ? "" : " (optional)"}: `,
              );
          }
          const account = await addAccount(backend, {
            kind,
            emailAddress,
            displayName,
            fields,
          });
          console.log(
            `Added ${account.displayName} (${account.id})${backend.mode === "demo" ? " for this ephemeral demo session" : ""}.`,
          );
        } finally {
          rl.close();
        }
      } else
        throw new ApiError(
          "INVALID_COMMAND",
          "Use accounts list or accounts add <kind>.",
        );
    }
  } finally {
    await backend.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  void main().catch(() => {
    logger.error(
      "Command failed. Check configuration or run passport demo; real composition is pending integration.",
    );
    process.exitCode = 1;
  });
