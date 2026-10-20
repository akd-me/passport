import { useEffect, useRef, useState, type ReactNode } from "react";
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
  PageHeader,
  relativeTime,
} from "../components/ui";
import "./Scheduler.css";

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
        <strong>{job.name}</strong>
        <small className="subtle">{job.id}</small>
        {job.running && <Badge tone="blue">Running</Badge>}
      </th>
      <td>
        <Badge tone={job.kind === "user" ? "blue" : "muted"}>
          {job.kind === "user" ? "Routine" : "System"}
        </Badge>
      </td>
      <td>{describeSchedule(job.schedule)}</td>
      <td>
        {job.lastRunAt ? (
          <>
            <time
              dateTime={job.lastRunAt}
              title={new Date(job.lastRunAt).toLocaleString()}
            >
              {relativeTime(job.lastRunAt)}
            </time>
            <small>
              <Badge
                tone={
                  job.lastStatus === "error"
                    ? "amber"
                    : job.lastStatus === "ok"
                      ? "green"
                      : "muted"
                }
              >
                {job.lastStatus}
              </Badge>
              {job.lastDurationMs !== null &&
                ` · ${duration(job.lastDurationMs)}`}
            </small>
          </>
        ) : (
          <span className="subtle">Never run</span>
        )}
        {!!job.consecutiveFailures && (
          <div className="job-failure">
            <Badge tone="amber">
              {job.consecutiveFailures}{" "}
              {job.consecutiveFailures === 1 ? "failure" : "failures"}
            </Badge>
            <small>{job.lastError}</small>
          </div>
        )}
      </td>
      <td>
        {!job.enabled ? (
          <Badge tone="muted">Paused</Badge>
        ) : job.nextRunAt ? (
          <time
            dateTime={job.nextRunAt}
            title={new Date(job.nextRunAt).toLocaleString()}
          >
            {countdown(job.nextRunAt, now)}
          </time>
        ) : (
          "On demand"
        )}
      </td>
      <td>
        <div className="job-actions">
          <button
            className="button secondary compact"
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
            className="button secondary compact"
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
            className="button secondary compact"
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
    <div className="panel table-scroll scheduler-table">
      <table>
        <caption className="sr-only">Scheduled jobs and agent routines</caption>
        <thead>
          <tr>
            {["Job", "Kind", "Schedule", "Last run", "Next run", "Actions"].map(
              (h) => (
                <th scope="col" key={h}>
                  {h}
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
function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const input = ref.current?.querySelector<HTMLInputElement>("input");
    (input ?? ref.current)?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="scheduler-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        if (e.key === "Tab") {
          const elements = ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, select, textarea, [tabindex="0"]',
          );
          const first = elements?.[0],
            last = elements?.[elements.length - 1];
          if (
            e.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === ref.current)
          ) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        className="scheduler-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
      >
        <div className="section-heading">
          <h2>{title}</h2>
          <button className="button secondary compact" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function HistoryDrawer({ job, onClose }: { job: Job; onClose(): void }) {
  const history = useResource<JobRun[]>(
      `/jobs/${encodeURIComponent(job.id)}/history`,
    ),
    task = useTask();
  return (
    <Drawer title={`${job.name} history`} onClose={onClose}>
      <p className="subtle">
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
                      ? "amber"
                      : run.status === "ok"
                        ? "green"
                        : "muted"
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
          className="button secondary"
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
    </Drawer>
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
      className="routine-form"
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
      <label>
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
      <label>
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
        <label>
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
          <label>
            Time
            <input
              type="time"
              required
              value={at}
              onChange={(e) => setAt(e.target.value)}
            />
          </label>
          <label>
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
        <fieldset>
          <legend>Days</legend>
          <div className="weekday-picker">
            {weekdays.map((day, i) => (
              <label key={day}>
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
      <label>
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
            className="button secondary compact"
            type="button"
            key={title}
            onClick={() => setInstruction(example!)}
          >
            {title}
          </button>
        ))}
      </div>
      <p className="subtle">
        Routines follow your trust policy. Actions that need your approval
        appear in Decisions.
      </p>
      <Feedback error={task.error} />
      <button
        className="button primary"
        disabled={
          task.busy ||
          !name.trim() ||
          !instruction.trim() ||
          (type === "weekly" && !days.length)
        }
      >
        {task.busy ? "Creating…" : "Create routine"}
      </button>
    </form>
  );
}
export function Scheduler() {
  const jobs = useResource<Job[]>("/jobs"),
    [historyId, setHistoryId] = useState<string | null>(null),
    [creating, setCreating] = useState(false);
  const selected = jobs.data?.find((j) => j.id === historyId);
  return (
    <>
      <PageHeader
        eyebrow="A STEADY RHYTHM"
        title="Scheduler"
        description="Your mailbox’s background work and the routines you choose to make time for."
      >
        <button className="button primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={16} />
          New routine
        </button>
      </PageHeader>
      <div className="section-heading">
        <h2>Jobs & routines</h2>
        <span className="subtle">
          {jobs.data?.length ?? "—"} jobs · live updates
        </span>
      </div>
      <Feedback error={jobs.error} />
      {!jobs.data ? (
        !jobs.error && <Loading />
      ) : jobs.data.length ? (
        <JobsTable jobs={jobs.data} onHistory={(job) => setHistoryId(job.id)} />
      ) : (
        <Empty title="A little room for routine">
          Create a routine to give Passport a recurring task.
        </Empty>
      )}
      {selected && (
        <HistoryDrawer job={selected} onClose={() => setHistoryId(null)} />
      )}
      {creating && (
        <Drawer title="New routine" onClose={() => setCreating(false)}>
          <NewRoutineForm onCreated={() => setCreating(false)} />
        </Drawer>
      )}
    </>
  );
}
