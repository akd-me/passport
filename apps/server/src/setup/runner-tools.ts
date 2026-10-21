import { randomBytes } from "node:crypto";
import type { SetupPromptKind } from "@passport/types";
import { ApiError } from "../errors.js";
import { SetupTaskEnded, type SetupToolHost } from "./mcp.js";
import { deferred, type Run, type SetupRunnerOptions, type Ticket } from "./runner-state.js";
import { scrubAgentText } from "./task.js";

export function createSetupToolHost(
  run: Run,
  context: {
    options: SetupRunnerOptions;
    waitMs: number;
    pollMs: number;
    tickets: Map<string, Ticket>;
  },
): SetupToolHost {
  const { state } = run;
  const ended = () => {
    if (state.terminal || run.controller.signal.aborted) {
      throw new SetupTaskEnded();
    }
  };
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  return {
    provider: run.input.provider,
    stepIds: () => state.stepIds().filter((id) => id !== "prepare"),
    askUser: async (kind: SetupPromptKind, message: string, signal: AbortSignal) => {
      ended();
      // One message at a time: a second, different one would hide a prompt still awaited.
      const shown = state.prompt;
      if (shown && (run.asking.get(shown.id) ?? 0) > 0 && !state.showing(kind, message)) {
        throw new ApiError(
          "PROMPT_BUSY",
          "Another message is still waiting for the user. Wait for that ask_user call to return before asking something else.",
        );
      }
      const prompt = state.ask(kind, message);
      run.asking.set(prompt.id, (run.asking.get(prompt.id) ?? 0) + 1);
      if (prompt.kind === "sign_in") {
        state.log("info", "Waiting for you to sign in in the browser window.");
      }
      let waiting = run.answers.get(prompt.id);
      if (!waiting) {
        waiting = deferred<string>();
        run.answers.set(prompt.id, waiting);
      }
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), context.waitMs);
      try {
        const stop = AbortSignal.any([signal, timeout.signal]);
        const answer = await Promise.race([
          waiting.promise,
          new Promise<null>((resolve) => {
            if (stop.aborted) {
              resolve(null);
            }
            stop.addEventListener("abort", () => resolve(null), { once: true });
          }),
        ]);
        if (answer !== null) {
          run.answers.delete(prompt.id);
        }
        ended();
        return answer;
      } finally {
        clearTimeout(timer);
        const callers = (run.asking.get(prompt.id) ?? 1) - 1;
        if (callers > 0) {
          run.asking.set(prompt.id, callers);
        } else {
          run.asking.delete(prompt.id);
        }
      }
    },
    reportProgress: (step, status, detail) => {
      ended();
      state.step(step, status, detail);
    },
    registerOAuthClient: async (input) => {
      ended();
      if (input.provider !== run.input.provider) {
        throw new ApiError("INVALID_PROVIDER", `This task sets up ${run.input.provider}`);
      }
      state.addSecret(input.clientSecret);
      const attempt = await context.options.oauth.start(
        {
          kind: input.provider === "gmail" ? "gmail" : "graph",
          clientId: input.clientId,
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
          calendar: run.input.calendar,
        },
        run.origin,
        // A consent that lands after the task ended must not connect an account.
        { active: () => !state.terminal && !run.controller.signal.aborted },
      );
      run.attempts.add(attempt.attemptId);
      if (state.terminal || run.controller.signal.aborted) {
        context.options.oauth.revoke(attempt.attemptId);
      }
      ended();
      const ticket = randomBytes(24).toString("base64url");
      state.addSecret(ticket);
      state.addSecret(attempt.attemptId);
      context.tickets.set(ticket, {
        run,
        state: attempt.attemptId,
        nonce: attempt.nonce,
        authUrl: attempt.authUrl,
        expiresAt: Date.now() + 10 * 60_000,
      });
      state.step("authorize", "running", "Waiting for you to approve access");
      state.log(
        "info",
        "Passport stored the new OAuth client. Approve access in the browser window.",
      );
      return {
        authorizationUrl: `${run.origin}/oauth/setup/${ticket}`,
        state: attempt.attemptId,
        redirectUri: attempt.redirectUri,
      };
    },
    waitForConnection: async (attemptId, signal) => {
      ended();
      if (!run.attempts.has(attemptId)) {
        throw new ApiError("UNKNOWN_STATE", "Use the state that register_oauth_client returned");
      }
      const deadline = Date.now() + context.waitMs;
      while (!signal.aborted && Date.now() < deadline) {
        const status = context.options.oauth.peek(attemptId);
        if (!status) {
          return {
            status: "failed",
            error: "Authorization expired. Call register_oauth_client again to get a new link.",
          };
        }
        if (status.status === "connected" && status.accountId) {
          const accounts = await context.options.listAccounts();
          const linked = accounts.filter(
            (account) =>
              account.id === status.accountId || account.settings.oauthGroup === status.accountId,
          );
          const address = linked.find((account) => account.id === status.accountId)?.emailAddress;
          state.connect(linked.map((account) => account.id));
          state.step("authorize", "done", address ? `Connected ${address}` : "Connected");
          state.log("info", `Connected ${address ?? "the mailbox"}; the first sync is running.`);
          return {
            status: "connected",
            accountIds: linked.map((account) => account.id),
            ...(address ? { address } : {}),
          };
        }
        if (status.status === "failed") {
          const error = status.error ?? "Authorization failed";
          state.step("authorize", "failed", error);
          return { status: "failed", error };
        }
        await sleep(context.pollMs, signal);
      }
      ended();
      return { status: "waiting" };
    },
    finish: (summary, success) => {
      ended();
      state.log(success ? "info" : "warn", `Agent: ${scrubAgentText(summary)}`);
      if (success && state.connected) {
        state.complete();
      } else {
        state.fail(
          state.connected
            ? summary
            : success
              ? `The agent finished, but no mailbox was connected. ${summary}`
              : summary,
        );
      }
      // The agent was told to stop; do not let a lingering session hold the browser.
      const session = run.session;
      setTimeout(() => session?.cancel(), context.options.finishGraceMs ?? 20_000).unref();
    },
  };
}
