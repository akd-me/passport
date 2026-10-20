import { isDeepStrictEqual } from 'node:util';
import {
  BASE_REVERSIBILITY,
  type ActionCategory, type ActionExecutor, type ActionParams, type ActionRecord, type ActionRequest, type ActionType,
  type CalendarEvent, type CalendarProvider, type DraftInput, type Email, type EventBus,
  type MailChange, type MailProvider, type Matter, type Person, type PolicyEngine, type Store, type Timestamp,
} from '@passport/types';
import { PolicyError } from './errors.js';
import { editDistanceRatio } from './helpers.js';
import { newId } from './id.js';
import { parseListUnsubscribe, requestUnsubscribe, type ResolveDns } from './unsubscribe.js';

/** Providers may be resolved synchronously or asynchronously, and must already be connected. */
export interface ActionExecutorOptions {
  store: Store;
  bus: EventBus;
  policy: PolicyEngine;
  mailProviderFor(accountId: string): MailProvider | Promise<MailProvider>;
  calendarProviderFor(accountId: string): CalendarProvider | Promise<CalendarProvider>;
  /** HTTP transport for header/link unsubscribe; defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Resolve all addresses before each unsubscribe request, including redirect hops. */
  resolveDns?: ResolveDns;
  now?: () => Timestamp;
}
type Request = { [K in ActionType]: ActionRequest<K> }[ActionType];
type EmailPatch = Pick<Email, 'id' | 'matterId' | 'personIds' | 'category'>;
type Snapshot =
  | { kind: 'mail'; emails: Email[] }
  | { kind: 'draft'; email: Email | null; createdId?: string }
  | { kind: 'event'; event: CalendarEvent | null; createdId?: string }
  | { kind: 'matter'; matter: Matter | null; id: string; emails: EmailPatch[]; events: CalendarEvent[] }
  | { kind: 'person'; person: Person | null; createdId?: string }
  | { kind: 'snooze'; matter: Matter | null; kv: Array<{ key: string; value: string | null }> };
const marker = '__passportPolicyInverse';
const snapshotOf = (request: ActionRequest) => (request.params as unknown as Record<string, Snapshot>)[marker];
const patchOf = (email: Email): EmailPatch => ({ id: email.id, matterId: email.matterId ?? null, personIds: [...email.personIds], category: email.category ?? null });
const draftOf = (email: Email): DraftInput => ({ accountId: email.accountId, to: email.to, cc: email.cc, bcc: email.bcc, subject: email.subject, textBody: email.textBody ?? '', htmlBody: email.htmlBody, attachments: email.attachments.map(({ name, type, blobId }) => ({ name, type, blobId })) });
const normalizedDraft = (draft: DraftInput): DraftInput => structuredClone({ ...draft, inReplyToEmailId: draft.inReplyToEmailId ?? null, cc: draft.cc ?? [], bcc: draft.bcc ?? [], htmlBody: draft.htmlBody ?? null, attachments: draft.attachments ?? [] });

const isCompletePerson = (patch: Partial<Person>): patch is Person =>
  typeof patch.id === 'string' && patch.id.length > 0 && typeof patch.displayName === 'string' &&
  typeof patch.primaryEmail === 'string' && Array.isArray(patch.emails) && patch.emails.every(email => typeof email === 'string') &&
  ['self', 'known', 'stranger', 'service'].includes(patch.relationship ?? '') &&
  ['blue', 'green', 'unknown'].includes(patch.verification ?? '') &&
  !!patch.stats && typeof patch.stats.sent === 'number' && typeof patch.stats.received === 'number' &&
  (patch.stats.lastContactAt === null || typeof patch.stats.lastContactAt === 'string') &&
  typeof patch.createdAt === 'string' && typeof patch.updatedAt === 'string';

/** Mirrors the agent's package-local getAgentEmailPatch convention without a runtime dependency. */
const agentEmailPatchOf = (request: ActionRequest): Partial<Pick<Email, 'category' | 'personIds'>> => {
  const patch = (request.params as { emailPatch?: unknown }).emailPatch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const { category, personIds } = patch as Record<string, unknown>;
  const categories: readonly ActionCategory[] = ['triage', 'newsletters', 'receipts', 'notifications', 'scheduling', 'replies_known', 'replies_stranger', 'money', 'legal', 'unsubscribe', 'matters', 'other'];
  return {
    ...(category === null || categories.includes(category as ActionCategory) ? { category: category as Email['category'] } : {}),
    ...(Array.isArray(personIds) && personIds.every(id => typeof id === 'string') ? { personIds } : {}),
  };
};

