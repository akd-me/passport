import type { DraftInput, Email, Page, Thread } from "@passport/types";
import { useResource } from "../state";

export function useDraftThread(draft: DraftInput) {
  const source = useResource<Email>(
    draft.inReplyToEmailId ? `/emails/${encodeURIComponent(draft.inReplyToEmailId)}` : null,
  );
  const thread = useResource<{ thread: Thread; emails: Page<Email> }>(
    source.data ? `/threads/${encodeURIComponent(source.data.threadId)}` : null,
  );
  return {
    emails: [...(thread.data?.emails.items ?? [])]
      .filter((email) => !email.keywords.$draft)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)),
    loading: !!draft.inReplyToEmailId && (source.loading || !source.data || thread.loading),
    error: source.error ?? thread.error,
    retry: source.refresh,
  };
}

function escape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

/** A quoted message's date the way a mail client writes it ("24 Oct 2026, 09:00"). */
const mailDate = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

/** Only a fragment request: the server sanitises it before RenderFrame receives anything. */
export function draftPreview(draft: DraftInput, body: string, emails: Email[]): string {
  const to = draft.to.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", ");
  const content =
    body === draft.textBody && draft.htmlBody
      ? draft.htmlBody
      : `<div class="mail"><p>${escape(body)}</p></div>`;
  const history = [...emails]
    .reverse()
    .map(
      (email) =>
        `<p>${escape(
          `On ${mailDate(email.receivedAt)}, ${email.from.map((p) => p.name ?? p.email).join(", ")} wrote:`,
        )}</p><blockquote><div class="mail"><p>${escape(email.textBody ?? email.preview)}</p></div></blockquote>`,
    )
    .join("");
  return `<h2>${escape(draft.subject)}</h2><p>To: ${escape(to)}</p>${content}${history ? `<hr>${history}` : ""}`;
}
