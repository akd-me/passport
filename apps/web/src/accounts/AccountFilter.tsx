import { createContext, useContext, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { AccountData } from "../api";
import { useResource } from "../state";
import type { Account } from "@passport/types";

const Accounts = createContext<Account[]>([]);
export function AccountScope({ children }: { children: ReactNode }) {
  const resource = useResource<AccountData>("/accounts");
  return (
    <Accounts.Provider value={resource.data?.accounts ?? []}>
      {children}
    </Accounts.Provider>
  );
}
export function accountColour(id: string): string {
  let hash = 0;
  for (const c of id) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) | 0;
  return ["#386d58", "#405fb0", "#ad6030", "#83529c", "#a53f67", "#187b83"][
    Math.abs(hash) % 6
  ]!;
}
export function AccountDot({ id }: { id: string }) {
  const accounts = useContext(Accounts),
    account = accounts.find((a) => a.id === id);
  return (
    <span
      className="account-dot"
      style={{ backgroundColor: accountColour(id) }}
      title={account?.emailAddress ?? "Account"}
      aria-label={account?.emailAddress ?? "Account"}
    />
  );
}
export function useAccountId(): string {
  return useSearchParams()[0].get("accountId") ?? "";
}
export function AccountFilter() {
  const accounts = useContext(Accounts),
    [params, setParams] = useSearchParams();
  const id = params.get("accountId") ?? "";
  return (
    <label className="account-filter-chip">
      {id && <AccountDot id={id} />}
      <span className="sr-only">Filter by account</span>
      <select
        aria-label="Filter by account"
        value={id}
        onChange={(e) => {
          const next = new URLSearchParams(params);
          if (e.target.value) next.set("accountId", e.target.value);
          else next.delete("accountId");
          setParams(next);
        }}
      >
        <option value="">All accounts</option>
        {accounts
          .filter((a) => a.capabilities.mail)
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.emailAddress} · {a.kind}
            </option>
          ))}
      </select>
    </label>
  );
}
