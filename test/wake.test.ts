// The deterministic wake rules (plan §7, P6) as a table.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type WakeThread, wakeReason } from '../src/wake.ts';

const shared = (): WakeThread => ({ kind: 'chat', visibility: 'shared' });
const human = (body: Record<string, unknown>) => ({ actor: 'principal:alice', type: 'message', body: { via: 'slack', mentions: [], ...body } });

test('wake rules', () => {
  const cases: Array<[string, ReturnType<typeof wakeReason>, ReturnType<typeof wakeReason>]> = [
    ['DM', wakeReason(human({ dm: true }), { kind: 'dm', visibility: 'private:alice' }), 'slack_dm'],
    ['mention', wakeReason(human({ mentions_bot: true }), shared()), 'slack_mention'],
    ['human-to-human, no mention', wakeReason(human({}), shared()), null],
    ['untagged reply in a thread the bot spoke in (P2)', wakeReason(human({}), shared()), null],
    ['reply to another human in that thread', wakeReason(human({ mentions: ['bob'] }), shared()), null],
    ['agent to ops', wakeReason({ actor: 'agent:alice/scout', type: 'message', body: { to: 'ops' } }, shared()), 'agent_message'],
    ['agent to agent', wakeReason({ actor: 'agent:alice/scout', type: 'message', body: { to: 'bob/helper' } }, shared()), null],
    ['relay request', wakeReason({ actor: 'agent:alice/scout', type: 'relay_request', body: {} }, shared()), 'relay_request'],
    ['new window', wakeReason({ actor: 'agent:alice/scout', type: 'window_requested', body: {} }, { kind: 'window', visibility: 'shared' }), 'new_window'],
    // An urgent window's decision and clock only rewrite its card; the ops agent has nothing to add (P5).
    ['decision', wakeReason({ actor: 'principal:bob', type: 'window_decision', body: {} }, { kind: 'window', visibility: 'shared' }), null],
    ['clock: start or expiry', wakeReason({ actor: 'system', type: 'window_state', body: {} }, { kind: 'window', visibility: 'shared' }), null],
    ['clock: end or overdue', wakeReason({ actor: 'system', type: 'window_reminder', body: {} }, { kind: 'window', visibility: 'shared' }), null],
    ['report: it only rewrites the card', wakeReason({ actor: 'agent:alice/scout', type: 'window_report', body: {} }, { kind: 'window', visibility: 'shared' }), null],
    ['a standing-approval card', wakeReason({ actor: 'system', type: 'standing_requested', body: {} }, shared()), null],
    ['a standing-approval decision', wakeReason({ actor: 'principal:bob', type: 'standing_decision', body: {} }, shared()), null],
    ['its own message', wakeReason({ actor: 'ops', type: 'message', body: {} }, shared()), null],
    ['a notice', wakeReason({ actor: 'system', type: 'notice', body: {} }, shared()), null],
    ['private thread, even a mention', wakeReason(human({ mentions_bot: true }), { kind: 'chat', visibility: 'private:alice' }), null],
  ];
  for (const [name, got, want] of cases) assert.equal(got, want, name);
});
