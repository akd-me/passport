import { createContext, type ReactNode, useContext } from "react";
import { useSearchParams } from "react-router";
import type { AccountData } from "../api";
import { useResource } from "../state";
import type { ConnectedAccount } from "./api";

interface AccountScopeState {
  accounts: ConnectedAccount[];
  loaded: boolean;
  mode?: AccountData["mode"];
  llm?: AccountData["llm"];
}
const Accounts = createContext<AccountScopeState>({
  accounts: [],
  loaded: false,
});
/** Loads `/accounts` once for the shell: sidebar, colour dots, model chip and empty state. */
export function AccountScope({ children }: { children: ReactNode }) {
  const resource = useResource<Omit<AccountData, "accounts"> & { accounts: ConnectedAccount[] }>(
    "/accounts",
  );
  return (
    <Accounts.Provider
      value={{
        accounts: resource.data?.accounts ?? [],
        loaded: !!resource.data || !!resource.error,
        mode: resource.data?.mode,
        llm: resource.data?.llm,
      }}
    >
      {children}
    </Accounts.Provider>
  );
}
export const useAccounts = () => useContext(Accounts);
export function accountColour(id: string): string {
  let hash = 0;
  for (const c of id) {
    hash = (Math.imul(hash, 31) + c.charCodeAt(0)) | 0;
  }
  return ["#3b8a64", "#4a6fd4", "#c07a2c", "#2a8f99", "#c2507c", "#7d8a2e"][Math.abs(hash) % 6]!;
}
export function AccountDot({ id }: { id: string }) {
  const { accounts } = useContext(Accounts),
    account = accounts.find((a) => a.id === id);
  return (
    <span
      className="account-dot"
      style={{ backgroundColor: accountColour(id) }}
      title={account?.emailAddress ?? "Account"}
      role="img"
      aria-label={account?.emailAddress ?? "Account"}
    />
  );
}
/** The sidebar scopes the queue, matters and activity to one account via `?accountId=`. */
export function useAccountId(): string {
  return useSearchParams()[0].get("accountId") ?? "";
}
export function useAccountScopeLink() {
  const [params] = useSearchParams(),
    id = params.get("accountId");
  return (path: string) =>
    id ? `${path}${path.includes("?") ? "&" : "?"}accountId=${encodeURIComponent(id)}` : path;
}
