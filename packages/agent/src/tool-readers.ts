import type { MailReader, MailReaderResolver, MailReadOptions, QuotaLane } from "@passport/types";

/** Pin native tool reads to the run's quota lane and cancellation, including nested reads. */
export function runToolReaders(
  resolve: MailReaderResolver | undefined,
  lane: QuotaLane,
  signal?: AbortSignal,
): MailReaderResolver | undefined {
  if (!resolve) return undefined;
  const cached = new Map<string, Promise<MailReader | null>>();
  const options = <T extends MailReadOptions>(value?: T) => ({
    ...value,
    lane,
    ...(signal ? { signal } : {}),
  });
  const bind = async (id: string): Promise<MailReader | null> => {
    const reader = await resolve(id);
    if (!reader) return null;
    return {
      search: (input, opts) => reader.search(input, options(opts)),
      list: (container, filter, limit, page, opts) =>
        reader.list(container, filter, limit, page, options(opts)),
      labels: (counts, opts) => reader.labels(counts, options(opts)),
      envelopes: (ids, opts) => reader.envelopes(ids, options(opts)),
      thread: (id, opts) => reader.thread(id, { ...opts, ...options(opts) }),
      body: (id, opts) => reader.body(id, options(opts)),
      countIds: (query, cap, opts) => reader.countIds(query, cap, options(opts)),
      changes: (cursor, limit, opts) => reader.changes(cursor, limit, options(opts)),
      findByRfc822: (id, opts) => reader.findByRfc822(id, options(opts)),
      ...(reader.rawGet
        ? ({
            rawGet: (path, query, opts) => reader.rawGet!(path, query, options(opts)),
          } satisfies Pick<MailReader, "rawGet">)
        : {}),
      ...(reader.attachment
        ? ({
            attachment: (id, ref, opts) => reader.attachment!(id, ref, options(opts)),
          } satisfies Pick<MailReader, "attachment">)
        : {}),
    };
  };
  return (id) => {
    let reader = cached.get(id);
    if (!reader) {
      reader = bind(id);
      cached.set(id, reader);
    }
    return reader;
  };
}
