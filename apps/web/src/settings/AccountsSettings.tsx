import type { Account } from "@passport/types";
import { useState } from "react";
import { useAccounts } from "../accounts/AccountFilter";
import { AccountRow } from "../accounts/AccountRow";
import { AccountWizard } from "../accounts/AccountWizard";
import { DoctorCard } from "../accounts/DoctorCard";
import type { ProviderDescriptor } from "../api";
import { Empty, Icon } from "../components/ui";
import { useResource } from "../state";
import { useUi } from "../ui-state";

/** Settings → Accounts: sync, history, re-authorization, removal and health. */
export function AccountsSettings() {
  const { accounts, mode } = useAccounts(),
    { closeSettings, setConnecting } = useUi(),
    providers = useResource<ProviderDescriptor[]>("/providers"),
    [reauthorizing, setReauthorizing] = useState<Account>();
  return (
    <>
      <section className="settings-block">
        <div className="block-heading">
          <h3>Connected accounts</h3>
          <button
            className="btn btn-sm"
            onClick={() => {
              closeSettings();
              setConnecting(true);
            }}
          >
            <Icon name="plus" size={14} />
            Connect an account
          </button>
        </div>
        {mode === "demo" && (
          <p className="hint">
            Demo workspace: everything stays in memory and resets when the server stops.
          </p>
        )}
        {accounts.length ? (
          <div className="account-list">
            {accounts.map((a) => (
              <AccountRow
                key={a.id}
                account={a}
                reauthorize={() =>
                  setReauthorizing(
                    accounts.find((item) => item.id === a.settings.mailAccountId) ?? a,
                  )
                }
              />
            ))}
          </div>
        ) : (
          <Empty title="No accounts yet" icon="mail">
            Connect Gmail or Outlook to start.
          </Empty>
        )}
      </section>
      {reauthorizing && providers.data && (
        <section className="settings-block inset">
          <AccountWizard
            key={reauthorizing.id}
            account={reauthorizing}
            accounts={accounts}
            providers={providers.data}
            onClose={() => setReauthorizing(undefined)}
          />
        </section>
      )}
      <DoctorCard />
    </>
  );
}
