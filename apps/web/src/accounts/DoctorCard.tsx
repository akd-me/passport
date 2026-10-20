import { useState } from "react";
import { useTask } from "../state";
import { Badge, Feedback } from "../components/ui";
import { accountApi, type DoctorReport } from "./api";

export function DoctorCard() {
  const [report, setReport] = useState<DoctorReport>(),
    task = useTask();
  return (
    <section className="panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>Connection health</h2>
          <p className="subtle">
            Check storage, token refresh, provider reachability, your model, and
            the outbox hold.
          </p>
        </div>
        <button
          className="button secondary"
          disabled={task.busy}
          onClick={() =>
            task.run(
              async () => setReport(await accountApi.doctor()),
              "Connection checks complete.",
            )
          }
        >
          {task.busy ? "Checking…" : "Run checks"}
        </button>
      </div>
      <Feedback error={task.error} />
      {report && (
        <>
          <small>Checked {new Date(report.at).toLocaleTimeString()}</small>
          <ul className="doctor-checks">
            {report.checks.map((check, i) => (
              <li key={i}>
                <Badge tone={check.status === "ok" ? "green" : "amber"}>
                  {check.status}
                </Badge>
                <div>
                  <strong>{check.name}</strong>
                  <p>{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
