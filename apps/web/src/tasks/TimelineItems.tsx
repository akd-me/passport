import type { MailRow, TaskItem } from "@passport/types";
import { AccountDot } from "../accounts/AccountFilter";
import { Markdown } from "../components/Markdown";
import { Icon, relativeTime } from "../components/ui";

/**
 * Item text, always as a text node: never markdown, never HTML, never a link. Untrusted items
 * may quote mail, and their sigils are already neutralized by the server. Passport's own
 * messages use `Markdown` instead, which renders structure but still no anchors or images.
 */
export function PlainText({ text, className = "" }: { text: string; className?: string }) {
  return <p className={`plain-text ${className}`}>{text}</p>;
}

/** A message the item refers to: sender, subject, snippet. Static text, nothing loads. */
export function MailRowCard({ row }: { row: MailRow }) {
  const sender = row.from.replace(/\s*<[^>]*>$/, "") || row.from;
  return (
    <div className={`mail-row-card ${row.unread ? "unread" : ""}`}>
      <div className="mail-row-head">
        <AccountDot id={row.account} />
        <span className="mail-row-from" title={row.from}>
          {sender}
        </span>
        {row.attachments > 0 && (
          <span className="mail-row-meta" title={`${row.attachments} attachments`}>
            <Icon name="attach" size={12} />
            {row.attachments}
          </span>
        )}
        <time dateTime={row.date}>{relativeTime(row.date)}</time>
      </div>
      <div className="mail-row-subject">{row.subject || "(no subject)"}</div>
      {row.snippet && <div className="mail-row-snippet">{row.snippet}</div>}
    </div>
  );
}

const sourceIcon = { arrival: "mail", watch: "watch", schedule: "routine", system: "alert" };
const noticeTone = (code?: string) =>
  code === "RUN_CANCELLED" || code === "RETRY" ? "" : code ? "warn" : "";

/** Every item kind except tool calls (grouped) and approvals (actionable). */
export function TimelineItem({ item }: { item: TaskItem }) {
  switch (item.kind) {
    case "user_message":
      return (
        <div className="tl-message from-user">
          <span className="tl-author">You</span>
          <PlainText text={item.payload.text} />
        </div>
      );
    case "assistant_message":
    case "question":
      return (
        <div className={`tl-message from-agent ${item.kind}`}>
          <span className="tl-author">
            <Icon name="sparkle" size={13} />
            {item.kind === "question" ? "Passport asks" : "Passport"}
          </span>
          <Markdown text={item.payload.text} className="agent-text" />
        </div>
      );
    case "notification":
      return (
        <div className="tl-notification">
          <div className="tl-line">
            <Icon name={sourceIcon[item.payload.source]} size={14} />
            <PlainText text={item.payload.summary} />
            <time dateTime={item.at}>{relativeTime(item.at)}</time>
          </div>
          {item.payload.row && <MailRowCard row={item.payload.row} />}
        </div>
      );
    case "system_notice":
      return (
        <div className={`tl-notice ${noticeTone(item.payload.code)}`}>
          <Icon name={item.payload.code === "RUN_CANCELLED" ? "stop" : "alert"} size={13} />
          <PlainText text={item.payload.text} />
        </div>
      );
    default:
      return null;
  }
}
