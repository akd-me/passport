import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { PolicyError } from './errors.js';

export type ResolveDns = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>;
const blockedV4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blockedV6.addSubnet(address, prefix, 'ipv6');
const isPublicAddress = (address: string): boolean => isIP(address) === 4
  ? !blockedV4.check(address, 'ipv4')
  : isIP(address) === 6 && globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6');

async function validateTarget(url: URL, resolveDns: ResolveDns, signal: AbortSignal) {
  if (url.protocol !== 'https:' || url.username || url.password) throw new PolicyError('UNSUBSCRIBE_UNSUPPORTED', 'Unsubscribe requires an HTTPS URL without credentials');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const blocked = () => new PolicyError('UNSUBSCRIBE_TARGET_BLOCKED', `Unsubscribe target blocked for ${url.host}`);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'local' || hostname.endsWith('.local') || hostname === 'internal' || hostname.endsWith('.internal')) throw blocked();
  // Reject literal IPs even if an injected resolver would return a different address.
  if (isIP(hostname) && !isPublicAddress(hostname)) throw blocked();
  let addresses: LookupAddress[];
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    addresses = await Promise.race([
      resolveDns(hostname, { all: true }),
      new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); }),
    ]);
    signal.throwIfAborted();
  } catch {
    throw new PolicyError(signal.aborted ? 'UNSUBSCRIBE_TIMEOUT' : 'UNSUBSCRIBE_TARGET_BLOCKED', `Unsubscribe ${signal.aborted ? 'request timed out' : 'target could not be resolved'} for ${url.host}`);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  // Fetch cannot pin the validated address: mixed public/private answers must fail closed.
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw blocked();
}

/** Header targets only; never infer unsubscribe links from untrusted message bodies. */
export function parseListUnsubscribe(value?: string | null, post?: string | null) {
  let https: URL | undefined;
  let mailto: { address: string; subject: string; textBody: string } | undefined;
  for (const match of (value ?? '').matchAll(/<([^>]+)>/g)) {
    try {
      const url = new URL(match[1]!.trim());
      if (url.protocol === 'https:' && !url.username && !url.password) https ??= url;
      if (url.protocol === 'mailto:' && !mailto) {
        const address = decodeURIComponent(url.pathname);
        if (/^[^\s<>@,;?]+@[^\s<>@,;?]+$/.test(address)) mailto = {
          address,
          subject: url.searchParams.get('subject') ?? 'unsubscribe',
          textBody: url.searchParams.get('body') ?? 'unsubscribe',
        };
      }
    } catch {
      // Ignore malformed targets so another valid header target can still be used.
    }
  }
  return { https, mailto, oneClick: /(?:^|[;\s])List-Unsubscribe\s*=\s*One-Click(?:$|[;\s])/i.test(post ?? '') };
}

/** A single deadline covers the initial request and at most three HTTPS redirects. */
export async function requestUnsubscribe(fetcher: typeof globalThis.fetch, target: URL, method: 'GET' | 'POST', resolveDns: ResolveDns = lookup) {
  const signal = AbortSignal.timeout(10_000);
  let url = target;
  for (let redirects = 0; ; redirects++) {
    await validateTarget(url, resolveDns, signal);
    let response: Response;
    try {
      response = await fetcher(url.href, {
        method, redirect: 'manual', signal,
        ...(method === 'POST' ? {
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'List-Unsubscribe=One-Click',
        } : {}),
      });
      await response.body?.cancel();
    } catch {
      // Fetch errors can include token-bearing URLs; expose only the destination host.
      throw new PolicyError(signal.aborted ? 'UNSUBSCRIBE_TIMEOUT' : 'UNSUBSCRIBE_FAILED', `Unsubscribe request ${signal.aborted ? 'timed out' : 'failed'} for ${url.host}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) throw new PolicyError('UNSUBSCRIBE_REDIRECT_LIMIT', `Unsubscribe exceeded three redirects for ${url.host}`);
      const location = response.headers.get('location');
      let next: URL;
      try {
        if (!location) throw new Error('Missing redirect location');
        next = new URL(location, url);
      } catch {
        throw new PolicyError('UNSUBSCRIBE_FAILED', `Invalid unsubscribe redirect from ${url.host}`);
      }
      if (next.protocol !== 'https:' || next.username || next.password) throw new PolicyError('UNSUBSCRIBE_UNSUPPORTED', `Unsubscribe redirect from ${url.host} requires an HTTPS URL without credentials`);
      url = next;
      continue;
    }
    if (!response.ok) throw new PolicyError('UNSUBSCRIBE_HTTP_ERROR', `Unsubscribe returned HTTP ${response.status} for ${url.host}`);
    return { target: url.host, status: response.status };
  }
}
