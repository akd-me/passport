import { useState } from "react";
import { Feedback } from "../components/ui";
import { type JobSchedule, jobsApi } from "../scheduler-api";
import { useTask } from "../state";
import { weekdays } from "./JobTable";

export const examples = [
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
    [timeZone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone),
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
        ) {
          onCreated();
        }
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
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
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
            <input type="time" required value={at} onChange={(e) => setAt(e.target.value)} />
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
                      old.includes(i) ? old.filter((d) => d !== i) : [...old, i].sort(),
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
        Routines follow your permission mode. Anything that needs approval lands in your queue.
      </p>
      <Feedback error={task.error} />
      <div className="form-actions">
        <button
          className="btn btn-primary"
          disabled={
            task.busy || !name.trim() || !instruction.trim() || (type === "weekly" && !days.length)
          }
        >
          {task.busy ? "Creating…" : "Create routine"}
        </button>
      </div>
    </form>
  );
}