/** Persist, authorize, execute, hold, and undo all mutations through a single serialized gate. */
export function createActionExecutor({ store, bus, policy, mailProviderFor, calendarProviderFor, fetch: fetcher = globalThis.fetch, resolveDns, now = () => new Date().toISOString() }: ActionExecutorOptions): ActionExecutor {
  let queue = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation); queue = result.then(() => undefined, () => undefined); return result;
  };
  const requireAction = async (id: string, statuses: ActionRecord['status'][]): Promise<ActionRecord> => {
    const action = await store.actions.get(id);
    if (!action) throw new PolicyError('ACTION_NOT_FOUND', `Action ${id} does not exist`);
    if (!statuses.includes(action.status)) throw new PolicyError('INVALID_ACTION_STATE', `Cannot perform this operation on a ${action.status} action`);
    return action;
  };
  const claim = async (action: ActionRecord, to: ActionRecord['status'] = 'executing'): Promise<ActionRecord | null> => {
    if (!store.actions.claim) throw new PolicyError('ACTION_CLAIM_UNSUPPORTED', 'Store.actions.claim is required for shared action transitions');
    return store.actions.claim(action.id, action.status, to, now());
  };
  const requireClaim = async (action: ActionRecord): Promise<ActionRecord> => {
    const claimed = await claim(action);
    if (!claimed) throw new PolicyError('INVALID_ACTION_STATE', 'Another executor already claimed this action');
    return claimed;
  };
  const emailFor = async (id: string, accountId: string): Promise<Email> => {
    const email = await store.emails.get(id, { includeBodies: true });
    if (!email) throw new PolicyError('EMAIL_NOT_FOUND', `Email ${id} does not exist`);
    if (email.accountId !== accountId) throw new PolicyError('ACCOUNT_MISMATCH', 'Email belongs to another account');
    return email;
  };
  const eventFor = async (id: string, accountId: string): Promise<CalendarEvent> => {
    const event = await store.events.get(id);
    if (!event) throw new PolicyError('EVENT_NOT_FOUND', `Event ${id} does not exist`);
    if (event.accountId !== accountId) throw new PolicyError('ACCOUNT_MISMATCH', 'Event belongs to another account');
    return event;
  };
  const matterFor = async (id: string): Promise<Matter> => {
    const matter = await store.matters.get(id);
    if (!matter) throw new PolicyError('MATTER_NOT_FOUND', `Matter ${id} does not exist`);
    return matter;
  };
  const allEmails = (ids: string[], accountId: string) => Promise.all([...new Set(ids)].map(id => emailFor(id, accountId)));
  const resolvedDraft = async (request: ActionRequest): Promise<DraftInput> => {
    const { draft, draftEmailId } = request.params as ActionParams['send'];
    if (!!draft === !!draftEmailId) throw new PolicyError('INVALID_PARAMS', 'Send requires exactly one draft or draftEmailId');
    if (draft) return normalizedDraft(draft);
    const email = await emailFor(draftEmailId!, request.accountId);
    if (!email.keywords.$draft) throw new PolicyError('NOT_A_DRAFT', 'Only draft emails can be sent');
    const resolved = draftOf(email);
    if (email.headers.inReplyTo) {
      let cursor: string | null | undefined;
      do {
        const page = await store.emails.query({ accountId: email.accountId, threadId: email.threadId, limit: 100, cursor });
        const source = page.items.find(source => source.id !== email.id && source.headers.messageId === email.headers.inReplyTo);
        if (source) { resolved.inReplyToEmailId = source.id; break; }
        cursor = page.nextCursor;
      } while (cursor);
      if (!resolved.inReplyToEmailId) throw new PolicyError('REPLY_NOT_FOUND', 'The saved draft reply source is unavailable; sync before approving this send');
    }
    return normalizedDraft(resolved);
  };
  const assertPublic = (request: ActionRequest) => {
    if (!request.params || typeof request.params !== 'object' || Object.prototype.hasOwnProperty.call(request.params, marker)) throw new PolicyError('INVALID_PARAMS', 'Private inverse data cannot be submitted');
    if (!['human', 'agent', 'external-agent'].includes(request.actor?.kind)) throw new PolicyError('INVALID_ACTOR', 'Unknown actor kind');
    const params = request.params as unknown as { draft?: DraftInput; event?: CalendarEvent; patch?: { accountId?: string; id?: string; providerId?: string; verification?: unknown; relationship?: unknown } };
    const personParams = request.type === 'person_update' ? request.params as ActionParams['person_update'] : null;
    const completePerson = personParams && isCompletePerson(personParams.patch);
    const personSnapshot = completePerson && request.actor.kind !== 'external-agent';
    if (params.draft && params.draft.accountId !== request.accountId || params.event && params.event.accountId !== request.accountId || params.patch?.accountId && params.patch.accountId !== request.accountId || params.patch?.id !== undefined && !(completePerson && params.patch.id === personParams.personId) || params.patch?.providerId !== undefined) throw new PolicyError('ACCOUNT_MISMATCH', 'Action edits cannot change identity or account');
    if (request.type === 'person_update' && params.patch && !personSnapshot && ('verification' in params.patch || request.actor.kind !== 'human' && 'relationship' in params.patch)) throw new PolicyError('PROTECTED_IDENTITY', 'Verification must come from trusted identity data; only humans can change relationships');
  };
  const capture = async (request: Request): Promise<Snapshot | null> => {
    switch (request.type) {
      case 'label': case 'unlabel': case 'archive': case 'unarchive': case 'mark_read': case 'mark_unread':
      case 'flag': case 'unflag': case 'move': case 'delete':
        return { kind: 'mail', emails: await allEmails(request.params.emailIds, request.accountId) };
      case 'draft_create': return { kind: 'draft', email: null };
      case 'draft_update': case 'draft_delete': {
        const email = await emailFor(request.params.draftEmailId, request.accountId);
        if (!email.keywords.$draft) throw new PolicyError('NOT_A_DRAFT', 'Draft operations require a draft email');
        return { kind: 'draft', email };
      }
      case 'calendar_create': return { kind: 'event', event: null };
      case 'calendar_update': return { kind: 'event', event: await eventFor(request.params.eventId, request.accountId) };
      case 'matter_create': {
        const emails = await allEmails(request.params.matter.emailIds, request.accountId);
        const events = await Promise.all(request.params.matter.eventIds.map(id => eventFor(id, request.accountId)));
        return { kind: 'matter', matter: null, id: newId(now()), emails: emails.map(patchOf), events };
      }
      case 'matter_update': case 'matter_attach': {
        const matter = await matterFor(request.params.matterId);
        const emails = request.type === 'matter_attach' ? await allEmails(request.params.emailIds ?? [], request.accountId) : [];
        const events = request.type === 'matter_attach' ? await Promise.all((request.params.eventIds ?? []).map(id => eventFor(id, request.accountId))) : [];
        if (request.type === 'matter_attach') for (const id of request.params.personIds ?? []) if (!await store.people.get(id)) throw new PolicyError('PERSON_NOT_FOUND', `Person ${id} does not exist`);
        return { kind: 'matter', matter, id: matter.id, emails: emails.map(patchOf), events };
      }
      case 'person_update': {
        const person = await store.people.get(request.params.personId);
        if (!person) {
          if (!isCompletePerson(request.params.patch)) throw new PolicyError('PERSON_NOT_FOUND', `Person ${request.params.personId} does not exist; creation requires a complete Person patch`);
          if (!store.people.delete) throw new PolicyError('PERSON_DELETE_UNSUPPORTED', 'Creating a person requires Store.people.delete so it can be undone');
        }
        return { kind: 'person', person, ...(!person ? { createdId: request.params.personId } : {}) };
      }
      case 'snooze': {
        if (!Number.isFinite(Date.parse(request.params.until))) throw new PolicyError('INVALID_TIME', 'Snooze time must be an ISO timestamp');
        const emails = await allEmails(request.params.emailIds ?? [], request.accountId);
        const kv = await Promise.all(emails.map(async email => { const key = `policy:snooze:${email.id}`; return { key, value: await store.kv.get(key) }; }));
        return { kind: 'snooze', matter: request.params.matterId ? await matterFor(request.params.matterId) : null, kv };
      }
      default: return null;
    }
  };
  const mirrorEmail = async (id: string, patch: Parameters<Store['emails']['patchMany']>[1] & { providerId?: string }) => {
    if (patch.providerId !== undefined) {
      const email = await store.emails.get(id, { includeBodies: true });
      if (email) await store.emails.upsertMany([{ ...email, ...patch }]);
    } else await store.emails.patchMany([id], patch);
    bus.emit({ type: 'email.updated', emailId: id });
  };
  const mirrorMatter = async (matter: Matter) => { await store.matters.upsert(matter); bus.emit({ type: 'matter.updated', matter }); };
  const mailboxFor = async (accountId: string, id: string) => {
    const mailbox = await store.mailboxes.get(id);
    if (!mailbox) throw new PolicyError('MAILBOX_NOT_FOUND', `Mailbox ${id} does not exist`);
    if (mailbox.accountId !== accountId) throw new PolicyError('ACCOUNT_MISMATCH', 'Mailbox belongs to another account');
    return mailbox;
  };
  const usesLabels = async (accountId: string) => {
    const account = await store.accounts.get(accountId);
    if (!account) throw new PolicyError('ACCOUNT_NOT_FOUND', `Account ${accountId} does not exist`);
    return account.capabilities.labels;
  };
  const applyMailChanges = async (accountId: string, changes: MailChange[], emails: Email[]) => {
    if (!changes.length) return;
    const results = await (await mailProviderFor(accountId)).applyChanges(changes);
    for (const result of results ?? []) {
      // Copy adds another message; it does not replace the original identity.
      if (result.op === 'addToMailbox' || !result.newProviderId) continue;
      for (const email of emails) if (email.providerId === result.providerId) email.providerId = result.newProviderId;
    }
  };
  const changeMail = async (request: Request, snapshot: Extract<Snapshot, { kind: 'mail' }>) => {
    const boxes = await store.mailboxes.list(request.accountId);
    const labels = await usesLabels(request.accountId);
    const role = (name: string) => { const box = boxes.find(item => item.role === name); if (!box) throw new PolicyError('MAILBOX_NOT_FOUND', `Account has no ${name} mailbox`); return box; };
    const patches: Array<{ id: string; patch: { mailboxIds?: string[]; keywords?: Email['keywords'] } }> = [];
    const changes: MailChange[] = [];
    for (const email of snapshot.emails) {
      const ids = [email.providerId];
      let mailboxIds = [...email.mailboxIds];
      const keywords = { ...email.keywords };
      const addMailbox = (box: (typeof boxes)[number]) => { if (!mailboxIds.includes(box.id)) { changes.push({ op: 'addToMailbox', providerIds: ids, mailboxProviderId: box.providerId }); mailboxIds.push(box.id); } };
      const removeMailbox = (box: (typeof boxes)[number]) => { if (mailboxIds.includes(box.id)) { changes.push({ op: 'removeFromMailbox', providerIds: ids, mailboxProviderId: box.providerId }); mailboxIds = mailboxIds.filter(id => id !== box.id); } };
      const moveMailbox = (box: (typeof boxes)[number]) => { changes.push({ op: 'move', providerIds: ids, toMailboxProviderId: box.providerId }); mailboxIds = [box.id]; };
      switch (request.type) {
        case 'label': case 'unlabel': {
          const name = request.params.label;
          const box = boxes.find(item => item.id === name || item.name === name || item.providerId === name);
          if (!box) throw new PolicyError('MAILBOX_NOT_FOUND', `Label ${name} does not exist`);
          if (request.type === 'label') addMailbox(box); else removeMailbox(box);
          break;
        }
        case 'archive': {
          if (labels) {
            const archive = boxes.find(item => item.role === 'archive'); if (archive) addMailbox(archive);
            removeMailbox(role('inbox'));
          } else {
            const archive = boxes.find(item => item.role === 'archive') ?? boxes.find(item => item.role === 'all') ?? boxes.find(item => item.name.toLowerCase() === 'archive');
            if (!archive) throw new PolicyError('ARCHIVE_MAILBOX_MISSING', 'Account has no archive mailbox (archive role, all role, or Archive folder); refusing to remove mail');
            moveMailbox(archive);
          }
          break;
        }
        case 'unarchive': {
          const box = request.params.toMailboxId ? await mailboxFor(request.accountId, request.params.toMailboxId) : role('inbox');
          if (labels) {
            addMailbox(box); const archive = boxes.find(item => item.role === 'archive'); if (archive && archive.id !== box.id) removeMailbox(archive);
          } else moveMailbox(box);
          break;
        }
        case 'move': case 'delete': {
          const box = request.type === 'move' ? await mailboxFor(request.accountId, request.params.toMailboxId) : role('trash');
          moveMailbox(box); break;
        }
        case 'mark_read': case 'mark_unread': case 'flag': case 'unflag': {
          const keyword = request.type === 'mark_read' || request.type === 'mark_unread' ? '$seen' : '$flagged';
          const enabled = request.type === 'mark_read' || request.type === 'flag';
          if (enabled) keywords[keyword] = true; else delete keywords[keyword];
          changes.push({ op: 'setKeywords', providerIds: ids, ...(enabled ? { add: [keyword] } : { remove: [keyword] }) }); break;
        }
        default: throw new PolicyError('INVALID_ACTION', 'Not a mail mutation');
      }
      patches.push({ id: email.id, patch: { mailboxIds, keywords } });
    }
    await applyMailChanges(request.accountId, changes, snapshot.emails);
    for (const { id, patch } of patches) await mirrorEmail(id, { ...patch, providerId: snapshot.emails.find(email => email.id === id)!.providerId });
    return { emailIds: patches.map(item => item.id) };
  };
  const restore = async (request: ActionRequest, snapshot: Snapshot): Promise<Record<string, unknown>> => {
    switch (snapshot.kind) {
      case 'mail': {
        const labels = await usesLabels(request.accountId);
        const changes: MailChange[] = [];
        const currents: Email[] = [];
        for (const prior of snapshot.emails) {
          const current = await emailFor(prior.id, request.accountId);
          currents.push(current);
          const add = Object.keys(prior.keywords).filter(key => prior.keywords[key] && !current.keywords[key]);
          const remove = Object.keys(current.keywords).filter(key => current.keywords[key] && !prior.keywords[key]);
          // Apply flags before a folder move, which may change the provider's message ID.
          if (add.length || remove.length) changes.push({ op: 'setKeywords', providerIds: [current.providerId], add, remove });
          if (labels) {
            for (const id of prior.mailboxIds.filter(id => !current.mailboxIds.includes(id))) changes.push({ op: 'addToMailbox', providerIds: [current.providerId], mailboxProviderId: (await mailboxFor(request.accountId, id)).providerId });
            for (const id of current.mailboxIds.filter(id => !prior.mailboxIds.includes(id))) changes.push({ op: 'removeFromMailbox', providerIds: [current.providerId], mailboxProviderId: (await mailboxFor(request.accountId, id)).providerId });
          } else if (prior.mailboxIds.length !== current.mailboxIds.length || prior.mailboxIds.some(id => !current.mailboxIds.includes(id))) {
            if (prior.mailboxIds.length !== 1) throw new PolicyError('INVALID_INVERSE', 'Folder-based mail requires exactly one previous mailbox to restore');
            changes.push({ op: 'move', providerIds: [current.providerId], toMailboxProviderId: (await mailboxFor(request.accountId, prior.mailboxIds[0]!)).providerId });
          }
        }
        await applyMailChanges(request.accountId, changes, currents);
        for (const prior of snapshot.emails) await mirrorEmail(prior.id, { mailboxIds: prior.mailboxIds, keywords: prior.keywords, providerId: currents.find(email => email.id === prior.id)!.providerId });
        return { emailIds: snapshot.emails.map(email => email.id) };
      }
      case 'draft': {
        const provider = await mailProviderFor(request.accountId);
        if (!snapshot.email) {
          if (!snapshot.createdId) throw new PolicyError('INVALID_INVERSE', 'Draft inverse is missing its created id');
          const email = await emailFor(snapshot.createdId, request.accountId);
          await provider.deleteDraft(email.providerId); await store.emails.deleteMany([email.id]); bus.emit({ type: 'email.updated', emailId: email.id });
          return { deletedEmailId: email.id };
        }
        const current = await store.emails.get(snapshot.email.id);
        const restored = current ? await provider.updateDraft(current.providerId, draftOf(snapshot.email)) : await provider.createDraft(draftOf(snapshot.email));
        await store.emails.upsertMany([{ ...snapshot.email, providerId: restored.providerId }]);
        bus.emit({ type: 'email.updated', emailId: snapshot.email.id }); return { emailId: snapshot.email.id };
      }
      case 'event': {
        const provider = await calendarProviderFor(request.accountId);
        if (!snapshot.event) {
          if (!snapshot.createdId) throw new PolicyError('INVALID_INVERSE', 'Event inverse is missing its created id');
          const event = await eventFor(snapshot.createdId, request.accountId);
          await provider.deleteEvent(event.providerId); await store.events.deleteMany([event.id]); return { deletedEventId: event.id };
        }
        const current = await eventFor(snapshot.event.id, request.accountId);
        const restored = await provider.updateEvent(current.providerId, snapshot.event);
        await store.events.upsertMany([{ ...snapshot.event, providerId: restored.providerId }]); return { eventId: snapshot.event.id };
      }
      case 'matter': {
        if (snapshot.matter) await mirrorMatter(snapshot.matter); else await store.matters.delete(snapshot.id);
        for (const email of snapshot.emails) { const { id, ...patch } = email; await mirrorEmail(id, patch); }
        if (snapshot.events.length) await store.events.upsertMany(snapshot.events);
        return { matterId: snapshot.id };
      }
      case 'person': {
        if (snapshot.person) { await store.people.upsert(snapshot.person); return { personId: snapshot.person.id }; }
        if (!snapshot.createdId) throw new PolicyError('INVALID_INVERSE', 'Person inverse is missing its created id');
        if (!store.people.delete) throw new PolicyError('PERSON_DELETE_UNSUPPORTED', 'Undoing person creation requires Store.people.delete');
        await store.people.delete(snapshot.createdId); return { deletedPersonId: snapshot.createdId };
      }
      case 'snooze':
        if (snapshot.matter) await mirrorMatter(snapshot.matter);
        for (const { key, value } of snapshot.kv) { if (value === null) await store.kv.delete(key); else await store.kv.set(key, value); }
        return {};
    }
  };
  const writeMatter = async (request: ActionRequest, snapshot: Extract<Snapshot, { kind: 'matter' }>, matter: Matter): Promise<Matter> => {
    let saved: Matter;
    try {
      saved = await store.matters.upsert(matter);
      if (snapshot.emails.length) await store.emails.patchMany(snapshot.emails.map(email => email.id), { matterId: matter.id, ...agentEmailPatchOf(request) });
      if (snapshot.events.length) await store.events.upsertMany(snapshot.events.map(event => ({ ...event, matterId: matter.id, updatedAt: now() })));
    } catch (error) {
      // Store has no cross-repository transaction API; compensate within this serialized action.
      try { await restore(request, snapshot); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Matter action failed and snapshot restoration failed');
      }
      throw error;
    }
    bus.emit({ type: 'matter.updated', matter: saved });
    for (const email of snapshot.emails) bus.emit({ type: 'email.updated', emailId: email.id });
    return saved;
  };
  const settleUnsubscribeParent = async (child: ActionRecord) => {
    const parentId = await store.kv.get(`policy:unsubscribe-parent:${child.id}`);
    if (!parentId || !['executed', 'failed', 'rejected'].includes(child.status)) return;
    const parent = await store.actions.get(parentId);
    if (parent?.status !== 'executing' || parent.result?.childActionId !== child.id) return;
    const status = child.status;
    if (!await claim(parent, status)) return;
    const updated = await store.actions.update(parentId, {
      status, ...(status === 'executed' ? { executedAt: now() } : { error: child.error ?? 'Unsubscribe send was rejected' }),
      result: { ...parent.result, status: status === 'executed' ? 'sent' : status, ...(child.result?.warning ? { warning: child.result.warning } : {}) },
    });
    bus.emit({ type: status === 'executed' ? 'action.executed' : status === 'failed' ? 'action.failed' : 'action.decided', action: updated });
  };
  const dispatch = async (request: Request, snapshot: Snapshot | null, action: ActionRecord): Promise<Record<string, unknown>> => {
    const inverse = snapshotOf(request);
    if (inverse) return restore(request, inverse);
    switch (request.type) {
      case 'label': case 'unlabel': case 'archive': case 'unarchive': case 'mark_read': case 'mark_unread':
      case 'flag': case 'unflag': case 'move': case 'delete': {
        if (snapshot?.kind !== 'mail') throw new PolicyError('INVALID_INVERSE', 'Mail snapshot is required');
        return changeMail(request, snapshot);
      }
      case 'draft_create': case 'draft_update': {
        const provider = await mailProviderFor(request.accountId);
        const prior = request.type === 'draft_update' ? await emailFor(request.params.draftEmailId, request.accountId) : null;
        const email = prior ? await provider.updateDraft(prior.providerId, request.params.draft) : await provider.createDraft(request.params.draft);
        const saved = { ...email, id: prior?.id ?? email.id, accountId: request.accountId };
        if (snapshot?.kind === 'draft') snapshot.createdId = saved.id;
        await store.emails.upsertMany([saved]); bus.emit({ type: 'email.updated', emailId: saved.id }); return { emailId: saved.id, providerId: saved.providerId };
      }
      case 'draft_delete': {
        const email = await emailFor(request.params.draftEmailId, request.accountId);
        await (await mailProviderFor(request.accountId)).deleteDraft(email.providerId); await store.emails.deleteMany([email.id]); bus.emit({ type: 'email.updated', emailId: email.id }); return { emailId: email.id };
      }
      case 'send': case 'calendar_propose': {
        const prior = request.type === 'send' && request.params.draftEmailId ? await emailFor(request.params.draftEmailId, request.accountId) : null;
        if (prior && !prior.keywords.$draft) throw new PolicyError('NOT_A_DRAFT', 'Only draft emails can be sent');
        const draft = request.params.draft;
        if (!prior && !draft) throw new PolicyError('INVALID_PARAMS', 'Send requires a draft or draftEmailId');
        const provider = await mailProviderFor(request.accountId);
        // Submit the authorized content, so a draft edit racing the transport cannot change the send.
        const result = await provider.send({ draft: prior ? action.approvedSnapshot as DraftInput : draft! });
        try {
          if (prior) { await provider.deleteDraft(prior.providerId); await store.emails.deleteMany([prior.id]); bus.emit({ type: 'email.updated', emailId: prior.id }); }
          const sent = await provider.getEmail(result.providerId);
          if (sent) { await store.emails.upsertMany([{ ...sent, accountId: request.accountId }]); bus.emit({ type: 'email.updated', emailId: sent.id }); }
        } catch {
          return { ...result, warning: 'SUBMISSION_ACCEPTED: message submitted; sent-copy or draft cleanup failed' };
        }
        return { ...result };
      }
      case 'unsubscribe': {
        const { emailId, method } = request.params;
        const email = await emailFor(emailId, request.accountId);
        const { https, mailto, oneClick } = parseListUnsubscribe(email.headers.listUnsubscribe, email.headers.listUnsubscribePost);
        if ((method === 'header' && oneClick || method === 'link') && https) {
          return { method, ...await requestUnsubscribe(fetcher, https, method === 'header' ? 'POST' : 'GET', resolveDns) };
        }
        let draft: DraftInput;
        if (method === 'header' && mailto) {
          draft = { accountId: request.accountId, to: [{ email: mailto.address }], subject: mailto.subject, textBody: mailto.textBody };
        } else if (method === 'reply' && (email.replyTo.length || email.from.length)) {
          draft = {
            accountId: request.accountId, inReplyToEmailId: email.id,
            to: email.replyTo.length ? email.replyTo : email.from,
            subject: 'unsubscribe', textBody: 'unsubscribe',
          };
        } else {
          throw new PolicyError('UNSUBSCRIBE_UNSUPPORTED', `No supported unsubscribe target for method ${method}`);
        }
        const child = await submitAction({
          type: 'send', accountId: request.accountId, params: { draft }, actor: request.actor,
          category: 'unsubscribe', reason: `Unsubscribe email for action ${action.id}: ${request.reason}`,
          matterId: request.matterId, runId: request.runId, counterparty: request.counterparty,
        }, async child => {
          await store.actions.update(action.id, { result: { method, target: draft.to[0]!.email, status: 'pending', childActionId: child.id } });
          await store.kv.set(`policy:unsubscribe-parent:${child.id}`, action.id);
        });
        const latestChild = await store.actions.get(child.id) ?? child;
        await settleUnsubscribeParent(latestChild);
        return { method, target: draft.to[0]!.email, status: latestChild.status === 'executed' ? 'sent' : 'pending', childActionId: child.id };
      }
      case 'calendar_create': {
        const event = await (await calendarProviderFor(request.accountId)).createEvent(request.params.event);
        if (snapshot?.kind === 'event') snapshot.createdId = event.id;
        await store.events.upsertMany([event]); return { eventId: event.id, providerId: event.providerId };
      }
      case 'calendar_update': {
        const prior = await eventFor(request.params.eventId, request.accountId);
        const event = await (await calendarProviderFor(request.accountId)).updateEvent(prior.providerId, request.params.patch);
        await store.events.upsertMany([{ ...event, id: prior.id, accountId: prior.accountId }]); return { eventId: prior.id };
      }
      case 'calendar_respond': {
        const event = await eventFor(request.params.eventId, request.accountId);
        await (await calendarProviderFor(request.accountId)).respond(event.providerId, request.params.status, request.params.comment);
        await store.events.upsertMany([{ ...event, myStatus: request.params.status, updatedAt: now() }]); return { eventId: event.id };
      }
      case 'calendar_delete': {
        const event = await eventFor(request.params.eventId, request.accountId);
        await (await calendarProviderFor(request.accountId)).deleteEvent(event.providerId); await store.events.deleteMany([event.id]); return { eventId: event.id };
      }
      case 'matter_create': {
        if (snapshot?.kind !== 'matter') throw new PolicyError('INVALID_INVERSE', 'Matter snapshot is required');
        const at = now(), matter: Matter = { ...request.params.matter, id: snapshot.id, createdAt: at, updatedAt: at };
        const saved = await writeMatter(request, snapshot, matter); return { matterId: saved.id, matter: saved };
      }
      case 'matter_update': {
        const prior = await matterFor(request.params.matterId);
        const matter = { ...prior, ...request.params.patch, id: prior.id, createdAt: prior.createdAt, updatedAt: now() };
        await mirrorMatter(matter); return { matterId: matter.id };
      }
      case 'matter_attach': {
        if (snapshot?.kind !== 'matter') throw new PolicyError('INVALID_INVERSE', 'Matter snapshot is required');
        const prior = await matterFor(request.params.matterId);
        const unique = (a: string[], b: string[] = []) => [...new Set([...a, ...b])];
        const matter = { ...prior, emailIds: unique(prior.emailIds, request.params.emailIds), eventIds: unique(prior.eventIds, request.params.eventIds), personIds: unique(prior.personIds, request.params.personIds), updatedAt: now() };
        await writeMatter(request, snapshot, matter);
        return { matterId: matter.id };
      }
      case 'person_update': {
        if (snapshot?.kind !== 'person') throw new PolicyError('INVALID_INVERSE', 'Person snapshot is required');
        const prior = snapshot.person;
        if (!prior) {
          if (!isCompletePerson(request.params.patch)) throw new PolicyError('PERSON_NOT_FOUND', 'Creation requires a complete Person patch');
          await store.people.upsert(request.params.patch); return { personId: request.params.personId };
        }
        await store.people.upsert({ ...prior, ...request.params.patch, id: prior.id, createdAt: prior.createdAt, updatedAt: now() }); return { personId: prior.id };
      }
      case 'snooze': {
        if (request.params.matterId) { const matter = await matterFor(request.params.matterId); await mirrorMatter({ ...matter, status: 'snoozed', snoozedUntil: request.params.until, updatedAt: now() }); }
        for (const email of await allEmails(request.params.emailIds ?? [], request.accountId)) await store.kv.set(`policy:snooze:${email.id}`, request.params.until);
        return { until: request.params.until };
      }
    }
  };
  const execute = async (action: ActionRecord, undoOf?: ActionRecord): Promise<ActionRecord> => {
    let current = action;
    try {
      const request = action.request as Request;
      if (!undoOf && (request.type === 'send' || request.type === 'calendar_propose')) {
        let resolved: DraftInput | undefined;
        try { resolved = await resolvedDraft(request); } catch (error) {
          if (!(error instanceof PolicyError) || !['EMAIL_NOT_FOUND', 'NOT_A_DRAFT', 'REPLY_NOT_FOUND'].includes(error.code)) throw error;
        }
        if (!action.approvedSnapshot || !isDeepStrictEqual(resolved, action.approvedSnapshot)) {
          const proposed = await store.actions.update(action.id, {
            status: 'proposed', holdUntil: null, error: 'DRAFT_CHANGED_SINCE_APPROVAL',
            decision: { ...action.decision, outcome: 'ask', reason: 'DRAFT_CHANGED_SINCE_APPROVAL', holdUntil: null },
          });
          bus.emit({ type: 'action.proposed', action: proposed }); return proposed;
        }
      }
      const snapshot = snapshotOf(request) ? null : await capture(request);
      const inverseParams = snapshot ? { ...request.params, [marker]: snapshot } : null;
      const inverse: ActionRequest | null = undoOf ? undoOf.request : inverseParams ? { ...structuredClone(request), actor: { kind: 'human', id: 'undo' }, reason: `Undo: ${request.reason}`, params: inverseParams } : null;
      const reversibility = undoOf ? 'reversible' : BASE_REVERSIBILITY[request.type] === 'delayed' ? 'irreversible' : BASE_REVERSIBILITY[request.type];
      const decision = { ...action.decision, reversibility };
      if (decision.reversibility === 'reversible' && !inverse) throw new PolicyError('MISSING_INVERSE', 'Reversible actions must capture an inverse before execution');
      current = await store.actions.update(action.id, { status: 'executing', decision, inverse, holdUntil: null });
      const result = await dispatch(request, snapshot, action);
      if (request.type === 'unsubscribe' && result.childActionId) return (await store.actions.get(action.id))!;
      current = await store.actions.update(action.id, { status: 'executed', executedAt: now(), result, inverse });
      bus.emit({ type: 'action.executed', action: current });
      await settleUnsubscribeParent(current); return current;
    } catch (error) {
      // A post-execution notification/parent write must not turn a delivered send into a retryable failure.
      if (current.status === 'executed') throw error;
      if (['send', 'calendar_propose'].includes(action.request.type) && (error as { code?: string } | null)?.code === 'SUBMISSION_ACCEPTED') {
        current = await store.actions.update(action.id, {
          status: 'executed', executedAt: now(), holdUntil: null, inverse: null,
          decision: { ...action.decision, reversibility: 'irreversible' },
          result: { warning: error instanceof Error ? error.message : 'SUBMISSION_ACCEPTED', code: 'SUBMISSION_ACCEPTED', messageId: (error as { messageId?: string }).messageId ?? null },
        });
        bus.emit({ type: 'action.executed', action: current }); await settleUnsubscribeParent(current); return current;
      }
      current = await store.actions.update(action.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
      bus.emit({ type: 'action.failed', action: current }); await settleUnsubscribeParent(current); throw error;
    }
  };
  const holdOrExecute = async (action: ActionRecord): Promise<ActionRecord> => {
    if (action.request.type === 'send' || action.request.type === 'calendar_propose') {
      try {
        action = await store.actions.update(action.id, { approvedSnapshot: await resolvedDraft(action.request), error: null });
      } catch (error) {
        const failed = await store.actions.update(action.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
        bus.emit({ type: 'action.failed', action: failed }); await settleUnsubscribeParent(failed); throw error;
      }
    }
    const config = await policy.getConfig();
    if (BASE_REVERSIBILITY[action.request.type] === 'delayed' && config.outboxHoldMinutes > 0) {
      const holdUntil = new Date(Date.parse(now()) + config.outboxHoldMinutes * 60_000).toISOString();
      const held = await store.actions.update(action.id, { status: 'held', holdUntil }); bus.emit({ type: 'action.held', action: held }); return held;
    }
    return execute(action);
  };
  // Internal submission avoids re-entering this executor's queue for unsubscribe child sends.
  const submitAction = async (request: ActionRequest, onCreated?: (action: ActionRecord) => Promise<void>): Promise<ActionRecord> => {
    assertPublic(request);
    const decision = await policy.evaluate(request), at = now();
    const record = await store.actions.insert({ id: newId(at), request: structuredClone(request), decision, status: decision.outcome === 'deny' ? 'rejected' : decision.outcome === 'ask' ? 'proposed' : 'approved', createdAt: at, ...(decision.outcome !== 'ask' ? { decidedAt: at } : {}), ...(decision.outcome === 'deny' ? { error: decision.reason } : {}) });
    await onCreated?.(record);
    if (decision.outcome === 'ask') { bus.emit({ type: 'action.proposed', action: record }); return record; }
    bus.emit({ type: 'action.decided', action: record });
    if (decision.outcome === 'deny') return record;
    return holdOrExecute(record);
  };
  return {
    submit: request => serial(() => submitAction(request)),
    approve: (actionId, edited) => serial(async () => {
      const original = await requireAction(actionId, ['proposed']);
      let distance = 0;
      if (edited) {
        assertPublic(edited);
        if (edited.type !== original.request.type || edited.accountId !== original.request.accountId || edited.category !== original.request.category || edited.actor.kind !== original.request.actor.kind || edited.actor.id !== original.request.actor.id) throw new PolicyError('INVALID_EDIT', 'Approval edits must preserve action type, account, actor, and category');
        const text = (request: ActionRequest): string | null => {
          const draft = (request.params as { draft?: DraftInput }).draft;
          return draft ? `${draft.subject}\n${draft.textBody}` : null;
        };
        const left = text(original.request), right = text(edited);
        distance = left !== null && right !== null ? editDistanceRatio(left, right) : editDistanceRatio(original.request.params, edited.params);
      }
      const decision = await policy.evaluate(edited ?? original.request);
      if (decision.outcome === 'deny') throw new PolicyError('ACTION_DENIED', decision.reason);
      await requireClaim(original);
      // A changed held draft needs reapproval, but feedback is still counted once per record.
      if (!await store.kv.get(`policy:feedback:${actionId}`)) await policy.recordOutcome(actionId, edited ? 'approved_edited' : 'approved_unchanged', distance);
      const approved = await store.actions.update(actionId, { decision, decidedAt: now(), request: structuredClone(edited ?? original.request), editDistance: edited ? distance : null });
      bus.emit({ type: 'action.decided', action: approved }); return holdOrExecute(approved);
    }),
    reject: (actionId, reason) => serial(async () => {
      await requireClaim(await requireAction(actionId, ['proposed']));
      if (!await store.kv.get(`policy:feedback:${actionId}`)) await policy.recordOutcome(actionId, 'rejected');
      const rejected = await store.actions.update(actionId, { status: 'rejected', decidedAt: now(), ...(reason ? { error: reason } : {}) });
      bus.emit({ type: 'action.decided', action: rejected }); await settleUnsubscribeParent(rejected); return rejected;
    }),
    cancelHold: actionId => serial(async () => {
      await requireClaim(await requireAction(actionId, ['held']));
      const cancelled = await store.actions.update(actionId, { status: 'rejected', decidedAt: now(), holdUntil: null, error: 'Cancelled during outbox hold' });
      bus.emit({ type: 'action.decided', action: cancelled }); await settleUnsubscribeParent(cancelled); return cancelled;
    }),
    undo: actionId => serial(async () => {
      const original = await requireAction(actionId, ['executed']);
      if (!original.inverse) throw new PolicyError('IRREVERSIBLE_ACTION', 'This action has no inverse');
      await requireClaim(original);
      const at = now();
      const inverse = await store.actions.insert({ id: newId(at), request: structuredClone(original.inverse), decision: { ...original.decision, outcome: 'allow', reversibility: 'reversible', reason: `Human requested undo of ${actionId}` }, status: 'approved', createdAt: at, decidedAt: at });
      bus.emit({ type: 'action.decided', action: inverse });
      try { await execute(inverse, original); } catch (error) {
        await store.actions.update(actionId, { status: 'executed' }); throw error;
      }
      const undone = await store.actions.update(actionId, { status: 'undone', undoneAt: now() });
      bus.emit({ type: 'action.undone', action: undone }); return undone;
    }),
    releaseDue: (at = now()) => serial(async () => {
      if (!Number.isFinite(Date.parse(at))) throw new PolicyError('INVALID_TIME', 'Release time must be an ISO timestamp');
      const executed: ActionRecord[] = [];
      let firstError: unknown;
      for (const candidate of await store.actions.dueHeld(at)) {
        const current = await store.actions.get(candidate.id);
        if (current?.status !== 'held' || !current.holdUntil || current.holdUntil > at) continue;
        try {
          const claimed = await claim(current);
          if (claimed) {
            const result = await execute(claimed);
            if (result.status === 'executed') executed.push(result);
          }
        } catch (error) { firstError ??= error; }
      }
      if (firstError) throw firstError;
      return executed;
    }),
  };
}
