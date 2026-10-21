import { useEffect, useState } from "react";
import {
  jobsApi,
  type Job,
  type JobRun,
  type JobSchedule,
} from "../scheduler-api";
import { useResource, useTask } from "../state";
import {
  Badge,
  Empty,
  Feedback,
  Icon,
  Loading,
  relativeTime,
} from "../components/ui";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function describeSchedule(schedule: JobSchedule) {
  if (schedule.type === "manual") return "On demand";
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
    schedule.type === "daily"
      ? "Daily"
      : schedule.days.map((d) => weekdays[d]).join(", ");
  return `${days} at ${schedule.at}${schedule.timeZone ? ` · ${schedule.timeZone}` : ""}`;
}
const duration = (ms: number) =>
  ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
function countdown(at: string, now: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
  return seconds === 0
    ? "Due now"
    : seconds < 60
      ? `in ${seconds}s`
      : seconds < 3600
        ? `in ${Math.ceil(seconds / 60)}m`
        : seconds < 86400
          ? `in ${Math.floor(seconds / 3600)}h ${Math.ceil((seconds % 3600) / 60)}m`
          : `in ${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}
function JobRow({
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
              <small className="muted num">
                {duration(job.lastDurationMs)}
              </small>
            )}
          </span>
        ) : (
          <span className="muted">Never run</span>
        )}
        {!!job.consecutiveFailures && (
          <div className="job-failure">
            <Badge tone="danger">
              {job.consecutiveFailures}{" "}
              {job.consecutiveFailures === 1 ? "failure" : "failures"}
            </Badge>
            <small>{job.lastError}</small>
          </div>
        )}
      </td>
      <td className="num">
        {!job.enabled ? (
          <Badge>Paused</Badge>
        ) : job.nextRunAt ? (
          <time
            dateTime={job.nextRunAt}
            title={new Date(job.nextRunAt).toLocaleString()}
          >
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
                if (run.status === "error")
                  throw new Error(run.summary ?? "Job failed");
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
                () =>
                  job.enabled ? jobsApi.pause(job.id) : jobsApi.resume(job.id),
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
export function JobsTable({
  jobs,
  onHistory,
}: {
  jobs: Job[];
  onHistory(job: Job): void;
}) {
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
            {["Job", "Last run", "Next run", ""].map(
              (h) => (
                <th scope="col" key={h || "actions"}>
                  {h || <span className="sr-only">Actions</span>}
                </th>
              ),
            )}
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
function JobHistory({ job, onClose }: { job: Job; onClose(): void }) {
  const history = useResource<JobRun[]>(
      `/jobs/${encodeURIComponent(job.id)}/history`,
    ),
    task = useTask();
  return (
    <section className="settings-block inset" aria-label={`${job.name} history`}>
      <div className="block-heading">
        <h3>{job.name}: recent runs</h3>
        <button className="btn btn-sm btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="hint">
        The most recent 20 runs. Overlapping ticks appear as skipped.
      </p>
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
                <Badge
                  tone={
                    run.status === "error"
                      ? "danger"
                      : run.status === "ok"
                        ? "good"
                        : ""
                  }
                >
                  {run.status}
                </Badge>
                <time dateTime={run.startedAt}>
                  {new Date(run.startedAt).toLocaleString()}
                </time>
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
            if (
              await task.run(() => jobsApi.remove(job.id), "Routine deleted.")
            )
              onClose();
          }}
        >
          Delete routine
        </button>
      )}
    </section>
  );
}
const examples = [
  ["Morning triage", "Triage anything new, then prepare my day's digest."],
  [
    "Matter check-in",
    "Review my active matters and prepare the next steps that need my attention.",
  ],
  [
    "Reply drafts",
    "Review unanswered mail from people I know and prepare reply drafts for my approval.",
  ],
];
export function NewRoutineForm({ onCreated }: { onCreated(): void }) {
  const [name, setName] = useState(""),
    [type, setType] = useState<"interval" | "daily" | "weekly">("daily"),
    [at, setAt] = useState("07:30"),
    [minutes, setMinutes] = useState(120),
    [days, setDays] = useState([1, 2, 3, 4, 5]),
    [timeZone, setZone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [instruction, setInstruction] = useState("");
  const task = useTask();
  return (
    <form
      className="settings-block inset routine-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const schedule: JobSchedule =
          type === "interval"
            ? { type, everyMs: minutes * 60000 }
            : type === "weekly"
              ? { type, days, at, timeZone }
              : { type, at, timeZone };
        if (
          await task.run(
            () => jobsApi.add({ name, schedule, routine: { instruction } }),
            "Routine created.",
          )
        )
          onCreated();
      }}
    >
      <label className="field">
        Name
        <input
          autoFocus
          required
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My morning routine"
        />
      </label>
      <label className="field">
        Schedule
        <select
          value={type}
          onChange={(e) => setType(e.target.value as typeof type)}
        >
          <option value="interval">Interval</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      {type === "interval" ? (
        <label className="field">
          Every (minutes)
          <input
            type="number"
            min={1}
            max={525600}
            required
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
      ) : (
        <>
          <label className="field">
            Time
            <input
              type="time"
              required
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          <label className="field">
            Time zone
            <input
              required
              value={timeZone}
              onChange={(e) => setZone(e.target.value)}
              placeholder="America/New_York"
            />
          </label>
        </>
      )}
      {type === "weekly" && (
        <fieldset className="field">
          <legend>Days</legend>
          <div className="chip-set">
            {weekdays.map((day, i) => (
              <label key={day} className="chip-toggle">
                <input
                  type="checkbox"
                  checked={days.includes(i)}
                  onChange={() =>
                    setDays((old) =>
                      old.includes(i)
                        ? old.filter((d) => d !== i)
                        : [...old, i].sort(),
                    )
                  }
                />
                {day}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <label className="field">
        Instruction
        <textarea
          required
          maxLength={20000}
          rows={6}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="What should Passport do for you?"
        />
      </label>
      <div className="routine-examples" aria-label="Example instructions">
        {examples.map(([title, example]) => (
          <button
            className="chip"
            type="button"
            key={title}
            onClick={() => setInstruction(example!)}
          >
            {title}
          </button>
        ))}
      </div>
      <p className="hint">
        Routines follow your permission mode. Anything that needs approval
        lands in your queue.
      </p>
      <Feedback error={task.error} />
      <div className="form-actions">
      <button
        className="btn btn-primary"
        disabled={
          task.busy ||
          !name.trim() ||
          !instruction.trim() ||
          (type === "weekly" && !days.length)
        }
      >
        {task.busy ? "Creating…" : "Create routine"}
      </button>
      </div>
    </form>
  );
}
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
            <button
              className="btn btn-sm"
              onClick={() => setCreating(true)}
            >
              <Icon name="plus" size={14} />
              New routine
            </button>
          )}
        </div>
        <p className="hint">
          Instructions Passport runs on a schedule, like a morning triage.
        </p>
        {creating && (
          <NewRoutineForm onCreated={() => setCreating(false)} />
        )}
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
      {selected && (
        <JobHistory job={selected} onClose={() => setHistoryId(null)} />
      )}
      {!!system.length && (
        <section className="settings-block">
          <h3>Background jobs</h3>
          <p className="hint">
            Sync, the outbox, digests and upkeep. They run while{" "}
            <code>passport serve</code> is open.
          </p>
          <JobsTable jobs={system} onHistory={(job) => setHistoryId(job.id)} />
        </section>
      )}
    </>
  );
}
