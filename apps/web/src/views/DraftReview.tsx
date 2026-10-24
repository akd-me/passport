import type { ActionRecord, DraftInput } from "@passport/types";
import { useEffect, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Feedback, Loading } from "../components/ui";
import { useWorkspace } from "../state";
import { useActions, useDecision } from "../tasks/actions-store";
import { RenderFrame } from "../tasks/RenderFrame";
import { renderApi } from "../tasks/render-api";
import { draftOf, recipients } from "./decision-model";
import { draftPreview, useDraftThread } from "./draft-review-model";

/** Shared entry from a timeline approval, Needs you, and its details panel. */
export function DraftReview({ action }: { action: ActionRecord }) {
  const [open, setOpen] = useState(false);
  const actions = useActions();
  const current = actions.records.get(action.id) ?? action;
  const draft = draftOf(current);
  if (!draft || current.status !== "proposed" || actions.decided.has(action.id)) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={actions.busy.has(action.id)}
        onClick={() => setOpen(true)}
      >
        Review draft
      </button>
      {open && <DraftReviewDialog action={current} draft={draft} onClose={() => setOpen(false)} />}
    </>
  );
}

function DraftReviewDialog({
  action,
  draft,
  onClose,
}: {
  action: ActionRecord;
  draft: DraftInput;
  onClose: () => void;
}) {
  const [body, setBody] = useState(draft.textBody);
  const [saved, setSaved] = useState(draft.textBody);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<{ html: string; height: number; input: string }>();
  const [previewError, setPreviewError] = useState("");
  const thread = useDraftThread(draft);
  const decision = useDecision(action.id);
  const actions = useActions();
  const { notify } = useWorkspace();
  const busy = saving || decision.busy;
  const html = draftPreview(draft, body, thread.emails);
  useEffect(() => {
    if (!preview || thread.loading || thread.error) {
      return;
    }
    const controller = new AbortController();
    setDocument(undefined);
    setPreviewError("");
    void renderApi.preview(html, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) {
          setDocument({ ...result, input: html });
        }
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) {
          setPreviewError(failure instanceof Error ? failure.message : "Preview did not load.");
        }
      },
    );
    return () => controller.abort();
  }, [preview, html, thread.loading, thread.error]);

  const save = async () => {
    if (busy || !body.trim()) {
      return;
    }
    setSaving(true);
    setError("");
    try {
      await actions.saveDraft(action.id, body);
      setSaved(body);
      notify("Draft saved. It still needs approval.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Draft could not be saved.");
    } finally {
      setSaving(false);
    }
  };
  const approve = async () => {
    const edited =
      body !== draft.textBody
        ? {
            ...action.request,
            params: {
              ...action.request.params,
              draft: { ...draft, textBody: body, htmlBody: null },
            },
          }
        : undefined;
    if (await decision.decide({ kind: "approve", edited, scope: "once" }, "Approved.")) {
      onClose();
    }
  };
  return (
    <Dialog title="Review draft" onClose={onClose} size="lg" className="draft-review-dialog">
      <div className="draft-review-columns">
        <section className="draft-review-thread" aria-label="Conversation">
          <h3>Conversation</h3>
          {thread.error ? (
            <>
              <Feedback error={thread.error} />
              <button type="button" className="link-btn" onClick={thread.retry}>
                Retry conversation
              </button>
            </>
          ) : thread.loading ? (
            <Loading />
          ) : !thread.emails.length ? (
            <p className="muted">
              {draft.inReplyToEmailId
                ? "No messages in this conversation."
                : "This starts a new conversation."}
            </p>
          ) : (
            thread.emails.map((email) => (
              <article className="draft-review-mail" key={email.id}>
                <div>
                  <strong>{email.from.map((p) => p.name ?? p.email).join(", ")}</strong>
                  <time dateTime={email.receivedAt}>
                    {new Date(email.receivedAt).toLocaleString()}
                  </time>
                </div>
                <p>{email.subject}</p>
                <pre>{email.textBody ?? email.preview}</pre>
              </article>
            ))
          )}
        </section>
        <section className="draft-review-editor" aria-label="Draft">
          <div className="draft-review-heading">
            <h3>Draft</h3>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              aria-pressed={preview}
              onClick={() => setPreview(!preview)}
            >
              As they will see it
            </button>
          </div>
          <p className="muted">To {recipients(draft)}</p>
          <p>{draft.subject}</p>
          {preview ? (
            <div className="draft-review-preview">
              {thread.error || previewError ? (
                <Feedback error={thread.error ?? previewError} />
              ) : document && document.input === html && !thread.loading ? (
                <RenderFrame title="Draft as received" {...document} />
              ) : (
                <Loading />
              )}
            </div>
          ) : (
            <label className="draft-review-body">
              Draft body
              <textarea
                aria-label="Review draft body"
                value={body}
                maxLength={100000}
                disabled={busy}
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
          )}
        </section>
      </div>
      <footer className="draft-review-actions">
        <Feedback error={error || decision.error} />
        <span className="muted" role="status">
          {body === saved ? "Saved draft" : "Unsaved changes"}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy || !body.trim() || body === saved}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save draft"}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !body.trim()}
          onClick={() => void approve()}
        >
          Approve
        </button>
      </footer>
    </Dialog>
  );
}
