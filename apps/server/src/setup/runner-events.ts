import { logger } from "../logger.js";

/** One readable log line per meaningful browser action; reads are omitted, typed text never logged. */
export function describeBrowserCall(name: string, input: unknown): string | undefined {
  const match = /^mcp__browser__(?:browser_)?(.+)$/.exec(name);
  if (!match) {
    return;
  }
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const element = typeof args.element === "string" ? args.element.slice(0, 80) : undefined;
  const tool = match[1]!;
  switch (tool) {
    case "navigate": {
      try {
        const url = new URL(String(args.url));
        return `Browser: opened ${url.origin}${url.pathname.startsWith("/oauth/setup/") ? "/oauth/setup/…" : url.pathname}`;
      } catch {
        // Browser URL could not be summarized safely.
        logger.warn("Browser URL could not be summarized safely");

        return "Browser: opened a page";
      }
    }
    case "click":
      return `Browser: clicked ${element ?? "an element"}`;
    case "type":
    case "fill_form":
      return `Browser: filled in ${element ?? "a form"}`;
    case "select_option":
      return `Browser: chose an option${element ? ` in ${element}` : ""}`;
    case "snapshot":
    case "take_screenshot":
    case "wait_for":
    case "find":
    case "hover":
    case "resize":
      return;
    default:
      return `Browser: ${tool.replace(/_/g, " ")}`;
  }
}
