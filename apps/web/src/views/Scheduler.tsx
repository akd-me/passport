import { useState } from "react";
import { Empty, Feedback, Icon, Loading } from "../components/ui";
import type { Job } from "../scheduler-api";
import { useResource } from "../state";
import { JobHistory, JobsTable } from "./JobTable";
import { NewRoutineForm } from "./NewRoutineForm";

export { describeSchedule, JobsTable } from "./JobTable";
export { NewRoutineForm } from "./NewRoutineForm";

/** Settings → Routines: background jobs and the routines you give Passport. */
export function RoutinesSettings() {
  const jobs = useResource<Job[]>("/jobs"),
    [historyId, setHistoryId] = useState<string | null>(null),
    [creating, setCreating] = useState(false);
  const selected = jobs.data?.find((j) => j.id === historyId),
    routines = jobs.data?.filter((j) => j.kind === "user") ?? [],
    system = jobs.data?.filter((j) => j.kind !== "user") ?? [];
  return (
    <>
      <section className="settings-block">
        <div className="block-heading">
          <h3>Routines</h3>
          {!creating && (
            <button className="btn btn-sm" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              New routine
            </button>
          )}
        </div>
        <p className="hint">Instructions Passport runs on a schedule, like a morning triage.</p>
        {creating && <NewRoutineForm onCreated={() => setCreating(false)} />}
        {creating && (
          <button className="btn btn-sm btn-ghost" onClick={() => setCreating(false)}>
            Cancel
          </button>
        )}
        <Feedback error={jobs.error} />
        {!jobs.data ? (
          !jobs.error && <Loading />
        ) : routines.length ? (
          <JobsTable jobs={routines} onHistory={(job) => setHistoryId(job.id)} />
        ) : (
          !creating && (
            <Empty title="No routines yet" icon="routine">
              Create one to give Passport a recurring task.
            </Empty>
          )
        )}
      </section>
      {selected && <JobHistory job={selected} onClose={() => setHistoryId(null)} />}
      {!!system.length && (
        <section className="settings-block">
          <h3>Background jobs</h3>
          <p className="hint">
            Sync, the outbox, digests and upkeep. They run while <code>passport serve</code> is
            open.
          </p>
          <JobsTable jobs={system} onHistory={(job) => setHistoryId(job.id)} />
        </section>
      )}
    </>
  );
}
