import { expect, it } from 'vitest';
import { request, setup } from './testing/fixtures.js';

it('executes a profile update with an ordinary reversible profile_update inverse', async () => {
  const { executor, store, policy } = await setup();
  await policy.pinLevel('matters', 'full_access');
  const before = '# USER.md\n\n## Standing rules\n- Ask first.\n';
  await store.kv.set('user_profile', before);
  const action = await executor.submit(request('profile_update', { markdown: '# USER.md\nNew instructions.' }, { category: 'matters' }));
  expect(action).toMatchObject({ status: 'executed', decision: { reversibility: 'reversible', risk: 'low' }, inverse: { type: 'profile_update', params: { markdown: before } } });
  expect(await store.kv.get('user_profile')).toBe('# USER.md\nNew instructions.');
  await executor.undo(action.id);
  expect(await store.kv.get('user_profile')).toBe(before);
});

it('leaves USER.md unchanged until a proposed update is approved', async () => {
  const { executor, store, policy } = await setup();
  await policy.pinLevel('matters', 'supervised');
  const action = await executor.submit(request('profile_update', { markdown: 'New profile' }, { category: 'matters' }));
  expect(action.status).toBe('proposed');
  expect(await store.kv.get('user_profile')).toBeNull();
  await store.kv.set('user_profile', 'Edited while pending');
  await executor.approve(action.id);
  await executor.undo(action.id);
  expect(await store.kv.get('user_profile')).toBe('Edited while pending');
});
