import { describe, expect, it } from 'vitest';
import { calendarEvent, draft, email, matter, person, request, setup, trustState } from './testing/fixtures.js';

describe('mail action lifecycle', () => {
  it('allows archive, logs before mutation, and restores exact mailboxIds on undo', async () => {
    const { executor, store, mail, bus } = await setup();
    const initial = await store.emails.get('email');
    const record = await executor.submit(request('archive', { emailIds: ['email'] }));
    expect(record.status).toBe('executed'); expect(record.inverse).not.toBeNull();
    expect((await store.emails.get('email'))?.mailboxIds).toEqual(['tag', 'archive']);
    expect(mail.changes[0]).toEqual([
      { op: 'addToMailbox', providerIds: ['remote-email'], mailboxProviderId: 'remote-archive' },
      { op: 'removeFromMailbox', providerIds: ['remote-email'], mailboxProviderId: 'remote-inbox' },
    ]);
    expect((await executor.undo(record.id)).status).toBe('undone');
    expect((await store.emails.get('email'))?.mailboxIds).toEqual(initial?.mailboxIds);
    const log = await store.actions.query({});
    expect(log.items).toHaveLength(2);
    expect(log.items.find(item => item.id !== record.id)).toMatchObject({ status: 'executed', inverse: expect.any(Object) });
    expect(bus.events.filter(event => event.type.startsWith('action.')).map(event => event.type)).toEqual(['action.decided', 'action.executed', 'action.decided', 'action.executed', 'action.undone']);
    await expect(executor.undo(record.id)).rejects.toMatchObject({ code: 'INVALID_ACTION_STATE' });
  });

  it.each(['label', 'unlabel', 'unarchive', 'mark_read', 'mark_unread', 'flag', 'unflag', 'move', 'delete'] as const)('dispatches %s and restores keywords/mailboxes', async type => {
    const { executor, store } = await setup();
    await store.emails.upsertMany([email({ keywords: { $seen: true, $flagged: true, custom: true } })]);
    const before = await store.emails.get('email');
    const params = type === 'label' || type === 'unlabel' ? { emailIds: ['email'], label: 'tag' } : type === 'move' ? { emailIds: ['email'], toMailboxId: 'trash' } : { emailIds: ['email'] };
    const action = await executor.submit(request(type, params));
    expect(action.status).toBe('executed'); await executor.undo(action.id);
    expect(await store.emails.get('email')).toMatchObject({ keywords: before!.keywords, mailboxIds: before!.mailboxIds });
  });

  it('captures prior state at execution after approval, rather than at proposal', async () => {
    const { executor, policy, store } = await setup();
    await policy.pinLevel('other', 'supervised');
    const proposed = await executor.submit(request('archive', { emailIds: ['email'] }));
    await store.emails.patchMany(['email'], { mailboxIds: ['inbox', 'sent'] });
    await executor.approve(proposed.id); await executor.undo(proposed.id);
    expect((await store.emails.get('email'))?.mailboxIds).toEqual(['inbox', 'sent']);
  });

  it('moves delete to trash rather than purging and permits undo', async () => {
    const { executor, mail, store } = await setup();
    const record = await executor.submit(request('delete', { emailIds: ['email'] }));
    expect(mail.changes[0]).toEqual([{ op: 'move', providerIds: ['remote-email'], toMailboxProviderId: 'remote-trash' }]);
    expect((await store.emails.get('email'))?.mailboxIds).toEqual(['trash']);
    await executor.undo(record.id); expect((await store.emails.get('email'))?.mailboxIds).toEqual(['inbox', 'tag']);
  });

  it('denies external-agent delete without touching provider or mail state', async () => {
    const { executor, mail, store } = await setup();
    const before = await store.emails.get('email');
    const denied = await executor.submit(request('delete', { emailIds: ['email'] }, { actor: { kind: 'external-agent', id: 'mcp' } }));
    expect(denied).toMatchObject({ status: 'rejected', decision: { outcome: 'deny' }, error: expect.stringContaining('external agent') });
    expect(mail.changes).toEqual([]); expect(await store.emails.get('email')).toEqual(before);
    await expect(executor.approve(denied.id)).rejects.toMatchObject({ code: 'INVALID_ACTION_STATE' });
  });

  it('persists provider failures, emits action.failed, and rethrows the original error', async () => {
    const { executor, store, mail, bus } = await setup();
    const failure = Object.assign(new Error('Provider failed'), { code: 'REMOTE_FAILURE' }); mail.failure = failure;
    await expect(executor.submit(request('archive', { emailIds: ['email'] }))).rejects.toBe(failure);
    const records = await store.actions.query({ status: ['failed'] });
    expect(records.items[0]).toMatchObject({ error: 'Provider failed', inverse: expect.any(Object) });
    expect((await store.emails.get('email'))?.mailboxIds).toEqual(['inbox', 'tag']);
    expect(bus.events.at(-1)?.type).toBe('action.failed');
  });
});

