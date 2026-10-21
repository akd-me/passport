import { Dialog } from "../components/Dialog";
import { useUi } from "../ui-state";
import { SetupFlow } from "./SetupFlow";

export function ConnectDialog() {
  const { connecting, setConnecting } = useUi();
  if (!connecting) return null;
  return (
    <Dialog
      title="Connect an account"
      description="Mail, and optionally calendar, from Google or Microsoft."
      onClose={() => setConnecting(false)}
      size="md"
      className="connect-dialog"
    >
      <div className="dialog-body">
        <SetupFlow onDone={() => setConnecting(false)} />
      </div>
    </Dialog>
  );
}
