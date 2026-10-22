import type { Email, MailChange, Matter, Store } from "@passport/types";
import { PolicyError } from "./errors.js";
import type { ActionExecutorOptions, Request, Snapshot } from "./executor-shared.js";

export function createMailActions(options: ActionExecutorOptions) {
  const { store, bus, mailProviderFor } = options;
  const mirrorEmail = async (
    id: string,
    patch: Parameters<Store["emails"]["patchMany"]>[1] & { providerId?: string },
  ) => {
    if (patch.providerId !== undefined) {
      // Keep cached bodies across the providerId rewrite without fetching any from the provider.
      const email = await store.emails.get(id, { includeBodies: true, cacheOnly: true });
      if (email) {
        await store.emails.upsertMany([{ ...email, ...patch }]);
      }
    } else {
      await store.emails.patchMany([id], patch);
    }
    bus.emit({ type: "email.updated", emailId: id });
  };
  const mirrorMatter = async (matter: Matter) => {
    await store.matters.upsert(matter);
    bus.emit({ type: "matter.updated", matter });
  };
  const mailboxFor = async (accountId: string, id: string) => {
    const mailbox = await store.mailboxes.get(id);
    if (!mailbox) {
      throw new PolicyError("MAILBOX_NOT_FOUND", `Mailbox ${id} does not exist`);
    }
    if (mailbox.accountId !== accountId) {
      throw new PolicyError("ACCOUNT_MISMATCH", "Mailbox belongs to another account");
    }
    return mailbox;
  };
  const usesLabels = async (accountId: string) => {
    const account = await store.accounts.get(accountId);
    if (!account) {
      throw new PolicyError("ACCOUNT_NOT_FOUND", `Account ${accountId} does not exist`);
    }
    return account.capabilities.labels;
  };
  const applyMailChanges = async (
    accountId: string,
    changes: MailChange[],
    emails: Array<{ providerId: string }>,
  ) => {
    if (!changes.length) {
      return;
    }
    const results = await (await mailProviderFor(accountId)).applyChanges(changes);
    for (const result of results ?? []) {
      // Copy adds another message; it does not replace the original identity.
      if (result.op === "addToMailbox" || !result.newProviderId) {
        continue;
      }
      for (const email of emails) {
        if (email.providerId === result.providerId) {
          email.providerId = result.newProviderId;
        }
      }
    }
  };
  const changeMail = async (request: Request, snapshot: Extract<Snapshot, { kind: "mail" }>) => {
    const boxes = await store.mailboxes.list(request.accountId);
    const labels = await usesLabels(request.accountId);
    if (
      request.type === "label" &&
      !boxes.some((box) => [box.id, box.providerId, box.name].includes(request.params.label))
    ) {
      if (!labels) {
        throw new PolicyError("MAILBOX_NOT_FOUND", `Label ${request.params.label} does not exist`);
      }
      const provider = await mailProviderFor(request.accountId);
      if (!provider.createMailbox) {
        throw new PolicyError(
          "LABEL_CREATE_UNSUPPORTED",
          "Provider does not support creating labels",
        );
      }
      const created = await provider.createMailbox(request.params.label);
      if (
        created.accountId !== request.accountId ||
        created.role === "trash" ||
        created.role === "junk"
      ) {
        throw new PolicyError("INVALID_MAILBOX", "Provider returned an invalid label");
      }
      await store.mailboxes.upsertMany([created]);
      boxes.push(created);
      snapshot.createdMailboxIds = [created.id];
    }
    const role = (name: string) => {
      const box = boxes.find((item) => item.role === name);
      if (!box) {
        throw new PolicyError("MAILBOX_NOT_FOUND", `Account has no ${name} mailbox`);
      }
      return box;
    };
    const patches: Array<{
      id: string;
      patch: { mailboxIds?: string[]; keywords?: Email["keywords"] };
    }> = [];
    const changes: MailChange[] = [];
    for (const email of snapshot.emails) {
      const ids = [email.providerId];
      let mailboxIds = [...email.mailboxIds];
      const keywords = { ...email.keywords };
      const addMailbox = (box: (typeof boxes)[number]) => {
        if (!mailboxIds.includes(box.id)) {
          changes.push({ op: "addToMailbox", providerIds: ids, mailboxProviderId: box.providerId });
          mailboxIds.push(box.id);
        }
      };
      const removeMailbox = (box: (typeof boxes)[number]) => {
        if (mailboxIds.includes(box.id)) {
          changes.push({
            op: "removeFromMailbox",
            providerIds: ids,
            mailboxProviderId: box.providerId,
          });
          mailboxIds = mailboxIds.filter((id) => id !== box.id);
        }
      };
      const moveMailbox = (box: (typeof boxes)[number]) => {
        changes.push({ op: "move", providerIds: ids, toMailboxProviderId: box.providerId });
        mailboxIds = [box.id];
      };
      switch (request.type) {
        case "label":
        case "unlabel": {
          const name = request.params.label;
          const box = boxes.find(
            (item) => item.id === name || item.name === name || item.providerId === name,
          );
          if (!box) {
            throw new PolicyError("MAILBOX_NOT_FOUND", `Label ${name} does not exist`);
          }
          if (request.type === "label") {
            addMailbox(box);
          } else {
            removeMailbox(box);
          }
          break;
        }
        case "archive": {
          if (labels) {
            const archive = boxes.find((item) => item.role === "archive");
            if (archive) {
              addMailbox(archive);
            }
            removeMailbox(role("inbox"));
          } else {
            const archive =
              boxes.find((item) => item.role === "archive") ??
              boxes.find((item) => item.role === "all") ??
              boxes.find((item) => item.name.toLowerCase() === "archive");
            if (!archive) {
              throw new PolicyError(
                "ARCHIVE_MAILBOX_MISSING",
                "Account has no archive mailbox (archive role, all role, or Archive folder); refusing to remove mail",
              );
            }
            moveMailbox(archive);
          }
          break;
        }
        case "unarchive": {
          const box = request.params.toMailboxId
            ? await mailboxFor(request.accountId, request.params.toMailboxId)
            : role("inbox");
          if (labels) {
            addMailbox(box);
            const archive = boxes.find((item) => item.role === "archive");
            if (archive && archive.id !== box.id) {
              removeMailbox(archive);
            }
          } else {
            moveMailbox(box);
          }
          break;
        }
        case "move":
        case "delete": {
          const box =
            request.type === "move"
              ? await mailboxFor(request.accountId, request.params.toMailboxId)
              : role("trash");
          moveMailbox(box);
          break;
        }
        case "mark_read":
        case "mark_unread":
        case "flag":
        case "unflag": {
          const keyword =
            request.type === "mark_read" || request.type === "mark_unread" ? "$seen" : "$flagged";
          const enabled = request.type === "mark_read" || request.type === "flag";
          if (enabled) {
            keywords[keyword] = true;
          } else {
            delete keywords[keyword];
          }
          changes.push({
            op: "setKeywords",
            providerIds: ids,
            ...(enabled ? { add: [keyword] } : { remove: [keyword] }),
          });
          break;
        }
        default:
          throw new PolicyError("INVALID_ACTION", "Not a mail mutation");
      }
      patches.push({ id: email.id, patch: { mailboxIds, keywords } });
    }
    await applyMailChanges(request.accountId, changes, snapshot.emails);
    for (const { id, patch } of patches) {
      await mirrorEmail(id, {
        ...patch,
        providerId: snapshot.emails.find((email) => email.id === id)!.providerId,
      });
    }
    return { emailIds: patches.map((item) => item.id) };
  };
  return { mirrorEmail, mirrorMatter, mailboxFor, usesLabels, applyMailChanges, changeMail };
}
export type MailActions = ReturnType<typeof createMailActions>;
