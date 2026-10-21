import type {
  Account,
  ActionCategory,
  ActionQuery,
  ActionRecord,
  ActionRequest,
  AgentRun,
  CalendarEvent,
  DomainEvent,
  Email,
  EmailQuery,
  GlobalPolicyConfig,
  LlmConfig,
  Matter,
  Page,
  Person,
  PromotionOffer,
  ProviderSetupDescriptor,
  Thread,
  TrustLevel,
  TrustState,
} from "@passport/types";
import { authHeaders, handleUnauthorized } from "./auth";
export interface TrustData {
  config: GlobalPolicyConfig;
  categories: TrustState[];
  promotionOffers: PromotionOffer[];
}
export interface MatterDetail {
  matter: Matter;
  emails: Page<Email>;
  events: CalendarEvent[];
  actions: Page<ActionRecord>;
  people: Person[];
}
export interface PersonDetail {
  person: Person;
  emails: Page<Email>;
  matters: Matter[];
}
export interface AccountData {
  accounts: Account[];
  llm: Omit<LlmConfig, "apiKey" | "provider"> & {
    provider: ModelProvider;
    apiKeyConfigured: boolean;
    configured?: boolean;
  };
  mode: "demo" | "real";
}
/** A coding agent installed on this machine that Passport can drive (`GET /api/host-agents`). */
export interface HostAgent {
  kind: "claude-code" | "codex";
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  account?: string;
  path?: string;
}
export type ModelProvider = LlmConfig["provider"] | HostAgent["kind"];
export interface AgentInstruction {
  instruction?: string;
  emailIds?: string[];
  matterId?: string;
}
export type ProviderDescriptor = Omit<ProviderSetupDescriptor, "oauth"> & {
  oauth?: { scopes: string[] };
};
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...authHeaders,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  handleUnauthorized(response);
  // A proxy may answer an error with HTML; keep its status meaningful. Successful
  // responses (and aborted reads) must still fail loudly.
  const body = await response.json().catch((error: unknown) => {
    if (response.ok) throw error;
    return {};
  });
  if (!response.ok)
    throw new ApiError(
      body.error?.message ?? "Something went wrong. Please try again.",
      body.error?.code ?? "REQUEST_FAILED",
      response.status,
    );
  return body as T;
}
const write = <T>(path: string, method: string, body?: unknown) =>
  request<T>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export function queryString(query: object = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined && value !== "")
      params.set(key, Array.isArray(value) ? value.join(",") : String(value));
  return params.size ? `?${params}` : "";
}
export const api = {
  decisions: () => request<Page<ActionRecord>>("/decisions"),
  approve: (id: string, edited?: ActionRequest) =>
    write<ActionRecord>(
      `/actions/${encodeURIComponent(id)}/approve`,
      "POST",
      edited ? { request: edited } : undefined,
    ),
  reject: (id: string) =>
    write<ActionRecord>(`/actions/${encodeURIComponent(id)}/reject`, "POST"),
  cancel: (id: string) =>
    write<ActionRecord>(
      `/actions/${encodeURIComponent(id)}/cancel-hold`,
      "POST",
    ),
  undo: (id: string) =>
    write<ActionRecord>(`/actions/${encodeURIComponent(id)}/undo`, "POST"),
  actions: (query?: ActionQuery) =>
    request<Page<ActionRecord>>(`/actions${queryString(query)}`),
  emails: (query?: EmailQuery) =>
    request<Page<Email>>(
      `/emails${queryString(query ? { ...query, keywords: undefined, has: query.keywords?.has, not: query.keywords?.not } : {})}`,
    ),
  email: (id: string) => request<Email>(`/emails/${encodeURIComponent(id)}`),
  thread: (id: string) =>
    request<{ thread: Thread; emails: Page<Email> }>(
      `/threads/${encodeURIComponent(id)}`,
    ),
  updateMatter: (id: string, patch: Partial<Matter>) =>
    write<ActionRecord>(`/matters/${encodeURIComponent(id)}`, "PATCH", patch),
  trust: () => request<TrustData>("/trust"),
  setTrust: (patch: Partial<GlobalPolicyConfig>) =>
    write<GlobalPolicyConfig>("/trust/config", "PUT", patch),
  pin: (category: ActionCategory, level: TrustLevel | null) =>
    write<TrustState>(`/trust/${category}/pin`, "PUT", { level }),
  addAccount: (body: {
    kind: string;
    emailAddress: string;
    displayName: string;
    fields: Record<string, string>;
  }) => write<Account>("/accounts", "POST", body),
  sync: (id: string) =>
    write<{ ok: boolean }>(`/accounts/${encodeURIComponent(id)}/sync`, "POST"),
  saveLlm: (
    config: Omit<LlmConfig, "apiKey" | "provider"> & {
      provider: ModelProvider;
    },
  ) => write<AccountData["llm"]>("/settings/llm", "PUT", config),
  hostAgents: () => request<HostAgent[]>("/host-agents"),
  saveProfile: (markdown: string) =>
    write<{ markdown: string }>("/user-profile", "PUT", { markdown }),
  runAgent: (body: AgentInstruction = {}) =>
    write<AgentRun>("/agent/run", "POST", body),
};
export type { DomainEvent };
