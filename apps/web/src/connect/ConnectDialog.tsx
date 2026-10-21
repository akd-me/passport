import { Dialog } from "../components/Dialog";
import { isFinished } from "../setup-api";
import { useUi } from "../ui-state";
import { SetupFlow } from "./SetupFlow";
import { useSetupSessionSync } from "./setup-session";

/** Always mounted in the shell, so a setup keeps syncing while the dialog is closed. */
export function ConnectDialog() {
  const { connecting, setConnecting, setup } = useUi();
  useSetupSessionSync(setup);
  if (!connecting) {
    return null;
  }
  return (
    <Dialog
      title="Connect an account"
      description="Mail, and optionally calendar, from Google or Microsoft."
      onClose={() => {
        // An unfinished task stays so reopening returns to it; a finished one starts over.
        if (setup.task && isFinished(setup.task)) {
          setup.update(undefined);
        }
        setConnecting(false);
      }}
      size="md"
      className="connect-dialog"
    >
      <div className="dialog-body">
        <SetupFlow onDone={() => setConnecting(false)} />
      </div>
    </Dialog>
  );
}
