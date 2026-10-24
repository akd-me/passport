import type { WebhookDelivery, WebhookDeliveryOutcome } from "@passport/types";
import { useState } from "react";
import { Badge, Feedback, Loading, relativeTime } from "../components/ui";
import { type Job, jobsApi } from "../scheduler-api";
import { useResource, useTask } from "../state";

/** Each outcome as a badge, toned like the run history below it. */
const outcomeTone: Record<WebhookDeliveryOutcome, string> = {
  accepted: "good",
  dispatch_failed: "danger",
  rejected_signature: "danger",
  expired: "danger",
  rate_limited: "warn",
  disabled: "warn",
  duplicate: "",
  coalesced: "",
  filtered: "",
};

/** Payloads are plain text, including expanded prompts. No remote content is loaded. */
export function Deliveries({ job }: { job: Job }) {
  const deliveries = useResource<WebhookDelivery[]>(
    job.schedule.type === "webhook" ? "/jobs/" + encodeURIComponent(job.id) + "/deliveries" : null,
  );
  const action = useTask();
  const [rotatedUrl, setRotatedUrl] = useState<string>();
  if (job.schedule.type !== "webhook") {
    return null;
  }
  const url = rotatedUrl ?? job.webhookUrl;
  return (
    <section className="scheduler-deliveries" aria-label="Deliveries">
      <h3>Deliveries</h3>
      {url && (
        <label className="field">
          Webhook URL
          <input
            readOnly
            value={new URL(url, window.location.origin).href}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={action.busy}
        onClick={() =>
          action.run(async () => {
            setRotatedUrl((await jobsApi.rotateToken(job.id)).webhookUrl);
          }, "Webhook URL rotated.")
        }
      >
        Rotate webhook URL
      </button>
      <p className="hint">
        The latest 50 deliveries. Anyone with this URL can trigger the routine.
      </p>
      <Feedback error={deliveries.error ?? action.error} />
      {!deliveries.data ? (
        !deliveries.error && <Loading />
      ) : !deliveries.data.length ? (
        <p className="muted">No deliveries yet.</p>
      ) : (
        <ol className="scheduler-delivery-list">
          {[...deliveries.data].reverse().map((delivery) => (
            <li key={delivery.id}>
              <div className="scheduler-delivery-head">
                <Badge tone={outcomeTone[delivery.outcome] ?? ""}>
                  {delivery.outcome.replaceAll("_", " ")}
                </Badge>
                <time
                  dateTime={delivery.receivedAt}
                  title={new Date(delivery.receivedAt).toLocaleString()}
                >
                  {relativeTime(delivery.receivedAt)}
                </time>
              </div>
              {delivery.prompt && (
                <details>
                  <summary>Rendered instruction</summary>
                  <pre>{delivery.prompt}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
