import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { PolicyError } from "./errors.js";

export type ResolveDns = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;
const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blockedV6.addSubnet(address, prefix, "ipv6");
const isPublicAddress = (address: string): boolean =>
  isIP(address) === 4
    ? !blockedV4.check(address, "ipv4")
    : isIP(address) === 6 && globalV6.check(address, "ipv6") && !blockedV6.check(address, "ipv6");

async function validateTarget(url: URL, resolveDns: ResolveDns, signal: AbortSignal) {
  if (url.protocol !== "https:" || url.username || url.password)
    throw new PolicyError(
      "UNSUBSCRIBE_UNSUPPORTED",
      "Unsubscribe requires an HTTPS URL without credentials",
    );
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const blocked = () =>
    new PolicyError("UNSUBSCRIBE_TARGET_BLOCKED", `Unsubscribe target blocked for ${url.host}`);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "local" ||
    hostname.endsWith(".local") ||
    hostname === "internal" ||
    hostname.endsWith(".internal")
  )
    throw blocked();
  // Reject literal IPs even if an injected resolver would return a different address.
  if (isIP(hostname) && !isPublicAddress(hostname)) throw blocked();
  let addresses: LookupAddress[];
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    addresses = await Promise.race([
      resolveDns(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    signal.throwIfAborted();
  } catch {
    throw new PolicyError(
      signal.aborted ? "UNSUBSCRIBE_TIMEOUT" : "UNSUBSCRIBE_TARGET_BLOCKED",
      `Unsubscribe ${signal.aborted ? "request timed out" : "target could not be resolved"} for ${url.host}`,
    );
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  if (
    !addresses.length ||
    addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)
  )
    throw blocked();
  return addresses;
}

/** Header targets only; never infer unsubscribe links from untrusted message bodies. */
export function parseListUnsubscribe(value?: string | null, post?: string | null) {
  let https: URL | undefined;
  let mailto: { address: string; subject: string; textBody: string } | undefined;
  for (const match of (value ?? "").matchAll(/<([^>]+)>/g)) {
    try {
      const url = new URL(match[1]!.trim());
      if (url.protocol === "https:" && !url.username && !url.password) https ??= url;
      if (url.protocol === "mailto:" && !mailto) {
        const address = decodeURIComponent(url.pathname);
        if (/^[^\s<>@,;?]+@[^\s<>@,;?]+$/.test(address))
          mailto = {
            address,
            subject: url.searchParams.get("subject") ?? "unsubscribe",
            textBody: url.searchParams.get("body") ?? "unsubscribe",
          };
      }
    } catch {
      // Ignore malformed targets so another valid header target can still be used.
    }
  }
  return {
    https,
    mailto,
    oneClick: /(?:^|[;\s])List-Unsubscribe\s*=\s*One-Click(?:$|[;\s])/i.test(post ?? ""),
  };
}

/** Use a fresh connection whose resolver can return only this hop's validated addresses. */
async function pinnedRequest(
  url: URL,
  init: RequestInit,
  addresses: LookupAddress[],
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const lookup: RequestOptions["lookup"] = (_hostname, options, callback) => {
      const allowed = options.family
        ? addresses.filter((address) => address.family === options.family)
        : addresses;
      if (!allowed.length) {
        callback(
          Object.assign(new Error("No validated address for family"), { code: "ENOTFOUND" }),
          "",
          4,
        );
        return;
      }
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0]!.address, allowed[0]!.family);
    };
    const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
    const req = httpsRequest(
      url,
      {
        method: init.method,
        headers: init.headers as Record<string, string>,
        signal: init.signal ?? undefined,
        agent: false,
        lookup,
        servername: isIP(hostname) ? undefined : hostname,
        rejectUnauthorized: true,
      },
      (response) => {
        // Unsubscribe needs status/Location only; never buffer an untrusted response body.
        const headers = new Headers();
        if (response.headers.location) headers.set("location", response.headers.location);
        const status = response.statusCode ?? 502;
        response.destroy();
        resolve(new Response(null, { status, headers }));
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

/** A single deadline covers the initial request and at most three HTTPS redirects. */
export async function requestUnsubscribe(
  fetcher: typeof globalThis.fetch | undefined,
  target: URL,
  method: "GET" | "POST",
  resolveDns: ResolveDns = lookup,
) {
  const signal = AbortSignal.timeout(10_000);
  let url = target;
  for (let redirects = 0; ; redirects++) {
    const addresses = await validateTarget(url, resolveDns, signal);
    let response: Response;
    try {
      const init: RequestInit = {
        method,
        redirect: "manual",
        signal,
        ...(method === "POST"
          ? {
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: "List-Unsubscribe=One-Click",
            }
          : {}),
      };
      response = fetcher
        ? await fetcher(url.href, init)
        : await pinnedRequest(url, init, addresses);
      await response.body?.cancel();
    } catch {
      // Fetch errors can include token-bearing URLs; expose only the destination host.
      throw new PolicyError(
        signal.aborted ? "UNSUBSCRIBE_TIMEOUT" : "UNSUBSCRIBE_FAILED",
        `Unsubscribe request ${signal.aborted ? "timed out" : "failed"} for ${url.host}`,
      );
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3)
        throw new PolicyError(
          "UNSUBSCRIBE_REDIRECT_LIMIT",
          `Unsubscribe exceeded three redirects for ${url.host}`,
        );
      const location = response.headers.get("location");
      let next: URL;
      try {
        if (!location) throw new Error("Missing redirect location");
        next = new URL(location, url);
      } catch {
        throw new PolicyError(
          "UNSUBSCRIBE_FAILED",
          `Invalid unsubscribe redirect from ${url.host}`,
        );
      }
      if (next.protocol !== "https:" || next.username || next.password)
        throw new PolicyError(
          "UNSUBSCRIBE_UNSUPPORTED",
          `Unsubscribe redirect from ${url.host} requires an HTTPS URL without credentials`,
        );
      url = next;
      continue;
    }
    if (!response.ok)
      throw new PolicyError(
        "UNSUBSCRIBE_HTTP_ERROR",
        `Unsubscribe returned HTTP ${response.status} for ${url.host}`,
      );
    return { target: url.host, status: response.status };
  }
}
