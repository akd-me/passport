import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { SetupPromptKind, SetupProvider } from "@passport/types";

/** What the setup tools do for one task; implemented by the runner. */
export interface SetupToolHost {
  readonly provider: SetupProvider;
  stepIds(): string[];
  /** The answer, or null when the bounded wait ended first (the prompt stays shown). */
  askUser(kind: SetupPromptKind, message: string, signal: AbortSignal): Promise<string | null>;
  reportProgress(step: string, status: "running" | "done" | "failed" | "skipped", detail?: string): void;
  registerOAuthClient(input: { provider: SetupProvider; clientId: string; clientSecret?: string }): Promise<{ authorizationUrl: string; state: string; redirectUri: string }>;
  waitForConnection(state: string, signal: AbortSignal): Promise<{ status: "connected"; accountIds: string[]; address?: string } | { status: "waiting" } | { status: "failed"; error: string }>;
  finish(summary: string, success: boolean): void;
}

export class SetupTaskEnded extends Error {
  constructor() { super("The setup task has ended. Stop now; do not call any more tools."); }
}

const text = (value: string, isError = false) => ({ content: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) });
const fingerprint = (value: string) => createHash("sha256").update(value).digest();

/** Tool handlers, separated from transport so tests can call them directly. */
export function createSetupMcpServer(host: SetupToolHost, signal: AbortSignal): McpServer {
  const server = new McpServer({ name: "passport-setup", version: "1.0.0" });
  const guard = <A>(handler: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) => async (args: A) => {
    try { return await handler(args); }
    catch (error) {
      if (error instanceof SetupTaskEnded) return text(error.message, true);
      return text(error instanceof Error && "code" in error ? error.message : "The tool failed. Try again or ask the user.", true);
    }
  };
  const steps = host.stepIds() as [string, ...string[]];
  server.registerTool("ask_user", {
    description: "Show the user a message in Passport and wait for them. kind sign_in: they must sign in in the browser window. kind confirm: they must do or approve something in the browser. kind question: you need an answer (returned as text).",
    inputSchema: { kind: z.enum(["sign_in", "confirm", "question"]), message: z.string().trim().min(1).max(500) },
  }, guard(async ({ kind, message }: { kind: SetupPromptKind; message: string }) => {
    const answer = await host.askUser(kind, message, signal);
    if (answer === null) return text("The user has not answered yet; the message is still shown. Call ask_user again with the same kind and message to keep waiting.");
    return text(kind === "question" ? `The user answered: ${answer}` : "The user clicked Continue. Take a browser_snapshot to see the current page.");
  }));
  server.registerTool("report_progress", {
    description: "Update the user's setup checklist.",
    inputSchema: { step: z.enum(steps), status: z.enum(["running", "done", "failed", "skipped"]), detail: z.string().max(300).optional() },
  }, guard(({ step, status, detail }: { step: string; status: "running" | "done" | "failed" | "skipped"; detail?: string }) => {
    host.reportProgress(step, status, detail);
    return text("Recorded.");
  }));
  server.registerTool("register_oauth_client", {
    description: "Give Passport the OAuth client you created. Passport stores it encrypted and returns an authorizationUrl to open in the browser plus a state for wait_for_connection.",
    inputSchema: { provider: z.enum(["gmail", "microsoft"]), clientId: z.string().trim().min(8).max(300), clientSecret: z.string().trim().min(4).max(300).optional() },
  }, guard(async (input: { provider: SetupProvider; clientId: string; clientSecret?: string }) => {
    const result = await host.registerOAuthClient(input);
    return text(JSON.stringify({ ...result, next: "Navigate the browser to authorizationUrl, ask the user (kind confirm) to approve access, then call wait_for_connection with this state." }));
  }));
  server.registerTool("wait_for_connection", {
    description: "Wait until the user has approved access and Passport has connected the mailbox.",
    inputSchema: { state: z.string().trim().min(1).max(200) },
  }, guard(async ({ state }: { state: string }) => {
    const result = await host.waitForConnection(state, signal);
    if (result.status === "connected") return text(`Connected${result.address ? ` ${result.address}` : ""}. Call finish now.`);
    if (result.status === "waiting") return text("Not connected yet. Check the browser (take a snapshot); if the user is still on the consent page, call wait_for_connection again.");
    return text(`Authorization failed: ${result.error}`, true);
  }));
  server.registerTool("finish", {
    description: "End the setup task. Call exactly once, then stop.",
    inputSchema: { summary: z.string().trim().min(1).max(500), success: z.boolean().optional() },
  }, guard(({ summary, success }: { summary: string; success?: boolean }) => {
    host.finish(summary, success !== false);
    return text("Done. Stop now.");
  }));
  return server;
}

interface Binding {
  host: SetupToolHost;
  controller: AbortController;
}

/**
 * Streamable HTTP MCP endpoint on 127.0.0.1 for setup agents. Each task gets its own random
 * bearer token, bound to that task; releasing the binding revokes the token and aborts the
 * task's pending tool calls. The listener closes when no task is bound.
 */
export class SetupMcpListener {
  private readonly bindings = new Map<string, Binding>();
  private server?: Server;
  private listening?: Promise<number>;

  async bind(host: SetupToolHost): Promise<{ url: string; token: string; release(): Promise<void> }> {
    const token = randomBytes(32).toString("base64url");
    const binding = { host, controller: new AbortController() };
    this.bindings.set(token, binding);
    let port: number;
    try { port = await this.listen(); }
    catch (error) { this.bindings.delete(token); throw error; }
    return {
      url: `http://127.0.0.1:${port}/mcp`,
      token,
      release: async () => {
        if (!this.bindings.delete(token)) return;
        binding.controller.abort();
        if (!this.bindings.size) await this.close();
      },
    };
  }

  /** Bound token, or undefined. Exposed for tests. */
  resolve(authorization: string | undefined): Binding | undefined {
    if (!authorization?.startsWith("Bearer ")) return;
    const presented = fingerprint(authorization.slice(7));
    for (const [token, binding] of this.bindings) if (timingSafeEqual(presented, fingerprint(token))) return binding;
    return;
  }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res, server));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.unref();
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
      this.server = server;
    });
    return this.listening.catch(error => { this.listening = undefined; this.server = undefined; throw error; });
  }

  private async handle(req: IncomingMessage, res: ServerResponse, server: Server): Promise<void> {
    const fail = (status: number, message: string) => {
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
      else res.end();
    };
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return fail(403, "Invalid Host.");
      if (req.headers.origin) return fail(403, "Browsers may not call this endpoint.");
      const binding = this.resolve(req.headers.authorization);
      if (!binding) { res.setHeader("WWW-Authenticate", "Bearer"); return fail(401, "Bearer token required."); }
      if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/mcp") return fail(404, "Not found.");
      if (req.method !== "POST") { res.setHeader("Allow", "POST"); return fail(405, "Method not allowed."); }
      // Stateless: one server per request; tool calls may block for minutes waiting on the user.
      const request = new AbortController();
      const signal = AbortSignal.any([binding.controller.signal, request.signal]);
      res.on("close", () => request.abort());
      const mcp = createSetupMcpServer(binding.host, signal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      fail(500, "Setup MCP transport failed.");
    }
  }

  async close(): Promise<void> {
    for (const binding of this.bindings.values()) binding.controller.abort();
    this.bindings.clear();
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
