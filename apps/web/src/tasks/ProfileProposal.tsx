import "./ProfileProposal.css";
import type { ActionRecord } from "@passport/types";
import { Markdown } from "../components/Markdown";

/** Profile changes must be visible before the person approves their whole-document replacement. */
export function ProfileProposal({ action }: { action?: ActionRecord }) {
  if (action?.request.type !== "profile_update") {
    return null;
  }
  const markdown = (action.request.params as { markdown?: unknown }).markdown;
  if (typeof markdown !== "string") {
    return null;
  }
  return (
    <details className="profile-proposal">
      <summary>Review proposed USER.md</summary>
      <Markdown text={markdown} />
    </details>
  );
}
