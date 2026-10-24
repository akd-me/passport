import type { RoutineRunOn, WebhookFilter, WebhookSchedule } from "@passport/types";

export function RunOnField({
  value,
  onChange,
}: {
  value: RoutineRunOn;
  onChange(value: RoutineRunOn): void;
}) {
  return (
    <label className="field">
      Run on
      <select value={value} onChange={(event) => onChange(event.target.value as RoutineRunOn)}>
        <option value="bound">This routine’s task</option>
        <option value="fresh">A new task for each run</option>
      </select>
    </label>
  );
}

export function WebhookFields({
  value,
  onChange,
}: {
  value: WebhookSchedule;
  onChange(value: WebhookSchedule): void;
}) {
  const signature = value.signature;
  const dedupe = value.dedupe ?? {};
  const setDedupe = (patch: Partial<NonNullable<WebhookSchedule["dedupe"]>>) =>
    onChange({ ...value, dedupe: { ...dedupe, ...patch } });
  const setFilter = (index: number, patch: Partial<WebhookFilter>) =>
    onChange({
      ...value,
      filters: value.filters?.map((filter, i) => (i === index ? { ...filter, ...patch } : filter)),
    });
  return (
    <fieldset className="scheduler-webhook-fields">
      <legend>Webhook</legend>
      <p className="hint">
        A private URL is created with the routine. Use placeholders such as {"{{body.action}}"} in
        the instruction.
      </p>
      <label>
        <input
          type="checkbox"
          checked={!!signature}
          onChange={(event) =>
            onChange({
              ...value,
              signature: event.target.checked
                ? {
                    header: "x-hub-signature-256",
                    encoding: "hex",
                    prefix: "sha256=",
                    secretRef: "",
                  }
                : undefined,
            })
          }
        />{" "}
        Verify HMAC signatures
      </label>
      {signature && (
        <>
          <label className="field">
            Signature header
            <input
              required
              value={signature.header}
              onChange={(event) =>
                onChange({ ...value, signature: { ...signature, header: event.target.value } })
              }
            />
          </label>
          <label className="field">
            Secret reference
            <input
              required
              autoComplete="off"
              value={signature.secretRef}
              onChange={(event) =>
                onChange({ ...value, signature: { ...signature, secretRef: event.target.value } })
              }
            />
          </label>
          <p className="hint">
            Ask Passport for a private secret request in a task to get a one-use reference.
          </p>
          <label className="field">
            Signature encoding
            <select
              value={signature.encoding}
              onChange={(event) =>
                onChange({
                  ...value,
                  signature: { ...signature, encoding: event.target.value as "hex" | "base64" },
                })
              }
            >
              <option value="hex">Hex</option>
              <option value="base64">Base64</option>
            </select>
          </label>
          <label className="field">
            Signature prefix
            <input
              value={signature.prefix ?? ""}
              onChange={(event) =>
                onChange({ ...value, signature: { ...signature, prefix: event.target.value } })
              }
            />
          </label>
        </>
      )}
      <label className="field">
        Maximum delivery age (minutes)
        <input
          type="number"
          min={1}
          max={1440}
          value={value.maxDeliveryAgeMinutes ?? ""}
          onChange={(event) =>
            onChange({
              ...value,
              maxDeliveryAgeMinutes: event.target.value ? Number(event.target.value) : undefined,
            })
          }
        />
      </label>
      <label className="field">
        Replay key
        <input
          value={dedupe.replayKey ?? ""}
          placeholder="{{headers.x-github-delivery}}"
          onChange={(event) => setDedupe({ replayKey: event.target.value || undefined })}
        />
      </label>
      <label className="field">
        Coalesce key
        <input
          value={dedupe.coalesceKey ?? ""}
          placeholder="{{body.issue.number}}"
          onChange={(event) =>
            setDedupe({
              coalesceKey: event.target.value || undefined,
              ...(!event.target.value ? { coalesceWindowSeconds: undefined } : {}),
            })
          }
        />
      </label>
      {dedupe.coalesceKey && (
        <label className="field">
          Coalesce window (seconds)
          <input
            type="number"
            required
            min={10}
            max={3600}
            value={dedupe.coalesceWindowSeconds ?? 120}
            onChange={(event) => setDedupe({ coalesceWindowSeconds: Number(event.target.value) })}
          />
        </label>
      )}
      <p className="hint">
        Repeated replay keys are ignored for seven days. Coalescing runs once after the window,
        using the latest payload.
      </p>
      {value.filters?.map((filter, index) => (
        <fieldset key={index} className="scheduler-filter">
          <legend>Filter {index + 1}</legend>
          <label className="field">
            Path
            <input
              required
              value={filter.path}
              placeholder="body.issue.labels[].name"
              onChange={(event) => setFilter(index, { path: event.target.value })}
            />
          </label>
          <label className="field">
            Match
            <select
              value={filter.op}
              onChange={(event) => {
                const op = event.target.value as WebhookFilter["op"];
                setFilter(index, {
                  op,
                  value: op === "in" ? [] : op === "exists" ? undefined : "",
                });
              }}
            >
              <option value="equals">Equals</option>
              <option value="notEquals">Does not equal</option>
              <option value="startsWith">Starts with</option>
              <option value="in">One of</option>
              <option value="exists">Exists</option>
            </select>
          </label>
          {filter.op !== "exists" && (
            <label className="field">
              {filter.op === "in" ? "Values (comma separated)" : "Value"}
              <input
                required
                value={
                  Array.isArray(filter.value) ? filter.value.join(", ") : String(filter.value ?? "")
                }
                onChange={(event) =>
                  setFilter(index, {
                    value:
                      filter.op === "in"
                        ? event.target.value.split(",").map((value) => value.trim())
                        : event.target.value,
                  })
                }
              />
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() =>
              onChange({ ...value, filters: value.filters?.filter((_, i) => i !== index) })
            }
          >
            Remove filter {index + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={(value.filters?.length ?? 0) >= 16}
        onClick={() =>
          onChange({
            ...value,
            filters: [...(value.filters ?? []), { path: "", op: "equals", value: "" }],
          })
        }
      >
        Add filter
      </button>
    </fieldset>
  );
}