describe('delayed outbox', () => {
  it('holds send and permits cancellation without sending', async () => {
    const { executor, mail, store, bus } = await setup();
    const held = await executor.submit(request('send', { draft }));
    expect(held).toMatchObject({ status: 'held', holdUntil: '2026-10-20T12:05:00.000Z' }); expect(mail.sends).toEqual([]);
    const cancelled = await executor.cancelHold(held.id);
    expect(cancelled).toMatchObject({ status: 'rejected', holdUntil: null });
    expect(await executor.releaseDue('2026-10-21T12:00:00.000Z')).toEqual([]); expect(mail.sends).toEqual([]);
    expect((await store.actions.get(held.id))?.error).toContain('Cancelled');
    expect(bus.events.some(event => event.type === 'action.held')).toBe(true);
    await expect(executor.cancelHold(held.id)).rejects.toMatchObject({ code: 'INVALID_ACTION_STATE' });
  });

  it('releases a due send once, marks it irreversible, and rejects undo', async () => {
    const { executor, mail, store, bus } = await setup();
    const held = await executor.submit(request('send', { draft }));
    expect(await executor.releaseDue('2026-10-20T12:04:59.000Z')).toEqual([]);
    mail.sentEmail = email({ id: 'sent', providerId: 'sent-1', mailboxIds: ['sent'] });
    const [executed] = await executor.releaseDue(held.holdUntil!);
    expect(executed).toMatchObject({ status: 'executed', inverse: null, holdUntil: null, decision: { reversibility: 'irreversible' } });
    expect(mail.sends).toEqual([{ draft }]); expect(await store.emails.get('sent')).not.toBeNull();
    expect(await executor.releaseDue('2026-10-21T12:00:00.000Z')).toEqual([]); expect(mail.sends).toHaveLength(1);
    await expect(executor.undo(held.id)).rejects.toMatchObject({ code: 'IRREVERSIBLE_ACTION' });
    expect(bus.events.at(-1)?.type).toBe('action.executed');
  });

  it('holds approved sends even if a human explicitly approved them', async () => {
    const { executor, policy, mail, store } = await setup();
    await policy.pinLevel('other', 'supervised');
    const proposed = await executor.submit(request('send', { draft }));
    expect(proposed.status).toBe('proposed');
    expect((await executor.approve(proposed.id)).status).toBe('held'); expect(mail.sends).toEqual([]);
    expect((await store.trust.get('other'))?.approvals).toBe(16);
  });

  it('executes a permitted send with a disabled outbox and preserves the inverse invariant', async () => {
    const { executor, policy, mail } = await setup(); await policy.setConfig({ outboxHoldMinutes: 0 });
    expect(await executor.submit(request('send', { draft }))).toMatchObject({ status: 'executed', inverse: null, decision: { reversibility: 'irreversible' } });
    expect(mail.sends).toHaveLength(1);
  });

  it('resolves a saved draft by provider id and removes the stale draft after sending', async () => {
    const { executor, store, mail } = await setup();
    await store.emails.upsertMany([email({ id: 'draft', providerId: 'remote-draft', keywords: { $draft: true } })]);
    const held = await executor.submit(request('send', { draftEmailId: 'draft' }));
    await executor.releaseDue(held.holdUntil!);
    expect(mail.sends).toEqual([{ draftProviderId: 'remote-draft' }]);
    expect(await store.emails.get('draft')).toBeNull();
  });

  it('serializes duplicate release calls and cancellation against release', async () => {
    const { executor, mail } = await setup();
    const first = await executor.submit(request('send', { draft }));
    const releases = await Promise.all([executor.releaseDue(first.holdUntil!), executor.releaseDue(first.holdUntil!)]);
    expect(releases.flat()).toHaveLength(1); expect(mail.sends).toHaveLength(1);
    const second = await executor.submit(request('send', { draft }));
    const [cancelled, due] = await Promise.all([executor.cancelHold(second.id), executor.releaseDue(second.holdUntil!)]);
    expect(cancelled.status).toBe('rejected'); expect(due).toEqual([]); expect(mail.sends).toHaveLength(1);
  });

  it('continues releasing later due actions after a failure, then rethrows', async () => {
    const { executor, store, mail } = await setup();
    const invalid = await executor.submit(request('send', {}));
    const valid = await executor.submit(request('send', { draft }));
    await expect(executor.releaseDue(valid.holdUntil!)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect((await store.actions.get(invalid.id))?.status).toBe('failed');
    expect((await store.actions.get(valid.id))?.status).toBe('executed'); expect(mail.sends).toHaveLength(1);
  });
});

describe('human decisions and drafts', () => {
  it('approves an edited proposal, lowers trust by text distance, and logs all events', async () => {
    const { executor, store, policy, mail, bus } = await setup();
    await store.trust.upsert(trustState({ score: 0.7, pinnedLevel: 'supervised' }));
    const proposed = await executor.submit(request('draft_create', { draft }));
    expect(bus.events.at(-1)?.type).toBe('action.proposed');
    const edited = { ...proposed.request, params: { draft: { ...draft, subject: 'New subject', textBody: 'A completely different answer.' } } };
    const executed = await executor.approve(proposed.id, edited);
    expect(executed.status).toBe('executed'); expect(executed.editDistance).toBeGreaterThan(0.25);
    expect((await policy.getTrustFor('other')).score).toBeCloseTo(0.7 - 0.04 * executed.editDistance!);
    expect(mail.drafts[0]?.draft).toEqual(edited.params.draft);
    await expect(executor.approve(proposed.id)).rejects.toMatchObject({ code: 'INVALID_ACTION_STATE' });
    await executor.undo(proposed.id); expect(await store.emails.get(executed.result!.emailId as string)).toBeNull();
  });

  it('restores updated and deleted drafts, preserving local identity', async () => {
    const { executor, store, mail } = await setup();
    const original = email({ id: 'draft', providerId: 'remote-draft', keywords: { $draft: true }, textBody: 'Original' });
    await store.emails.upsertMany([original]);
    const updated = await executor.submit(request('draft_update', { draftEmailId: 'draft', draft: { ...draft, textBody: 'Updated' } }));
    expect((await store.emails.get('draft'))?.textBody).toBe('Updated');
    await executor.undo(updated.id); expect((await store.emails.get('draft'))?.textBody).toBe('Original');
    const deleted = await executor.submit(request('draft_delete', { draftEmailId: 'draft' })); expect(await store.emails.get('draft')).toBeNull();
    await executor.undo(deleted.id); expect(await store.emails.get('draft')).toMatchObject({ id: 'draft', textBody: 'Original', providerId: expect.stringContaining('remote-draft-') });
    expect(mail.drafts.map(call => call.operation)).toEqual(['update', 'update', 'delete', 'create']);
  });

  it('rejects proposals with trust feedback and a decided event', async () => {
    const { executor, policy, bus } = await setup(); await policy.pinLevel('other', 'supervised');
    const proposed = await executor.submit(request('archive', { emailIds: ['email'] }));
    expect(await executor.reject(proposed.id, 'Keep this')).toMatchObject({ status: 'rejected', error: 'Keep this' });
    expect((await policy.getTrustFor('other')).score).toBeCloseTo(0.8); expect(bus.events.at(-1)?.type).toBe('action.decided');
    await expect(executor.reject(proposed.id)).rejects.toMatchObject({ code: 'INVALID_ACTION_STATE' });
  });

  it('rejects edits that replace the action type or actor', async () => {
    const { executor, policy } = await setup(); await policy.pinLevel('other', 'supervised');
    const proposed = await executor.submit(request('archive', { emailIds: ['email'] }));
    await expect(executor.approve(proposed.id, request('delete', { emailIds: ['email'] }))).rejects.toMatchObject({ code: 'INVALID_EDIT' });
    await expect(executor.approve(proposed.id, { ...proposed.request, actor: { kind: 'human', id: 'user' } })).rejects.toMatchObject({ code: 'INVALID_EDIT' });
  });

  it('rechecks the external ceiling before approving a previously proposed action', async () => {
    const { executor, policy, mail } = await setup();
    await policy.setConfig({ externalAgentCeiling: 'auto_accept_edits' });
    const proposed = await executor.submit(request('send', { draft }, { actor: { kind: 'external-agent', id: 'mcp' } }));
    expect(proposed.status).toBe('proposed');
    await policy.setConfig({ externalAgentCeiling: 'supervised' });
    await expect(executor.approve(proposed.id)).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    expect(mail.sends).toEqual([]);
  });
});

describe('calendar dispatch', () => {
  it('creates and undoes an event through CalendarProvider', async () => {
    const { executor, store, calendar } = await setup();
    const { id: _id, providerId: _providerId, updatedAt: _updatedAt, ...event } = calendarEvent();
    const created = await executor.submit(request('calendar_create', { event }));
    expect((await store.events.get('event'))?.title).toBe('Lunch');
    await executor.undo(created.id); expect(await store.events.get('event')).toBeNull();
    expect(calendar.calls.map(call => call.operation)).toEqual(['create', 'delete']);
  });

  it('updates and restores an event, and mirrors respond/delete after provider success', async () => {
    const { executor, store, calendar } = await setup(); await store.events.upsertMany([calendarEvent()]);
    const updated = await executor.submit(request('calendar_update', { eventId: 'event', patch: { title: 'Dinner' } }));
    expect((await store.events.get('event'))?.title).toBe('Dinner'); await executor.undo(updated.id);
    expect((await store.events.get('event'))?.title).toBe('Lunch');
    const response = await executor.submit(request('calendar_respond', { eventId: 'event', status: 'accepted' }));
    expect(response.inverse).toBeNull(); expect((await store.events.get('event'))?.myStatus).toBe('accepted');
    const deleted = await executor.submit(request('calendar_delete', { eventId: 'event' }));
    expect(deleted.status).toBe('executed'); expect(deleted.inverse).toBeNull(); expect(await store.events.get('event')).toBeNull();
    expect(calendar.calls.map(call => call.operation)).toEqual(['update', 'update', 'respond', 'delete']);
  });

  it('holds a calendar proposal and sends its draft only after release', async () => {
    const { executor, mail } = await setup();
    const held = await executor.submit(request('calendar_propose', { draft, slots: [] })); expect(held.status).toBe('held');
    await executor.releaseDue(held.holdUntil!); expect(mail.sends).toEqual([{ draft }]);
  });
});

describe('internal store actions', () => {
  it('creates a matter and deletes it on undo, with a separate undo ActionRecord', async () => {
    const { executor, store } = await setup();
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = matter();
    const created = await executor.submit(request('matter_create', { matter: input }, { category: 'matters' }));
    const id = created.result!.matterId as string;
    expect(await store.matters.get(id)).toMatchObject({ title: 'Trip' }); await executor.undo(created.id); expect(await store.matters.get(id)).toBeNull();
    expect((await store.actions.query({})).total).toBe(2);
  });

  it('restores previous matter patches and attachment backlinks', async () => {
    const { executor, store, bus } = await setup();
    await store.matters.upsert(matter()); await store.events.upsertMany([calendarEvent()]); await store.people.upsert(person());
    const updated = await executor.submit(request('matter_update', { matterId: 'matter', patch: { summary: 'A plan', nextStep: 'Book' } }));
    expect((await store.matters.get('matter'))?.summary).toBe('A plan'); await executor.undo(updated.id); expect((await store.matters.get('matter'))?.nextStep).toBeUndefined();
    const attached = await executor.submit(request('matter_attach', { matterId: 'matter', emailIds: ['email'], eventIds: ['event'], personIds: ['person'] }));
    expect((await store.matters.get('matter'))?.emailIds).toEqual(['email']); expect((await store.emails.get('email'))?.matterId).toBe('matter'); expect((await store.events.get('event'))?.matterId).toBe('matter');
    await executor.undo(attached.id);
    expect((await store.matters.get('matter'))?.emailIds).toEqual([]); expect((await store.emails.get('email'))?.matterId).toBeNull(); expect((await store.events.get('event'))?.matterId).toBeUndefined();
    expect(bus.events.some(event => event.type === 'matter.updated')).toBe(true);
  });

  it('updates people and snoozes emails/matters without resolving providers, then restores them', async () => {
    const { executor, store, mail, calendar } = await setup(); await store.people.upsert(person()); await store.matters.upsert(matter());
    const updated = await executor.submit(request('person_update', { personId: 'person', patch: { notes: 'Colleague' } }));
    expect((await store.people.get('person'))?.notes).toBe('Colleague'); await executor.undo(updated.id); expect((await store.people.get('person'))?.notes).toBeUndefined();
    await store.kv.set('policy:snooze:email', '2026-10-21T12:00:00.000Z');
    const snoozed = await executor.submit(request('snooze', { emailIds: ['email'], matterId: 'matter', until: '2026-10-22T12:00:00.000Z' }));
    expect((await store.matters.get('matter'))?.status).toBe('snoozed'); expect(await store.kv.get('policy:snooze:email')).toBe('2026-10-22T12:00:00.000Z');
    await executor.undo(snoozed.id); expect((await store.matters.get('matter'))?.status).toBe('active'); expect(await store.kv.get('policy:snooze:email')).toBe('2026-10-21T12:00:00.000Z');
    expect(mail.changes).toEqual([]); expect(calendar.calls).toEqual([]);
  });

  it('keeps attachment inverses correct through JSON persistence', async () => {
    const { executor, store } = await setup(); await store.matters.upsert(matter());
    const attached = await executor.submit(request('matter_attach', { matterId: 'matter', emailIds: ['email'] }));
    await store.actions.update(attached.id, { inverse: JSON.parse(JSON.stringify(attached.inverse)) });
    await executor.undo(attached.id);
    expect((await store.emails.get('email'))?.matterId).toBeNull();
    expect((await store.matters.get('matter'))?.emailIds).toEqual([]);
  });
});

describe('gate invariants and explicit unsupported operations', () => {
  it('records an ActionRecord before a provider is called and never executes reversible actions without an inverse', async () => {
    const { executor, store, mail } = await setup();
    const original = mail.applyChanges.bind(mail);
    mail.applyChanges = async changes => {
      const executing = (await store.actions.query({ status: ['executing'] })).items;
      expect(executing).toHaveLength(1); expect(executing[0]?.inverse).not.toBeNull(); await original(changes);
    };
    await executor.submit(request('archive', { emailIds: ['email'] }));
    for (const record of (await store.actions.query({ status: ['executed'] })).items) expect(record.inverse !== null || record.decision.reversibility === 'irreversible').toBe(true);
  });

  it('rejects private inverse payloads, cross-account operations, and forged verification', async () => {
    const { executor, store, mail } = await setup();
    const forged = request('archive', { emailIds: ['email'], __passportPolicyInverse: {} } as unknown as { emailIds: string[] });
    await expect(executor.submit(forged)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await store.emails.upsertMany([email({ id: 'other', accountId: 'other-account' })]);
    await expect(executor.submit(request('archive', { emailIds: ['other'] }))).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
    await expect(executor.submit(request('person_update', { personId: 'person', patch: { verification: 'blue' } }))).rejects.toMatchObject({ code: 'PROTECTED_IDENTITY' });
    expect(mail.changes).toEqual([]);
  });

  it('fails unsubscribe explicitly with a persisted error instead of reporting success', async () => {
    const { executor, store, bus } = await setup();
    await expect(executor.submit(request('unsubscribe', { emailId: 'email', method: 'header' }))).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect((await store.actions.query({ status: ['failed'] })).items[0]?.error).toContain('no unsubscribe operation');
    expect(bus.events.at(-1)?.type).toBe('action.failed');
  });

  it('emits every action event defined by the contract across success, hold, proposal, failure, and undo', async () => {
    const { executor, policy, bus, mail } = await setup();
    const archived = await executor.submit(request('archive', { emailIds: ['email'] })); await executor.undo(archived.id);
    await executor.submit(request('send', { draft }));
    mail.failure = new Error('Failure'); await expect(executor.submit(request('archive', { emailIds: ['email'] }))).rejects.toThrow('Failure');
    await policy.pinLevel('other', 'supervised'); await executor.submit(request('archive', { emailIds: ['email'] }));
    const types = new Set(bus.events.filter(event => event.type.startsWith('action.')).map(event => event.type));
    expect([...types].sort()).toEqual(['action.decided', 'action.executed', 'action.failed', 'action.held', 'action.proposed', 'action.undone']);
  });
});
