import { MockMailProvider, type QuotaGovernor } from "@passport/providers";
import type { Email, MailReader } from "@passport/types";
import { parseMailHandle } from "@passport/types";
import { createToolRegistry } from "../index.js";
import type { Tool, ToolRegistryOptions, ToolResult } from "../types.js";
import { MemoryBus, MemoryExecutor, MemoryPolicy, MemoryStore } from "./fakes.js";
import * as f from "./fixtures.js";

export interface HarnessOptions extends Partial<ToolRegistryOptions> {
  /** Connected mock accounts (`account-1` …). */
  accounts?: number;
  /** Accounts that exist but have no reader. */
  withoutReader?: string[];
  /** Governors per account id. */
  governors?: Record<string, QuotaGovernor>;
  /** Replaces a reader (e.g. to add `rawGet`). */
  wrapReader?: (accountId: string, reader: MailReader) => MailReader;
  /** Omit the `readers` resolver entirely (legacy store mode). */
  noReaders?: boolean;
}

/** Registry over mock providers whose `reader()` backs the on-demand tools. */
export async function onDemandHarness(options: HarnessOptions = {}) {
  const {
    accounts = 1,
    withoutReader = [],
    governors = {},
    wrapReader,
    noReaders,
    ...rest
  } = options;
  const store = new MemoryStore();
  const policy = new MemoryPolicy();
  const executor = new MemoryExecutor(store, policy);
  const providers = new Map<string, MockMailProvider>();
  for (let index = 1; index <= accounts; index++) {
    const account = f.account({
      id: `account-${index}`,
      emailAddress: index === 1 ? "alex@example.com" : `alex${index}@example.com`,
    });
    await store.accounts.upsert(account);
    const governor = governors[account.id];
    const provider = new MockMailProvider(governor ? { governor } : {});
    await provider.connect(account, {});
    providers.set(account.id, provider);
  }
  const readerOf = (accountId: string): MailReader | null => {
    const provider = providers.get(accountId);
    if (!provider || withoutReader.includes(accountId)) {
      return null;
    }
    return wrapReader ? wrapReader(accountId, provider.reader()) : provider.reader();
  };
  // Mirrors the store's v0.3 read-through `emails.get` for handles.
  store.readThrough = async (id) => {
    const handle = parseMailHandle(id);
    const reader = handle?.type === "email" ? readerOf(handle.accountId) : null;
    if (!handle || !reader) {
      return null;
    }
    const envelope = (await reader.envelopes([handle.providerId])).value.get(handle.providerId);
    return envelope ? ({ ...envelope, textBody: null, htmlBody: null } as Email) : null;
  };
  const tools = createToolRegistry({
    store,
    executor,
    policy,
    bus: new MemoryBus(),
    actor: { kind: "external-agent", id: "test-client" },
    selfAddresses: ["alex@example.com"],
    now: () => f.at,
    ...(noReaders ? {} : { readers: async (accountId: string) => readerOf(accountId) }),
    ...rest,
  });
  const call = (name: string, input: unknown = {}): Promise<ToolResult> => {
    const tool = tools.find((item) => item.name === name);
    if (!tool) {
      throw new Error(`No tool ${name}`);
    }
    return tool.handler(input);
  };
  return {
    store,
    policy,
    executor,
    providers,
    tools: tools as Tool[],
    call,
    provider: (id = "account-1") => providers.get(id) as MockMailProvider,
  };
}

/** Rows of a successful list/search result. */
export const rows = (result: ToolResult) =>
  result.items as Array<{
    id: string;
    threadId: string;
    date: string;
    subject: string;
    from: string;
    labels: string[];
    unread: boolean;
  }>;
