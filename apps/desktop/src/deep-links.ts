// passport:// links are for in-app navigation only (notifications, "Open in Passport").
// OAuth never uses them: Google and Microsoft require loopback redirects for desktop apps.

export const SCHEME = "passport";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SETTINGS: Record<string, string> = {
  "": "/accounts",
  accounts: "/accounts",
  trust: "/trust",
  routines: "/scheduler",
};

/**
 * Maps a deep link to a web UI route, or null when it is not one of ours.
 *   passport://decision/<id>  → the queue, selecting that decision
 *   passport://matter/<id>    → /matters/<id>
 *   passport://settings[/<section>]
 *   passport://open           → the queue
 */
export function routeFor(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    // Not a URL at all.
    return null;
  }
  if (url.protocol !== `${SCHEME}:`) {
    return null;
  }
  const [kind = "", id = "", ...rest] = [url.hostname, ...url.pathname.split("/").filter(Boolean)];
  if (rest.length) {
    return null;
  }
  if (kind === "decision" && ID.test(id)) {
    return `/?decision=${encodeURIComponent(id)}`;
  }
  if (kind === "matter" && ID.test(id)) {
    return `/matters/${encodeURIComponent(id)}`;
  }
  const section = Object.hasOwn(SETTINGS, id) ? SETTINGS[id] : undefined;
  if (kind === "settings" && section) {
    return section;
  }
  if ((kind === "open" || kind === "") && !id) {
    return "/";
  }
  return null;
}

export const decisionLink = (id: string) => `${SCHEME}://decision/${id}`;

/** Deep links arrive in argv on second-instance launches (and on non-macOS platforms). */
export function linkFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${SCHEME}://`));
}
