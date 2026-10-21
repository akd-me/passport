import type { ActionParams, ActionType, Email, Mailbox, Store } from "@passport/types";

const aliases = new Set([
  "trash",
  "deleted items",
  "deleted messages",
  "bin",
  "junk",
  "spam",
  "[gmail]/trash",
  "[gmail]/spam",
]);

/** Follow provider hierarchy as well as role-less special-folder aliases. Cycles fail closed. */
function destructiveMailbox(boxes: readonly Mailbox[], box?: Mailbox): boolean {
  const visited = new Set<string>();
  while (box) {
    if (visited.has(box.id)) return true;
    visited.add(box.id);
    if (
      box.role === "trash" ||
      box.role === "junk" ||
      (box.role == null && aliases.has(box.name.trim().toLowerCase()))
    )
      return true;
    box = box.parentId ? boxes.find((parent) => parent.id === box!.parentId) : undefined;
  }
  return false;
}

/** One destination check for every mailbox mutation, including label aliases and removals. */
export async function destinationGuard(
  store: Store,
  type: ActionType,
  accountId: string,
  params: ActionParams[ActionType],
  emails: readonly Email[],
): Promise<boolean> {
  if (!["label", "unlabel", "move", "archive", "unarchive", "delete"].includes(type)) return false;
  if (type === "delete") return true;
  const boxes = await store.mailboxes.list(accountId);
  const input = params as { label?: string; toMailboxId?: string };
  const named = input.label
    ? boxes.find(
        (box) =>
          [box.id, box.providerId].includes(input.label!) ||
          box.name.toLowerCase() === input.label!.toLowerCase(),
      )
    : undefined;
  const role = (name: string) => boxes.find((box) => box.role === name);
  const labels = (await store.accounts.get(accountId))?.capabilities.labels;
  const destination =
    type === "label"
      ? named
      : type === "move"
        ? boxes.find((box) => box.id === input.toMailboxId)
        : type === "unarchive"
          ? input.toMailboxId
            ? boxes.find((box) => box.id === input.toMailboxId)
            : role("inbox")
          : type === "archive"
            ? (role("archive") ??
              (!labels
                ? (role("all") ?? boxes.find((box) => box.name.toLowerCase() === "archive"))
                : undefined))
            : undefined;
  if (destination && destructiveMailbox(boxes, destination)) return true;
  return emails.some((email) => {
    let ids = [...email.mailboxIds];
    if (type === "move" || (!labels && ["archive", "unarchive"].includes(type)))
      ids = destination ? [destination.id] : ids;
    else {
      if (destination && !ids.includes(destination.id)) ids.push(destination.id);
      const removed =
        type === "unlabel"
          ? named
          : type === "archive"
            ? role("inbox")
            : type === "unarchive"
              ? role("archive")
              : undefined;
      if (removed && removed.id !== destination?.id) ids = ids.filter((id) => id !== removed.id);
    }
    const safe = (id: string) =>
      !destructiveMailbox(
        boxes,
        boxes.find((box) => box.id === id),
      );
    return (
      email.mailboxIds.some(safe) &&
      !ids.some(safe) &&
      (!labels ||
        ids.some((id) =>
          destructiveMailbox(
            boxes,
            boxes.find((box) => box.id === id),
          ),
        ))
    );
  });
}
