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
    if (visited.has(box.id)) {
      return true;
    }
    visited.add(box.id);
    if (
      box.role === "trash" ||
      box.role === "junk" ||
      (box.role == null && aliases.has(box.name.trim().toLowerCase()))
    ) {
      return true;
    }
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
  if (!["label", "unlabel", "move", "archive", "unarchive", "delete"].includes(type)) {
    return false;
  }
  if (type === "delete") {
    return true;
  }
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
  function destinationMailbox() {
    if (type === "label") {
      return named;
    }
    if (type === "move") {
      return boxes.find((box) => box.id === input.toMailboxId);
    }
    if (type === "unarchive") {
      if (input.toMailboxId) {
        return boxes.find((box) => box.id === input.toMailboxId);
      }
      return role("inbox");
    }
    if (type === "archive") {
      return (
        role("archive") ??
        (!labels
          ? (role("all") ?? boxes.find((box) => box.name.toLowerCase() === "archive"))
          : undefined)
      );
    }
    return undefined;
  }
  const destination = destinationMailbox();
  if (destination && destructiveMailbox(boxes, destination)) {
    return true;
  }
  return emails.some((email) => {
    let ids = [...email.mailboxIds];
    if (type === "move" || (!labels && ["archive", "unarchive"].includes(type))) {
      ids = destination ? [destination.id] : ids;
    } else {
      if (destination && !ids.includes(destination.id)) {
        ids.push(destination.id);
      }
      function removedMailbox() {
        if (type === "unlabel") {
          return named;
        }
        if (type === "archive") {
          return role("inbox");
        }
        if (type === "unarchive") {
          return role("archive");
        }
        return undefined;
      }
      const removed = removedMailbox();
      if (removed && removed.id !== destination?.id) {
        ids = ids.filter((id) => id !== removed.id);
      }
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
