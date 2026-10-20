import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmConfig, ProviderSetupDescriptor } from "@passport/types";
import { createRealBackend } from "../compose.js";
import { loadConfig, saveConfig } from "../config.js";
import { addAccount } from "../accounts.js";
import { authorizeOAuth } from "../oauth.js";
import { connectOAuthAccount, scopesFor } from "./oauth.js";
import { probeAccount } from "../doctor.js";
import { ApiError } from "../errors.js";

export interface InitPrompts {
  ask: (label: string, secret?: boolean) => Promise<string>;
  log: (text: string) => void;
  close: () => void;
}
function terminalPrompts(): InitPrompts {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({
    input: stdin,
    output,
    terminal: !!stdout.isTTY,
  });
  return {
    async ask(label, secret = false) {
      if (secret && !stdin.isTTY)
        throw new ApiError(
          "SECRET_INPUT",
          "Enter secrets in an interactive terminal, or set PASSPORT_LLM_API_KEY / PASSPORT_SETUP_PASSWORD / PASSPORT_SETUP_CLIENTSECRET",
        );
      if (secret) {
        stdout.write(`${label} (hidden): `);
        muted = true;
      }
      try {
        return (await rl.question(secret ? "" : `${label}: `)).trim();
      } finally {
        if (secret) {
          muted = false;
          stdout.write("\n");
        }
      }
    },
    log: console.log,
    close: () => rl.close(),
  };
}

/** Own-client loopback setup; the existing one-shot listener validates state and PKCE. */
export async function initializePassport(
  prompts: InitPrompts = terminalPrompts(),
): Promise<void> {
  let backend: Awaited<ReturnType<typeof createRealBackend>> | undefined;
  try {
    const config = await loadConfig();
    prompts.log(`Passport setup → ${config.dataDir}`);
    const provider =
      (await prompts.ask(
        "LLM provider (anthropic / openai / openai-compatible / ollama / none) [none]",
      )) || "none";
    let enteredKey: string | undefined;
    if (provider !== "none") {
      if (
        !["anthropic", "openai", "openai-compatible", "ollama"].includes(
          provider,
        )
      )
        throw new ApiError(
          "INVALID_PROVIDER",
          "Choose one of the listed LLM providers",
        );
      const defaults = {
        anthropic: "claude-sonnet-4-5",
        openai: "gpt-4.1",
        "openai-compatible": "local-model",
        ollama: "llama3.2",
      };
      const model =
        (await prompts.ask(
          `Model [${defaults[provider as keyof typeof defaults]}]`,
        )) || defaults[provider as keyof typeof defaults];
      const baseUrl = ["ollama", "openai-compatible"].includes(provider)
        ? await prompts.ask(
            `Base URL [${provider === "ollama" ? "http://localhost:11434/v1" : "required"}]`,
          )
        : "";
      enteredKey =
        process.env.PASSPORT_LLM_API_KEY ||
        (provider === "ollama"
          ? ""
          : await prompts.ask(
              "API key (optional for a local compatible server)",
              true,
            ));
      config.llm = {
        provider: provider as LlmConfig["provider"],
        model,
        ...(baseUrl ? { baseUrl } : {}),
        ...(enteredKey ? { apiKey: enteredKey } : {}),
      };
    } else config.llm = { provider: "anthropic", model: "claude-sonnet-4-5" };
    await saveConfig(config);
    // This key was explicitly entered for persistence; environment-only keys remain in the environment.
    if (
      (enteredKey && !process.env.PASSPORT_LLM_API_KEY) ||
      provider === "none"
    ) {
      const target = join(config.dataDir, "passport.config.json"),
        temp = `${target}.${crypto.randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temp, target);
    }
    backend = await createRealBackend(config);
    const kind =
      (await prompts.ask(
        "First account (gmail / graph / imap / skip) [skip]",
      )) || "skip";
    if (kind === "gmail" || kind === "graph") {
      prompts.log(
        kind === "gmail"
          ? "Google Cloud → Google Auth Platform → Clients → Create client → Desktop app."
          : "Azure portal → App registrations → Authentication → Add a platform → Mobile and desktop applications. Enable public client flows.",
      );
      const clientId = await prompts.ask("OAuth client ID"),
        clientSecret =
          process.env.PASSPORT_SETUP_CLIENTSECRET ||
          (await prompts.ask("OAuth client secret (optional)", true));
      if (!clientId)
        throw new ApiError("MISSING_FIELD", "OAuth client ID is required");
      const calendar =
        (await prompts.ask("Connect calendar too? [Y/n]")).toLowerCase() !==
        "n";
      const descriptor: ProviderSetupDescriptor =
        backend.providers.describe(kind);
      const credentials = await authorizeOAuth(
        descriptor,
        {
          clientId,
          clientSecret,
          tenantId: "common",
          scopes: scopesFor(kind, calendar).join(" "),
        },
        {
          redirectUri: process.env.PASSPORT_OAUTH_REDIRECT_URI,
          timeoutMs: 600000,
          onAuthUrl: (url, redirect) =>
            prompts.log(
              `Callback URI: ${redirect}\nOpen this URL in your browser:\n${url}\nWaiting for authorization…`,
            ),
        },
      );
      const account = await connectOAuthAccount(
        backend,
        { kind, clientId, calendar },
        credentials,
      );
      prompts.log(
        `Connected ${account.emailAddress}. Initial sync is running.`,
      );
    } else if (kind === "imap") {
      const emailAddress = await prompts.ask("Email address"),
        host = await prompts.ask("IMAP host"),
        port = (await prompts.ask("IMAP port [993]")) || "993";
      const tls =
        (await prompts.ask("Use implicit TLS? [Y/n]")).toLowerCase() !== "n";
      const username =
        (await prompts.ask(`Username [${emailAddress}]`)) || emailAddress;
      const password =
        process.env.PASSPORT_SETUP_PASSWORD ||
        (await prompts.ask("App password", true));
      const smtpHost = await prompts.ask("SMTP host"),
        smtpPort = (await prompts.ask("SMTP port [465]")) || "465";
      const smtpTls = smtpPort !== "587";
      const account = await addAccount(backend, {
        kind,
        emailAddress,
        fields: {
          host,
          port,
          tls: String(tls),
          username,
          password,
          smtpHost,
          smtpPort,
          smtpTls: String(smtpTls),
        },
      });
      await probeAccount(backend, account, { password });
      await backend.syncAccount(account.id);
      prompts.log(`Connected ${emailAddress}.`);
    } else if (kind !== "skip")
      throw new ApiError(
        "INVALID_PROVIDER",
        "Choose gmail, graph, imap or skip",
      );
    prompts.log(
      `Configuration saved. Run passport serve, then open http://${config.host}:${config.port}/accounts`,
    );
  } finally {
    prompts.close();
    await backend?.close();
  }
}
