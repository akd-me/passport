import { PolicyError } from './errors.js';

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
export async function requestUnsubscribe(fetcher: typeof globalThis.fetch, target: URL, method: 'GET' | 'POST') {
  const signal = AbortSignal.timeout(10_000);
  let url = target;
  for (let redirects = 0; ; redirects++) {
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
