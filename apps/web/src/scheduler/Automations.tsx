import { Feedback, relativeTime } from "../components/ui";
import { type Job, jobsApi } from "../scheduler-api";
import { useResource, useTask } from "../state";

/** Quiet task-details rows; the routine's existing task is its binding. */
export function Automations({ taskId }: { taskId: string }) {
  const jobs = useResource<Job[]>("/jobs");
  const action = useTask();
  const bound = jobs.data?.filter((job) => job.taskId === taskId) ?? [];
  if (!bound.length && !jobs.error) {
    return null;
  }
  return (
    <section className="scheduler-automations" aria-label="Automations">
      <h3>Automations</h3>
      <Feedback error={jobs.error ?? action.error} />
      <ul className="link-list">
        {bound.map((job) => (
          <li key={job.id}>
            <div>
              <strong>{job.name}</strong>
              <p className="muted">
                {job.running
                  ? "Running"
                  : !job.enabled
                    ? "Paused"
                    : job.lastStatus === "error"
                      ? "Failed"
                      : "Ready"}
                {" · "}
                {job.lastRunAt ? "Last run " + relativeTime(job.lastRunAt) : "Never run"}
              </p>
              <p className="muted">
                {job.nextRunAt
                  ? "Next run " + relativeTime(job.nextRunAt)
                  : job.schedule.type === "webhook"
                    ? "On webhook delivery"
                    : "On demand"}
              </p>
              <p className="muted">
                {job.runOn === "fresh" ? "A new task for each run" : "Runs on this task"}
              </p>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={action.busy || job.running}
                onClick={() =>
                  action.run(async () => {
                    const run = await jobsApi.run(job.id);
                    if (run.status === "error") {
                      throw new Error(run.summary ?? "Run failed");
                    }
                  }, "Run complete.")
                }
              >
                Run now
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={action.busy}
                onClick={() =>
                  action.run(
                    () => (job.enabled ? jobsApi.pause(job.id) : jobsApi.resume(job.id)),
                    job.enabled ? "Routine paused." : "Routine resumed.",
                  )
                }
              >
                {job.enabled ? "Pause" : "Resume"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
