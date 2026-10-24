import type { SecretRequest, TaskItem } from "@passport/types";
import { useState } from "react";
import { request } from "../api";
import { Feedback } from "../components/ui";
import { useResource, useTask } from "../state";

export function SecretRequestItem({
  item,
}: {
  item: Extract<TaskItem, { kind: "secret_request" }>;
}) {
  const path =
    "/tasks/" +
    encodeURIComponent(item.taskId) +
    "/secrets/" +
    encodeURIComponent(item.payload.requestId);
  const state = useResource<SecretRequest>(path);
  const action = useTask();
  const [value, setValue] = useState("");
  const [resolved, setResolved] = useState<SecretRequest>();
  const current = resolved ?? state.data;
  const send = (response: { value: string } | { status: "declined" }) =>
    action.run(async () => {
      setResolved(
        await request<SecretRequest>(path, { method: "POST", body: JSON.stringify(response) }),
      );
      setValue("");
    }, "Private request updated.");
  return (
    <section className="scheduler-secret-request" aria-label="Private secret request">
      <p>{item.payload.text}</p>
      {!current ? (
        <p className="muted">Loading private request…</p>
      ) : current.status !== "pending" ? (
        <p className="muted">
          {current.status === "saved"
            ? "Secret saved privately."
            : current.status.replaceAll("_", " ")}
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send({ value });
          }}
        >
          <label className="field">
            Secret
            <input
              type="password"
              autoComplete="off"
              required
              maxLength={65536}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <p className="hint">
            Stored encrypted. Passport receives a one-use reference; your secret stays out of the
            conversation.
          </p>
          <div className="row-actions">
            <button className="btn btn-sm" disabled={action.busy || !value}>
              Save privately
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={action.busy}
              onClick={() => void send({ status: "declined" })}
            >
              Decline
            </button>
          </div>
        </form>
      )}
      <Feedback error={state.error ?? action.error} />
    </section>
  );
}
