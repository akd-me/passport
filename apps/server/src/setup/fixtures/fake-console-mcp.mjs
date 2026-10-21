// Stand-in for Playwright MCP in live setup tests: a scripted "Google Cloud console" with no
// network. The page is a sign-in form until FAKE_CONSOLE_SIGNED_IN exists (the test creates
// it when the agent asks the user to sign in), then an already-configured project whose new
// desktop client is on screen. Every call is appended to FAKE_CONSOLE_LOG.
import { appendFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const log = (line) => { if (process.env.FAKE_CONSOLE_LOG) appendFileSync(process.env.FAKE_CONSOLE_LOG, `${line}\n`); };
let url = "about:blank";

function page() {
  if (url.includes("/oauth/setup/"))
    return `- Page URL: https://accounts.google.com/signin/oauth/consent
- Page Title: Sign in - Google Accounts
\`\`\`yaml
- heading "Passport wants access to your Google Account" [ref=c1]
- text: "alex@example.com"
- text: "Read, compose, send and manage your email. View and edit events on your calendars."
- button "Cancel" [ref=c2]
- button "Continue" [ref=c3]
\`\`\``;
  if (!existsSync(process.env.FAKE_CONSOLE_SIGNED_IN ?? "/nonexistent"))
    return `- Page URL: https://accounts.google.com/v3/signin/identifier?continue=https://console.cloud.google.com/
- Page Title: Sign in - Google Accounts
\`\`\`yaml
- heading "Sign in" [ref=e1]
- text: "to continue to Google Cloud Platform"
- textbox "Email or phone" [ref=e2]
- button "Next" [ref=e3]
\`\`\``;
  return `- Page URL: https://console.cloud.google.com/auth/clients?project=passport-4711
- Page Title: Clients – Google Auth Platform – Passport – Google Cloud console
\`\`\`yaml
- button "Account: alex@example.com" [ref=e10]
- button "Project: Passport (passport-4711)" [ref=e11]
- text: "APIs & Services: Gmail API — Enabled. Google Calendar API — Enabled."
- text: "Google Auth Platform — Branding: app name Passport, support email alex@example.com. Audience: External, Testing. Test users: alex@example.com. Data access: openid, email, https://www.googleapis.com/auth/gmail.modify, https://www.googleapis.com/auth/calendar.events."
- dialog "OAuth client created" [ref=e20]:
  - text: "Name: Passport. Application type: Desktop app."
  - text: "Client ID"
  - textbox "Client ID" [ref=e21]: 4711-fakeclient.apps.googleusercontent.com
  - text: "Client secret"
  - textbox "Client secret" [ref=e22]: GOCSPX-fake-secret-4711
  - button "Download JSON" [ref=e23]
  - button "OK" [ref=e24]
\`\`\``;
}
const reply = (prefix = "") => ({ content: [{ type: "text", text: `${prefix}### Page\n${page()}` }] });

const server = new McpServer({ name: "browser", version: "1.0.0" });
server.registerTool("browser_navigate", { description: "Navigate to a URL", inputSchema: { url: z.string() } }, async (args) => {
  url = args.url;
  log(`navigate ${args.url}`);
  return reply();
});
server.registerTool("browser_snapshot", { description: "Capture an accessibility snapshot of the current page", inputSchema: {} }, async () => {
  log("snapshot");
  return reply();
});
server.registerTool("browser_click", { description: "Click an element", inputSchema: { element: z.string().optional(), target: z.string().optional(), ref: z.string().optional() } }, async (args) => {
  log(`click ${args.target ?? args.ref ?? ""} ${args.element ?? ""}`);
  return reply();
});
server.registerTool("browser_type", { description: "Type text into an element", inputSchema: { element: z.string().optional(), target: z.string().optional(), ref: z.string().optional(), text: z.string() } }, async (args) => {
  log(`type ${args.target ?? args.ref ?? ""}`);
  return reply();
});
server.registerTool("browser_take_screenshot", { description: "Take a screenshot", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "Screenshots are not available here; use browser_snapshot." }] }));
await server.connect(new StdioServerTransport());
