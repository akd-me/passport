import { useEffect, useState } from "react";
import { Badge, Empty, Feedback, Loading, relativeTime } from "../components/ui";
import { type Job, type JobRun, type JobSchedule, jobsApi } from "../scheduler-api";
import { useResource, useTask } from "../state";

export const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeSchedule(schedule: JobSchedule) {
  if (schedule.type === "manual") {
    return "On demand";
  }
  if (schedule.type === "interval") {
    const seconds = schedule.everyMs / 1000;
    const value =
      seconds >= 3600
        ? `${Math.round((seconds / 3600) * 10) / 10}h`
        : seconds >= 60
          ? `${Math.round((seconds / 60) * 10) / 10}m`
          : `${seconds}s`;
    return `Every ${value}`;
  }
  const days =
    schedule.type === "daily" ? "Daily" : schedule.days.map((d) => weekdays[d]).join(", ");
  return `${days} at ${schedule.at}${schedule.timeZone ? ` · ${schedule.timeZone}` : ""}`;
}

export const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export function countdown(at: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
  if (seconds === 0) {
    return "Due now";
  }
  if (seconds < 60) {
    return `in ${seconds}s`;
  }
  if (seconds < 3600) {
    return `in ${Math.ceil(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `in ${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`;
  }
  return `in ${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

export function JobRow({
  job,
  now,
  onHistory,
}: {
  job: Job;
  now: number;
  onHistory(job: Job): void;
}) {
  const task = useTask();
  return (
    <tr>
      <th scope="row">
        <span className="job-name">
          <strong>{job.name}</strong>
          <Badge tone={job.kind === "user" ? "ink" : ""}>
            {job.kind === "user" ? "Routine" : "System"}
          </Badge>
          {job.running && <Badge tone="ink">Running</Badge>}
        </span>
        <small className="muted">{describeSchedule(job.schedule)}</small>
      </th>
      <td>
        {job.lastRunAt ? (
          <span className="job-last">
            <span
              className={`status-dot ${job.lastStatus === "error" ? "bad" : job.lastStatus === "ok" ? "good" : ""}`}
              aria-hidden="true"
            />
            <time
              dateTime={job.lastRunAt}
              title={`${job.lastStatus ?? ""} ${new Date(job.lastRunAt).toLocaleString()}`}
            >
              {relativeTime(job.lastRunAt)}
            </time>
            {job.lastDurationMs !== null && (
              <small className="muted num">{duration(job.lastDurationMs)}</small>
            )}
          </span>
        ) : (
          <span className="muted">Never run</span>
        )}
        {!!job.consecutiveFailures && (
          <div className="job-failure">
            <Badge tone="danger">
              {job.consecutiveFailures} {job.consecutiveFailures === 1 ? "failure" : "failures"}
            </Badge>
            <small>{job.lastError}</small>
          </div>
        )}
      </td>
      <td className="num">
        {!job.enabled ? (
          <Badge>Paused</Badge>
        ) : job.nextRunAt ? (
          <time dateTime={job.nextRunAt} title={new Date(job.nextRunAt).toLocaleString()}>
            {countdown(job.nextRunAt, now)}
          </time>
        ) : (
          <span className="muted">On demand</span>
        )}
      </td>
      <td>
        <div className="row-actions">
          <button
            className="btn btn-sm"
            disabled={task.busy || job.running}
            aria-label={`Run ${job.name} now`}
            onClick={() =>
              task.run(async () => {
                const run = await jobsApi.run(job.id);
                if (run.status === "error") {
                  throw new Error(run.summary ?? "Job failed");
                }
              }, "Run complete.")
            }
          >
            Run now
          </button>
          <button
            className="btn btn-sm btn-ghost"
            disabled={task.busy}
            aria-label={`${job.enabled ? "Pause" : "Resume"} ${job.name}`}
            onClick={() =>
              task.run(
                () => (job.enabled ? jobsApi.pause(job.id) : jobsApi.resume(job.id)),
                job.enabled ? "Job paused." : "Job resumed.",
              )
            }
          >
            {job.enabled ? "Pause" : "Resume"}
          </button>
          <button
            className="btn btn-sm btn-ghost"
            aria-label={`History for ${job.name}`}
            onClick={() => onHistory(job)}
          >
            History
          </button>
        </div>
        <Feedback error={task.error} />
      </td>
    </tr>
  );
}

export function JobsTable({ jobs, onHistory }: { jobs: Job[]; onHistory(job: Job): void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(Date.now());
      timer = setTimeout(tick, 1000);
    };
    timer = setTimeout(tick, 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="table-scroll">
      <table className="data-table jobs-table">
        <caption className="sr-only">Scheduled jobs and agent routines</caption>
        <thead>
          <tr>
            {["Job", "Last run", "Next run", ""].map((h) => (
              <th scope="col" key={h || "actions"}>
                {h || <span className="sr-only">Actions</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} now={now} onHistory={onHistory} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function JobHistory({ job, onClose }: { job: Job; onClose(): void }) {
  const history = useResource<JobRun[]>(`/jobs/${encodeURIComponent(job.id)}/history`),
    task = useTask();
  return (
    <section className="settings-block inset" aria-label={`${job.name} history`}>
      <div className="block-heading">
        <h3>{job.name}: recent runs</h3>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">The most recent 20 runs. Overlapping ticks appear as skipped.</p>
      {job.routine && (
        <div className="routine-instruction">
          <strong>Instruction</strong>
          <p>{job.routine.instruction}</p>
        </div>
      )}
      <Feedback error={history.error ?? task.error} />
      {!history.data ? (
        !history.error && <Loading />
      ) : !history.data.length ? (
        <Empty title="No runs yet">Run this job whenever you’re ready.</Empty>
      ) : (
        <ol className="job-history">
          {[...history.data].reverse().map((run) => (
            <li key={run.runId}>
              <div>
                <Badge tone={run.status === "error" ? "danger" : run.status === "ok" ? "good" : ""}>
                  {run.status}
                </Badge>
                <time dateTime={run.startedAt}>{new Date(run.startedAt).toLocaleString()}</time>
                <span>{duration(run.durationMs)}</span>
              </div>
              {run.summary && <p>{run.summary}</p>}
            </li>
          ))}
        </ol>
      )}
      {job.kind === "user" && (
        <button
          className="btn btn-danger"
          disabled={task.busy}
          onClick={async () => {
            if (await task.run(() => jobsApi.remove(job.id), "Routine deleted.")) {
              onClose();
            }
          }}
        >
          Delete routine
        </button>
      )}
    </section>
  );
}
