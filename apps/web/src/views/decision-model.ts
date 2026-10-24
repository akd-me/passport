import type { ActionRecord, DraftInput } from "@passport/types";
import { isTyping } from "../ui-state";
import { useWindowKeydown } from "../use-window-keydown";

export const draftOf = (action: ActionRecord) =>
  (action.request.params as { draft?: DraftInput }).draft;

export const recipients = (draft: DraftInput) => draft.to.map((p) => p.name ?? p.email).join(", ");

export type Grouping = "matter" | "newest";

/** Pure grouping so the queue order (and j/k order) is predictable and testable. */
export function groupProposals(
  proposed: ActionRecord[],
  grouping: Grouping,
): Array<[string, ActionRecord[]]> {
  if (grouping === "newest") {
    return [["newest", [...proposed].sort((a, b) => b.createdAt.localeCompare(a.createdAt))]];
  }
  const grouped = new Map<string, ActionRecord[]>();
  for (const action of proposed) {
    const key = action.request.matterId ?? "unassigned";
    grouped.set(key, [...(grouped.get(key) ?? []), action]);
  }
  const unassigned = grouped.get("unassigned");
  grouped.delete("unassigned");
  return [
    ...grouped,
    ...(unassigned ? [["unassigned", unassigned] as [string, ActionRecord[]]] : []),
  ];
}

/** j/k to move, a/r/e to decide on the selected proposal. */
export function useQueueKeys(
  ordered: ActionRecord[],
  selected: string | undefined,
  select: (id: string) => void,
) {
  useWindowKeydown((event) => {
    if (
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isTyping(event.target) ||
      document.querySelector('[aria-modal="true"]')
    ) {
      return;
    }
    if (!["j", "k", "a", "r", "e", "ArrowDown", "ArrowUp"].includes(event.key)) {
      return;
    }
    if (
      event.key.startsWith("Arrow") &&
      !(event.target as HTMLElement)?.closest?.("[data-decision]")
    ) {
      return;
    }
    event.preventDefault();
    const index = Math.max(
      0,
      ordered.findIndex((a) => a.id === selected),
    );
    if (["j", "k", "ArrowDown", "ArrowUp"].includes(event.key)) {
      const down = event.key === "j" || event.key === "ArrowDown";
      const next = ordered[Math.max(0, Math.min(ordered.length - 1, index + (down ? 1 : -1)))];
      if (next) {
        select(next.id);
        const element = document.querySelector<HTMLElement>(
          `[data-decision="${CSS.escape(next.id)}"]`,
        );
        element?.focus({ preventScroll: true });
        element?.scrollIntoView?.({ block: "nearest" });
      }
    } else {
      document
        .querySelector<HTMLElement>(`[data-decision="${CSS.escape(selected ?? "")}"]`)
        ?.querySelector<HTMLButtonElement>(
          `[data-action="${{ a: "approve", r: "reject", e: "edit" }[event.key]}"]`,
        )
        ?.click();
    }
  });
}
