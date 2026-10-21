import { useState } from "react";
import { Feedback, Icon } from "../components/ui";
import { useTask } from "../state";
import { accountApi, type DoctorReport } from "./api";

/** `passport doctor` in the browser: storage, token refresh, providers, model, outbox. */
export function DoctorCard() {
  const [report, setReport] = useState<DoctorReport>(),
    task = useTask();
  return (
    <section className="settings-block">
      <div className="block-heading">
        <h3>Connection health</h3>
        <button
          className="btn btn-sm"
          disabled={task.busy}
          onClick={() =>
            task.run(async () => setReport(await accountApi.doctor()), "Checks complete.")
          }
        >
          {task.busy ? "Checking…" : "Run checks"}
        </button>
      </div>
      <p className="hint">
        Checks storage, token refresh, provider reachability, your model and the outbox hold.
      </p>
      <Feedback error={task.error} />
      {report && (
        <ul className="checks" aria-label={`Checked ${new Date(report.at).toLocaleTimeString()}`}>
          {report.checks.map((check, i) => (
            <li key={i} className={check.status}>
              <Icon name={check.status === "ok" ? "check" : "alert"} size={15} />
              <div>
                <strong>{check.name}</strong>
                <p>{check.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
