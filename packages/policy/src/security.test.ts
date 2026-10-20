import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from './executor.js';
import { createPolicyEngine } from './policy.js';
import { draft, email, request, setup } from './testing/fixtures.js';

const secondExecutor = (env: Awaited<ReturnType<typeof setup>>) => createActionExecutor({
  store: env.store, bus: env.bus, policy: createPolicyEngine({ store: env.store, bus: env.bus, now: env.now }),
  now: env.now, mailProviderFor: () => env.mail, calendarProviderFor: () => env.calendar,
});

describe('atomic action ownership', () => {
  it('F2 releases a held send once across two independent executors', async () => {
    const env = await setup(), other = secondExecutor(env);
    const held = await env.executor.submit(request('send', { draft }));
    const released = await Promise.all([env.executor.releaseDue(held.holdUntil!), other.releaseDue(held.holdUntil!)]);
    expect(released.flat()).toHaveLength(1);
    expect(env.mail.sends).toHaveLength(1);
    expect((await env.store.actions.get(held.id))?.status).toBe('executed');
  });

  it('F2 only one executor can approve and dispatch a proposed action', async () => {
    const env = await setup(), other = secondExecutor(env);
    await env.policy.pinLevel('other', 'supervised');
    const proposed = await env.executor.submit(request('archive', { emailIds: ['email'] }));
    const results = await Promise.allSettled([env.executor.approve(proposed.id), other.approve(proposed.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(env.mail.changes).toHaveLength(1);
    expect((await env.store.trust.get('other'))?.approvals).toBe(16);
  });

  it('F2 cancellation and release compete for the same held claim', async () => {
    const env = await setup(), other = secondExecutor(env);
    const held = await env.executor.submit(request('send', { draft }));
    await Promise.allSettled([env.executor.cancelHold(held.id), other.releaseDue(held.holdUntil!)]);
    const record = (await env.store.actions.get(held.id))!;
    expect(['executed', 'rejected']).toContain(record.status);
    expect(env.mail.sends).toHaveLength(record.status === 'executed' ? 1 : 0);
  });

  it('F2 only one executor dispatches an undo', async () => {
    const env = await setup(), other = secondExecutor(env);
    const executed = await env.executor.submit(request('archive', { emailIds: ['email'] }));
    const results = await Promise.allSettled([env.executor.undo(executed.id), other.undo(executed.id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(env.mail.changes).toHaveLength(2);
    expect((await env.store.actions.query({})).items).toHaveLength(2);
  });

  it('F2 fails closed when a legacy store cannot atomically claim a held action', async () => {
    const env = await setup();
    const held = await env.executor.submit(request('send', { draft }));
    delete env.store.actions.claim;
    await expect(env.executor.releaseDue(held.holdUntil!)).rejects.toMatchObject({ code: 'ACTION_CLAIM_UNSUPPORTED' });
    expect(env.mail.sends).toHaveLength(0);
    expect((await env.store.actions.get(held.id))?.status).toBe('held');
  });
});

describe('draft approval snapshots', () => {
  it('F3 snapshots approval content and requires reapproval after a held draft is updated', async () => {
    const { executor, store, policy, mail, bus } = await setup();
    const original = email({ id: 'draft', keywords: { $draft: true }, to: draft.to, cc: [{ email: 'cc@example.com' }], bcc: [{ email: 'bcc@example.com' }], htmlBody: '<p>Original</p>', attachments: [{ id: 'attachment', name: 'file', type: 'text/plain', size: 1, blobId: 'blob-original' }] });
    await store.emails.upsertMany([original]);
    const held = await executor.submit(request('send', { draftEmailId: 'draft' }));
    expect(held.approvedSnapshot).toMatchObject({ to: original.to, cc: original.cc, bcc: original.bcc, subject: original.subject, textBody: original.textBody, htmlBody: original.htmlBody, attachments: [{ blobId: 'blob-original' }] });
    expect(held.request.params).toEqual({ draftEmailId: 'draft' });
    const replacement = { ...draft, to: [{ email: 'replacement@example.com' }], textBody: 'Replacement' };
    const update = request('draft_update', { draftEmailId: 'draft', draft: replacement });
    expect((await policy.evaluate(update)).outcome).toBe('ask');
    const proposedUpdate = await executor.submit(update);
    await executor.approve(proposedUpdate.id);
    expect(await executor.releaseDue(held.holdUntil!)).toEqual([]);
    const changed = (await store.actions.get(held.id))!;
    expect(changed).toMatchObject({ status: 'proposed', error: 'DRAFT_CHANGED_SINCE_APPROVAL', decision: { outcome: 'ask', reason: 'DRAFT_CHANGED_SINCE_APPROVAL' }, approvedSnapshot: held.approvedSnapshot });
    expect(bus.events.at(-1)?.type).toBe('action.proposed');
    expect(mail.sends).toHaveLength(0);
    const approved = await executor.approve(held.id);
    expect(approved.status).toBe('held');
    await executor.releaseDue(approved.holdUntil!);
    expect(mail.sends).toEqual([{ draft: expect.objectContaining({ to: replacement.to, textBody: replacement.textBody }) }]);
  });

  it('F3 asks before deleting a held draft and does not send a missing approved draft', async () => {
    const { executor, store, policy, mail } = await setup();
    await store.emails.upsertMany([email({ id: 'draft', keywords: { $draft: true } })]);
    const held = await executor.submit(request('send', { draftEmailId: 'draft' }));
    expect((await policy.evaluate(request('draft_delete', { draftEmailId: 'draft' }))).outcome).toBe('ask');
    await store.emails.deleteMany(['draft']);
    await executor.releaseDue(held.holdUntil!);
    expect(await store.actions.get(held.id)).toMatchObject({ status: 'proposed', error: 'DRAFT_CHANGED_SINCE_APPROVAL' });
    expect(mail.sends).toHaveLength(0);
  });

  it('F3 snapshots at human approval and sends the snapshot if a draft edit races provider dispatch', async () => {
    const env = await setup();
    await env.policy.pinLevel('other', 'supervised');
    await env.store.emails.upsertMany([email({ id: 'draft', keywords: { $draft: true } })]);
    const proposed = await env.executor.submit(request('send', { draftEmailId: 'draft' }));
    expect(proposed.approvedSnapshot).toBeUndefined();
    await env.store.emails.upsertMany([email({ id: 'draft', keywords: { $draft: true }, textBody: 'Approved revision' })]);
    const held = await env.executor.approve(proposed.id);
    const send = env.mail.send.bind(env.mail);
    vi.spyOn(env.mail, 'send').mockImplementation(async input => {
      await env.store.emails.upsertMany([email({ id: 'draft', keywords: { $draft: true }, textBody: 'Racing replacement' })]);
      return send(input);
    });
    await env.executor.releaseDue(held.holdUntil!);
    expect(env.mail.sends[0]?.draft?.textBody).toBe('Approved revision');
  });

  it('F3 requires approval again when releasing a legacy held record without a snapshot', async () => {
    const { executor, store, mail } = await setup();
    const held = await executor.submit(request('send', { draft }));
    await store.actions.update(held.id, { approvedSnapshot: null });
    await executor.releaseDue(held.holdUntil!);
    expect(await store.actions.get(held.id)).toMatchObject({ status: 'proposed', error: 'DRAFT_CHANGED_SINCE_APPROVAL' });
    expect(mail.sends).toHaveLength(0);
  });

  it('F3 preserves saved reply threading when submitting frozen draft content', async () => {
    const { executor, store, mail } = await setup();
    await store.emails.upsertMany([
      email({ headers: { ...email().headers, messageId: '<source@example.com>' } }),
      email({ id: 'draft', keywords: { $draft: true }, headers: { ...email().headers, inReplyTo: '<source@example.com>' } }),
    ]);
    const held = await executor.submit(request('send', { draftEmailId: 'draft' }));
    expect(held.approvedSnapshot).toMatchObject({ inReplyToEmailId: 'email' });
    await executor.releaseDue(held.holdUntil!);
    expect(mail.sends[0]?.draft?.inReplyToEmailId).toBe('email');
  });
});

describe('unsubscribe outbox integration', () => {
  it.each(['header', 'reply'] as const)('F4 routes %s mail through a child send and completes the parent after release', async method => {
    const env = await setup();
    await env.policy.pinLevel('unsubscribe', 'full_access');
    await env.store.emails.upsertMany([email({ headers: { ...email().headers, listUnsubscribe: '<mailto:leave@example.com>' } })]);
    const parent = await env.executor.submit(request('unsubscribe', { emailId: 'email', method }));
    expect(parent.status).toBe('executing');
    const child = (await env.store.actions.get(parent.result!.childActionId as string))!;
    expect(child).toMatchObject({ status: 'held', request: { type: 'send', category: 'unsubscribe', actor: parent.request.actor, reason: expect.stringContaining(parent.id) } });
    expect(env.mail.sends).toHaveLength(0);
    await secondExecutor(env).releaseDue(child.holdUntil!);
    expect(env.mail.sends).toHaveLength(1);
    expect(await env.store.actions.get(parent.id)).toMatchObject({ status: 'executed', result: { childActionId: child.id, status: 'sent' } });
  });

  it('F4 keeps child policy approval and cancellation in the normal send lifecycle', async () => {
    const env = await setup();
    const parent = await env.executor.submit(request('unsubscribe', { emailId: 'email', method: 'reply' }));
    const childId = parent.result!.childActionId as string;
    expect((await env.store.actions.get(childId))?.status).toBe('proposed');
    const held = await env.executor.approve(childId);
    expect(held.status).toBe('held');
    await env.executor.cancelHold(childId);
    expect(await env.store.actions.get(parent.id)).toMatchObject({ status: 'rejected', result: { childActionId: childId, status: 'rejected' } });
    await env.executor.releaseDue(held.holdUntil!);
    expect(env.mail.sends).toHaveLength(0);
  });

  it('F4 completes the parent if another executor approves the child while its link is being persisted', async () => {
    const env = await setup(), other = secondExecutor(env);
    await env.policy.setConfig({ outboxHoldMinutes: 0 });
    const set = env.store.kv.set.bind(env.store.kv);
    vi.spyOn(env.store.kv, 'set').mockImplementation(async (key, value) => {
      const prefix = 'policy:unsubscribe-parent:';
      if (key.startsWith(prefix)) await other.approve(key.slice(prefix.length));
      await set(key, value);
    });
    const parent = await env.executor.submit(request('unsubscribe', { emailId: 'email', method: 'reply' }));
    expect(parent).toMatchObject({ status: 'executed', result: { status: 'sent', childActionId: expect.any(String) } });
    expect(env.mail.sends).toHaveLength(1);
    expect(env.bus.events.filter(event => event.type === 'action.executed' && event.action.id === parent.id)).toHaveLength(1);
  });

  it('F4 reports child send failure on the parent and never releases it again', async () => {
    const env = await setup();
    await env.policy.pinLevel('unsubscribe', 'full_access');
    const parent = await env.executor.submit(request('unsubscribe', { emailId: 'email', method: 'reply' }));
    const child = (await env.store.actions.get(parent.result!.childActionId as string))!;
    env.mail.failure = new Error('SMTP failed');
    await expect(env.executor.releaseDue(child.holdUntil!)).rejects.toThrow('SMTP failed');
    expect((await env.store.actions.get(parent.id))?.status).toBe('failed');
    await env.executor.releaseDue(child.holdUntil!);
    expect(env.mail.sends).toHaveLength(1);
  });
});

describe('accepted SMTP submissions', () => {
  it.each([0, 5])('F7 treats SUBMISSION_ACCEPTED as executed with a warning (hold %s)', async minutes => {
    const { executor, policy, store, mail, bus } = await setup();
    await policy.setConfig({ outboxHoldMinutes: minutes });
    mail.failure = Object.assign(new Error('Message accepted; sent-copy cleanup failed'), { code: 'SUBMISSION_ACCEPTED', messageId: '<accepted@example.com>' });
    const submitted = await executor.submit(request('send', { draft }));
    const executed = minutes ? (await executor.releaseDue(submitted.holdUntil!))[0]! : submitted;
    expect(executed).toMatchObject({ status: 'executed', inverse: null, decision: { reversibility: 'irreversible' }, result: { warning: expect.stringContaining('accepted'), code: 'SUBMISSION_ACCEPTED', messageId: '<accepted@example.com>' } });
    expect((await store.actions.get(executed.id))?.status).toBe('executed');
    expect(bus.events.some(event => event.type === 'action.failed')).toBe(false);
    await executor.releaseDue('2099-01-01T00:00:00.000Z');
    expect(mail.sends).toHaveLength(1);
    await expect(executor.approve(executed.id)).rejects.toMatchObject({ code: 'INVALID_ACTION_STATE' });
  });

  it('F7 propagates accepted submission warnings to an unsubscribe parent', async () => {
    const env = await setup();
    await env.policy.pinLevel('unsubscribe', 'full_access');
    const parent = await env.executor.submit(request('unsubscribe', { emailId: 'email', method: 'reply' }));
    const child = (await env.store.actions.get(parent.result!.childActionId as string))!;
    env.mail.failure = Object.assign(new Error('accepted; cleanup failed'), { code: 'SUBMISSION_ACCEPTED' });
    await env.executor.releaseDue(child.holdUntil!);
    expect(await env.store.actions.get(parent.id)).toMatchObject({ status: 'executed', result: { warning: 'accepted; cleanup failed', status: 'sent' } });
  });
});
