// Slack mirror and inbound routing, against the fake port.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SwitchboardError } from '../src/core.ts';
import { BoltSlack, type InboundMessage, type SlackPost, SlackBridge } from '../src/slack.ts';
import { type Resource, Windows } from '../src/windows.ts';
import { FakeSlack, RESOURCES, SLACK, world } from './fakes.ts';

/** Refuses replies under roots deleted in Slack, the way its Web API refuses a reply to a missing parent. */
class DeletedRoots extends FakeSlack {
  deleted = new Set<string>();
  override async post(msg: SlackPost): Promise<{ channel: string; ts: string }> {
    if (msg.threadTs && this.deleted.has(msg.threadTs)) throw Object.assign(new Error('An API error occurred: thread_not_found'), { data: { ok: false, error: 'thread_not_found' } });
    return super.post(msg);
  }
}

/** Refuses any message with blocks the way Slack's Web API does for a malformed one. */
class RefusesBlocks extends FakeSlack {
  refused = 0;
  override async post(msg: SlackPost): Promise<{ channel: string; ts: string }> {
    if (msg.blocks) { this.refused++; throw Object.assign(new Error('An API error occurred: invalid_blocks'), { data: { ok: false, error: 'invalid_blocks' } }); }
    return super.post(msg);
  }
}

function setup(lane: 'deny' | 'open' = 'open', slack = new FakeSlack()) {
  const w = world(lane);
  const bridge = new SlackBridge({ core: w.core, port: slack, opsChannel: SLACK.ops, botUserId: SLACK.bot });
  bridge.start();
  const settle = async () => { for (let i = 0; i < 5; i++) await bridge.sweep(); };
  return { ...w, slack, bridge, settle };
}

const code = (fn: () => unknown): string => {
  try { fn(); } catch (err) { if (err instanceof SwitchboardError) return err.code; throw err; }
  return 'ok';
};

/** A shared chat thread a human is part of, as one they started in #ops, with an agent in it too. */
const humanThread = (core: ReturnType<typeof world>['core'], who = 'bob') =>
  core.createThread({ kind: 'chat', visibility: 'shared', title: 'gateway', participants: ['ops', `principal:${who}`, 'agent:alice/scout'] });
const ops = (core: ReturnType<typeof world>['core'], threadId: string, text: string) => core.postMessage(core.thread(threadId)!, 'ops', { text });

describe('mirror', () => {
  test('agent-to-agent and agent-to-ops traffic never reaches Slack (P3)', async () => {
    const { s, slack, settle, core } = setup();
    const { thread } = s.scout.sendMessage('bob/helper', 'need the staging box');
    s.helper.post(thread, 'take it after 15:00');
    const toOps = s.scout.sendMessage('ops', 'SPEC: 40 lines of plan, then DONE with /home/alice/x/y.ts and /home/alice/x/z.ts');
    core.append(toOps.thread, 'system', 'notice', { text: 'Claude (API credits) failed (socket hang up), so Claude (subscription) takes this turn.' });
    core.setMute('bob', 'alice', 'relayed_only');
    s.scout.sendMessage('bob/analyst', 'pass this on'); // a relay request to the ops agent
    await settle();
    assert.deepEqual(slack.posts, []);
    assert.equal(core.thread(thread)!.slack_ts, null, 'no Slack root');
    assert.equal(core.thread(toOps.thread)!.slack_ts, null, 'no Slack root');
  });

  test('the ops agent in an agents-only thread: nothing in Slack unless it tags a human; a tag pages them as a new top-level post, and a human who replies joins the thread (P3)', async () => {
    const { s, slack, settle, core, bridge } = setup();
    const { thread } = s.scout.sendMessage('ops', 'can I restart the staging box at 15:00?');
    const ops = (text: string) => core.postMessage(core.thread(thread)!, 'ops', { text });
    ops("alice/scout: Bob's load test runs there until 16:00; I'll ask.");
    ops('@alice/scout an agent id is not a human tag');
    await settle();
    assert.equal(slack.posts.length, 0, 'answers to agents reach their inboxes only');

    const page = "@bob scout wants to restart the staging box at 15:00 UTC, which stops your load test. OK by 14:30? Tag me when you've decided.";
    ops(page);
    await settle();
    assert.equal(slack.posts.length, 1);
    const root = slack.posts[0]!;
    assert.equal(root.channel, SLACK.ops);
    assert.equal(root.threadTs, undefined, 'a new top-level post');
    assert.equal(root.text, bridge.opsText(page), 'only the ops text');
    assert.equal(root.blocks, undefined);
    assert.equal(core.thread(thread)!.slack_ts, root.ts, 'it is the thread\'s Slack root now');

    ops('alice/scout: asked Bob, wait.'); // still agents only
    ops('@bob the box is free again at 16:00, if that helps.'); // a later page goes under the first
    await settle();
    assert.deepEqual(slack.posts.slice(1).map((p) => [p.threadTs, p.text]), [[root.ts, `<@${SLACK.bob}> the box is free again at 16:00, if that helps.`]]);

    s.scout.readInbox();
    const unread = core.unread('ops').unread;
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.bob, text: `<@${SLACK.bot}> fine, after 15:30`, ts: '6.1', threadTs: root.ts });
    assert.equal(core.events(thread).at(-1)!.body['text'], `<@${SLACK.bot}> fine, after 15:30`, 'the reply is in the switchboard thread');
    assert.equal(core.unread('ops').unread, unread + 1, 'and wakes the ops agent');
    assert.match(String(s.scout.readInbox()[0]!.body['text']), /fine, after 15:30/, 'the agents in it get it too');
    assert.ok(core.isParticipant(thread, 'principal:bob'), 'replying made Bob part of the thread');

    ops('alice/scout: go ahead at 15:30.'); // a human is in it now, so this shows in Slack without a tag
    await settle();
    assert.deepEqual(slack.posts.slice(2).map((p) => [p.threadTs, p.text]), [[root.ts, 'alice/scout: go ahead at 15:30.']]);
  });

  test('once a human joins a paged thread, the agent\'s next unrelated message to ops starts a fresh agents-only thread: nothing new under the old page (P3)', async () => {
    const { s, slack, settle, core, bridge, clock } = setup();
    const { thread } = s.scout.sendMessage('ops', 'can I take the staging box at 15:00?');
    core.postMessage(core.thread(thread)!, 'ops', { text: "@alice scout wants the staging box at 15:00. OK? Tag me when you've decided." });
    await settle();
    const page = slack.posts[0]!;
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> yes`, ts: '9.1', threadTs: page.ts });
    clock.advance(24 * 60);
    const next = s.scout.sendMessage('ops', 'NEXT DAY, unrelated: SPEC DUMP with /home/alice/x.ts');
    core.postMessage(core.thread(next.thread)!, 'ops', { text: 'alice/scout: answer to the unrelated question' });
    await settle();
    assert.equal(slack.posts.length, 1, 'nothing new under the old page');
    assert.notEqual(next.thread, thread, 'a fresh thread');
    assert.ok(core.agentsOnly(core.thread(next.thread)!), 'that stays agents-only');
    assert.equal(s.scout.sendMessage('ops', 'and a follow-up').thread, next.thread, 'and is reused while it is');
  });

  test('an email address or a code span is not a page tag (P3)', async () => {
    const { s, slack, settle, core, bridge } = setup();
    const { thread } = s.scout.sendMessage('ops', 'who owns the box?');
    for (const text of ['mail ops@alice.example about it', 'run `@alice status` first', 'the hook prints:\n```\n@bob ok\n```']) core.postMessage(core.thread(thread)!, 'ops', { text });
    await settle();
    assert.equal(slack.posts.length, 0, 'nobody was paged');
    assert.equal(bridge.opsText('mail ops@alice.example, run `@alice` then ask @alice.'), `mail ops@alice.example, run \`@alice\` then ask <@${SLACK.alice}>.`);
  });

  test('a page tag is case-insensitive: @Bob pages Bob (P3)', async () => {
    const { s, slack, settle, core } = setup();
    const { thread } = s.scout.sendMessage('ops', 'can I restart the staging box at 15:00?');
    core.postMessage(core.thread(thread)!, 'ops', { text: "@Bob scout wants the staging box at 15:00 UTC. OK? Tag me when you've decided." });
    await settle();
    assert.equal(slack.posts.length, 1, 'the page was posted');
    assert.match(slack.posts[0]!.text, new RegExp(`^<@${SLACK.bob}> scout wants`));
  });

  test('no header post: the first message a thread shows in Slack is its root (P3)', async () => {
    const { s, slack, settle, core } = setup();
    const thread = humanThread(core).id;
    ops(core, thread, 'The gateway patch is ready.');
    core.presentAsk(s.scout.askHuman('alice', 'restart the gateway now?', ['yes', 'no']).ask!, 'Bump the gateway now?');
    await settle();
    ops(core, thread, 'The rollback is staged.');
    await settle();
    assert.ok(slack.posts.every((p) => !p.text.includes(':speech_balloon:')), 'no header, ever');
    const [root, reply] = slack.posts.filter((p) => p.channel === SLACK.ops);
    assert.equal(root!.threadTs, undefined);
    assert.match(root!.text, /gateway patch is ready/);
    assert.equal(core.thread(thread)!.slack_ts, root!.ts);
    assert.equal(reply!.threadTs, root!.ts, 'later messages reply under it');
    const dm = slack.posts.filter((p) => p.channel === `D${SLACK.alice}`);
    assert.equal(dm.length, 1);
    assert.equal(dm[0]!.threadTs, undefined, 'the question card is the DM root');
    assert.ok(dm[0]!.blocks, 'with its buttons');
  });
  test('P3: an agent\'s reply in a thread a human is part of never shows in Slack; the ops agent\'s does, in that Slack thread', async () => {
    const { s, slack, settle, core, bridge } = setup();
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> who has the staging box?`, ts: '7.1' });
    const thread = core.threadBySlack(SLACK.ops, '7.1')!.id;
    s.scout.post(thread, 'I do, until 16:00');
    ops(core, thread, 'Your scout has it until 16:00 UTC.');
    await settle();
    assert.deepEqual(slack.posts.filter((p) => p.threadTs === '7.1').map((p) => p.text), ['Your scout has it until 16:00 UTC.']);
    const own = core.createThread({ kind: 'chat', visibility: 'private:alice', title: 'with Alice', participants: ['agent:alice/scout', 'principal:alice'] });
    s.builder.post(own.id, 'and the report is written');
    await settle();
    assert.equal(slack.textIn(`D${SLACK.alice}`), '', 'nor in a thread in the human\'s DM');
  });
  test('P3: post never shows in Slack, and says which humans the ops agent reads it for; send_message to a human under a window card posts nothing there', async () => {
    const { s, slack, settle, core, agents } = setup();
    const win = new Windows(core, RESOURCES).request(agents.scout, { resource: 'api-gateway', start: '2026-10-14T14:00:00Z', duration_minutes: 30, plan: 'p', rollback: 'r', verify: 'v' });
    await settle();
    const card = slack.posts[0]!;
    assert.deepEqual({ ...s.scout.post(win.window, 'yes, the rollback is staged'), seq: 0 }, { status: 'posted', thread: win.window, seq: 0, slack: false }, 'window threads show only their cards');
    const other = s.scout.sendMessage('bob', 'yes, the rollback is staged', win.window);
    const own = s.scout.sendMessage('alice', 'starting at 14:00', win.window);
    await settle();
    assert.deepEqual(slack.posts.filter((p) => p.threadTs === card.ts), []);
    assert.deepEqual([other.via, own.via], ['the ops agent', 'the ops agent']);
    for (const sent of [other, own]) assert.equal(core.event(core.humanItem(sent.item!)!.thread_id, sent.seq)!.body['re_thread'], win.window, 'the ops agent sees which card it was about');

    const withHuman = humanThread(core).id;
    core.join(withHuman, 'agent:bob/helper');
    const posted = s.helper.post(withHuman, 'a');
    assert.deepEqual([posted.slack, posted.for_human], [false, ['bob']], 'a chat thread a human is part of: for the ops agent');
    const agentsOnly = s.helper.sendMessage('alice/scout', 'x').thread;
    const b = s.helper.post(agentsOnly, 'b');
    assert.deepEqual([b.slack, b.for_human], [false, undefined], 'agents only');
  });
  test('an agent that answers a human under a window card it did not request gets the human\'s reply (P3)', async () => {
    const { s, slack, settle, core, agents, bridge } = setup();
    const win = new Windows(core, RESOURCES).request(agents.scout, { resource: 'api-gateway', start: '2026-10-14T14:00:00Z', duration_minutes: 30, plan: 'p', rollback: 'r', verify: 'v' });
    await settle();
    const card = slack.posts[0]!;
    s.builder.sendMessage('bob', 'the rollback restores the db snapshot', win.window);
    await settle();
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.bob, text: 'builder, which snapshot?', ts: '9.1', threadTs: card.ts });
    const got = s.builder.readInbox(20).map((i) => (i.body as { text?: string }).text);
    assert.ok(got.includes('builder, which snapshot?'), `builder joined the window thread when it answered there: ${JSON.stringify(got)}`);
  });

  test('a relay thread a human joined is not reused: the next relay starts a fresh agents-only one (P3)', async () => {
    const { s, slack, settle, core, bridge } = setup();
    core.setMute('bob', 'alice', 'relayed_only');
    s.scout.sendMessage('bob/helper', 'need the staging box at 15:00');
    const first = core.relay('bob/helper', "@bob scout wants the staging box at 15:00. OK? Tag me when you've decided.");
    await settle();
    const page = slack.posts[0]!;
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.bob, text: `<@${SLACK.bot}> fine`, ts: '8.1', threadTs: page.ts });
    s.scout.sendMessage('bob/helper', 'and the gateway at 16:00: SPEC DUMP /home/alice/x.ts');
    const second = core.relay('bob/helper', 'scout also wants the gateway at 16:00.');
    await settle();
    assert.equal(slack.posts.length, 1, 'nothing new under the old page');
    assert.notEqual(second.thread_id, first.thread_id, 'a fresh relay thread');
    assert.ok(core.agentsOnly(core.thread(second.thread_id)!), 'with only agents in it');
  });

  test('whether a human is in a thread is decided as of each event, not when Slack catches up (P3)', async () => {
    const { s, slack, settle, core } = setup();
    const { thread } = s.scout.sendMessage('ops', 'can I take the staging box?');
    ops(core, thread, 'alice/scout: wait, I am checking.'); // only agents in it yet
    core.join(thread, 'principal:alice');                  // Alice joins here, in the same millisecond
    ops(core, thread, 'Alice, scout wants the staging box at 15:00 UTC.');
    await settle();
    const texts = slack.posts.map((p) => p.text);
    assert.ok(texts.some((t) => t.includes('scout wants the staging box')));
    assert.ok(!texts.some((t) => t.includes('I am checking')), 'written while only agents were in it');
  });
  test('agent chat inside one principal is never mirrored', async () => {
    const { s, slack, settle } = setup();
    s.scout.sendMessage('builder', 'private research chatter');
    await settle();
    assert.equal(slack.posts.length, 0);
  });

  test('P3: a message to your own human waits in their DM with the ops agent; to the other human, in the agent\'s thread with the ops agent; Slack shows neither', async () => {
    const { s, slack, settle, core } = setup();
    const own = s.scout.sendMessage('alice', 'batch job finished');
    const other = s.scout.sendMessage('bob', 'gateway patch is ready');
    await settle();
    assert.deepEqual(slack.posts, []);
    assert.deepEqual([core.thread(own.thread)!.kind, core.thread(own.thread)!.visibility], ['dm', 'private:alice']);
    assert.deepEqual([core.thread(other.thread)!.visibility, core.participants(other.thread)], ['shared', ['agent:alice/scout', 'ops']]);
    assert.deepEqual(core.pendingHumanItems().map((i) => [i.principal, i.thread_id]), [['alice', own.thread], ['bob', other.thread]]);
  });
  test('P4: a message or question from the other principal\'s agent to a human with a delegate goes to the delegate\'s inbox, never Slack; mutes don\'t stop it; their own agents still reach their DM', async () => {
    const { s, slack, settle, core } = setup('deny');
    core.setDelegate('alice', 'alice/builder');
    assert.equal(core.muteMode('alice', 'bob'), 'all');
    const sent = s.helper.sendMessage('alice', 'please withdraw your queued change c_00000000beef');
    const asked = s.helper.askHuman('alice', 'push backend commit 1a2b3c4d?', ['yes', 'no']);
    s.helper.sendMessage('alice', 'and the rollback is staged', sent.thread);
    await settle();
    assert.deepEqual(slack.posts, [], 'nothing in Slack: no message, no card, no buttons');
    assert.deepEqual([sent.via, asked.via], ["alice's delegate alice/builder", "alice's delegate alice/builder"]);
    assert.equal(s.builder.readInbox().length, 3);
    const own = s.scout.sendMessage('alice', 'batch job finished');
    await settle();
    assert.deepEqual([own.via, core.thread(own.thread)!.kind, s.builder.readInbox().length], ['the ops agent', 'dm', 0], 'an own-principal agent still writes to Alice, through the ops agent (P3), not her delegate');
  });

  test('P3: no agent-authored text reaches Slack, whatever the path: a message to its own human or the other one, a post in a thread a human is part of', async () => {
    const { s, slack, settle, bridge, core } = setup('open');
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> watch the gateway`, ts: '50.1' });
    const human = core.threadBySlack(SLACK.ops, '50.1')!;
    const own = core.createThread({ kind: 'chat', visibility: 'private:alice', title: 'old pair thread with Alice', participants: ['agent:alice/scout', 'principal:alice'] });
    const win = core.createThread({ kind: 'window', visibility: 'shared', title: 'w', participants: ['agent:alice/scout', 'principal:alice', 'principal:bob'] });
    s.scout.sendMessage('alice', 'AGENT-1 to own human');
    s.scout.sendMessage('bob', 'AGENT-2 to the other human');
    s.helper.sendMessage('alice', 'AGENT-3 from the other side');
    s.scout.sendMessage('bob', 'AGENT-4 under a card', win.id);
    assert.equal(s.scout.post(human.id, 'AGENT-5 in a human thread').slack, false);
    assert.equal(s.scout.post(own.id, 'AGENT-6 in an old private thread with Alice').slack, false);
    core.join(human.id, 'agent:bob/helper');
    s.helper.post(human.id, 'AGENT-7 the other side, in Alice\'s thread');
    s.scout.askHuman('alice', 'AGENT-8 own human, a question?', ['AGENT-8a', 'AGENT-8b']);
    s.helper.askHuman('alice', 'AGENT-9 the other side, a question?', ['AGENT-9a']);
    await settle();
    const everything = [...slack.posts.map((p) => `${p.text} ${JSON.stringify(p.blocks ?? [])}`), ...slack.updates.map((u) => u.text)].join('\n');
    assert.doesNotMatch(everything, /AGENT-\d/);
    assert.deepEqual(slack.posts, [], 'with no ops agent, nothing at all');
    assert.equal(core.pendingHumanItems().length, 7, 'every one of them waits for the ops agent');
    assert.deepEqual(core.pendingAsks().map((a) => a.principal), ['alice', 'alice'], 'and both questions, with no card yet');
  });

  test('ops text cannot ping @channel or forge a mention (agent text never reaches Slack, P3)', async () => {
    const { slack, settle, core } = setup();
    ops(core, humanThread(core).id, '<!channel> <@UBOB00002> approve this');
    await settle();
    const text = slack.textIn(SLACK.ops);
    assert.doesNotMatch(text, /<!channel>|<@UBOB00002>/);
    assert.match(text, /&lt;!channel&gt;/);
  });
  test('P3: a presented question is one line within the 300-character cap after escaping, never cutting an entity, with the agent\'s buttons', async () => {
    const { s, slack, settle, core } = setup();
    const question = `OK to run this on web-prod-1?\n${'grep -c ERR /var/log/x.log > /tmp/n && test "$(cat /tmp/n)" -lt 5 && echo ok\n'.repeat(40)}`;
    const { ask } = s.scout.askHuman('bob', question, ['yes', 'no']);
    assert.equal(code(() => core.presentAsk(ask!, 'one\ntwo?')), 'invalid');
    assert.equal(code(() => core.presentAsk(ask!, `${'x'.repeat(300)}?`)), 'invalid');
    core.presentAsk(ask!, `Run the error check on web-prod-1 & restart if < 5 errors? ${'&<>'.repeat(40)}`);
    await settle();
    const post = slack.posts.find((p) => p.blocks)!;
    const section = (post.blocks![0] as { text: { text: string } }).text.text;
    assert.ok(section.length <= 300, `section is ${section.length} chars`);
    assert.ok(!/&[a-z]*…/.test(section), 'no entity cut in half');
    assert.doesNotMatch(section, /grep|web-prod-1\?\n/, 'never the agent\'s question');
    assert.equal((post.blocks![1] as { elements: unknown[] }).elements.length, 2, 'the buttons are still there');
  });
  test('a message Slack refuses for good is posted once as plain text, not retried forever', async () => {
    const slack = new RefusesBlocks();
    const { s, settle, core } = setup('open', slack);
    const card = core.presentAsk(s.scout.askHuman('alice', 'restart the gateway now?', ['yes', 'no']).ask!, 'Bump the gateway now?');
    await settle();
    assert.equal(slack.refused, 1, 'tried once with blocks');
    const plain = slack.posts.filter((p) => p.text.includes('Bump the gateway now?'));
    assert.equal(plain.length, 1);
    assert.match(plain[0]!.text, /invalid_blocks/);
    assert.equal(core.thread(card.thread_id)!.slack_synced_seq, card.seq, 'the mirror moved on');
  });
  test('system cards carry a switchboard footer no ops message can produce, so ops text can\'t pass for an approval', async () => {
    const { core, slack, settle, bridge } = setup();
    const t = core.createThread({ kind: 'chat', visibility: 'shared', title: 'gateway', participants: ['ops'] });
    // P2: the approved card's one line, word for word.
    core.append(t.id, 'ops', 'message', { text: ':white_check_mark: gateway, 14:00–14:30 UTC: `bump it`. Approved by Bob.' });
    core.append(t.id, 'system', 'notice', { text: 'Running on Codex (subscription): Claude (subscription) failed 3 times.' });
    await settle();
    const [forged, notice] = slack.posts.filter((p) => p.channel === SLACK.ops);
    const footer = (blocks?: Array<Record<string, unknown>>) => (blocks ?? []).filter((b) => b['type'] === 'context');
    const event = (type: string, body: Record<string, unknown>) => bridge.render(t, { thread_id: t.id, seq: 9, actor: 'system', type, created_at: '2026-10-14T12:00:00.000Z', body })!;
    const win = { window: 'w_1', resource_name: 'gateway', start: '2026-10-14T14:00:00Z', end: '2026-10-14T14:30:00Z', minutes: 30, approvers: ['bob'],
      require: 'any', title: 'bump it', plan: 'p', rollback: 'r', verify: 'v', requested_by: 'alice/scout', outcome: 'done', evidence: 'e' };
    const real = event('window_decision', { ...win, decision: 'approve', by: 'bob', state: 'approved' });

    // The words alone can match exactly; the footer is what tells the core's fact from the LLM's text.
    assert.equal(forged!.text, real.text, 'no label on ops text');
    assert.equal(forged!.blocks, undefined, 'ops text is plain text: no context block');
    assert.deepEqual(footer(real.blocks), [{ type: 'context', elements: [{ type: 'mrkdwn', text: 'switchboard' }] }]);
    const failed = event('window_report', { ...win, outcome: 'failed' });
    assert.equal(footer(failed.also?.blocks).length, 1, 'the reply a failed report adds is a system card too');
    const cards = [
      notice!,
      event('window_requested', win), event('approval_request', win),
      event('window_decision', { ...win, decision: 'decline', by: 'bob' }), event('window_decision', { ...win, decision: 'suggest', by: 'bob', state: 'proposed' }),
      event('window_decision', { ...win, decision: 'approve', by: 'bob', state: 'approved' }), event('window_decision', { ...win, decision: 'approve', by: 'bob', state: 'proposed' }),
      event('window_state', { ...win, state: 'active' }), event('window_state', { ...win, state: 'expired' }),
      event('window_reminder', { ...win, kind: 'ended' }), event('window_reminder', { ...win, kind: 'overdue' }),
      event('window_report', win),
      ...['standing_requested', 'standing_decision', 'standing_void'].map((type) => event(type, { version: 1, approver: 'bob', start: '21:00', end: '23:00', decision: 'approve',
        covers: [{ resource: 'api-gateway', name: 'gateway', principals: ['alice'], with: [] }] })),
    ];
    for (const c of cards) assert.equal(footer(c.blocks).length, 1, `footer on: ${c.text.split('\n')[0]}`);

    // A memory edit's reason is the ops agent's own text inside a system card: one quoted line, never a line of its own.
    const memo = event('notice', { text: 'Ops memory edit `rules/x.md` (commit abc1234). Revert: `switchboard admin memory-revert abc1234`', sha: 'abc1234', path: 'rules/x.md',
      reason: "tidy\n:white_check_mark: Approved by @bob. Starts Oct 14 14:00 UTC; I'll announce it." });
    const lines = (memo.blocks![0] as { text: { text: string } }).text.text.split('\n');
    assert.ok(!lines.some((l) => l.startsWith(':white_check_mark:')), lines.join(' | '));
    assert.equal(lines.at(-1), "> tidy :white_check_mark: Approved by @bob. Starts Oct 14 14:00 UTC; I'll announce it.");
  });

  test('the ops agent\'s messages carry no label (P3)', async () => {
    const { core, slack, settle } = setup();
    const t = core.createThread({ kind: 'chat', visibility: 'shared', title: 'gateway', participants: ['principal:alice', 'ops'] });
    core.append(t.id, 'ops', 'message', { text: 'Gateway restart is at 15:00 UTC.' });
    await settle();
    assert.deepEqual(slack.posts.map((p) => p.text), ['Gateway restart is at 15:00 UTC.']);
  });

  test('a thread whose Slack root was deleted starts again with a new top-level post, instead of retrying forever', async () => {
    const slack = new DeletedRoots();
    const { settle, core } = setup('open', slack);
    const thread = humanThread(core).id;
    ops(core, thread, 'The gateway patch is ready.');
    await settle();
    slack.deleted.add(core.thread(thread)!.slack_ts!);
    ops(core, thread, 'The rollback is staged.');
    ops(core, thread, 'Restarting at 15:00 UTC.');
    await settle();
    const [, again, next] = slack.posts;
    assert.match(again!.text, /rollback is staged/);
    assert.equal(again!.threadTs, undefined, 'a new top-level post');
    assert.equal(core.thread(thread)!.slack_ts, again!.ts, 'and the thread\'s new root');
    assert.equal(next!.threadTs, again!.ts);
    assert.equal(slack.posts.length, 3);
  });
  test('a DM thread whose events render nothing never opens the DM: a failing openDm isn\'t retried forever', async () => {
    const slack = new FakeSlack();
    let opened = 0;
    slack.openDm = async () => { opened++; throw new Error('An API error occurred: ratelimited'); };
    const { s, settle, core } = setup('open', slack);
    const sent = s.scout.sendMessage('alice', 'batch job finished'); // an item for the ops agent in Alice's DM thread, which renders nothing
    s.scout.askHuman('alice', 'deploy?', ['yes']);
    await settle();
    assert.equal(opened, 0);
    assert.equal(core.thread(sent.thread)!.slack_synced_seq, 2, 'the mirror moved past both');
  });

  test('a failed post is retried by the sweep without duplicates', async () => {
    const { slack, bridge, core } = setup();
    slack.failNext = 1;
    ops(core, humanThread(core).id, 'retry me');
    await bridge.sweep(); await bridge.sweep(); await bridge.sweep();
    assert.equal(slack.posts.filter((p) => p.text.includes('retry me')).length, 1);
  });
});

describe('the cap on system cards (P2)', () => {
  test('absurdly long plans, titles, evidence, resource names and notes: no card, summary or notice in Slack is over 300 characters, and none shows a plan, rollback, verify or evidence', async () => {
    const w = world('open');
    const huge = (tag: string) => `${tag} ${'R&D <ops> '.repeat(400)}`;
    const resources: Resource[] = [
      { id: 'both', name: huge('Both'), owners: ['alice', 'bob'], approvers: ['alice', 'bob'], require: 'all', max_duration_minutes: 600, note: huge('NOTE') },
      { id: 'gw', name: huge('Gateway'), owners: ['alice', 'bob'], approvers: ['bob'], require: 'any', max_duration_minutes: 600, note: huge('NOTE') },
    ];
    let windows = new Windows(w.core, resources);
    const slack = new FakeSlack();
    const bridge = new SlackBridge({ core: w.core, port: slack, opsChannel: SLACK.ops, botUserId: SLACK.bot, windows });
    bridge.start();
    const settle = async () => { for (let i = 0; i < 4; i++) await bridge.sweep(); };
    const terms = { plan: `Do the whole thing now. ${huge('PLANSECRET')}`, rollback: huge('ROLLBACKSECRET'), verify: huge('VERIFYSECRET') };
    const evidence = huge('EVIDENCESECRET');
    const press = (id: string, user: string, decision: string) => bridge.onAction({ actionId: `sb_win_${decision}`, value: JSON.stringify({ w: id }), user, channel: SLACK.ops, messageTs: '9.9' });
    const urgent = (resource: string, start: string, title?: string) => windows.request(w.agents.scout, { resource, start, duration_minutes: 30, ...terms, ...(title ? { title } : {}) });
    const tick = async (iso: string) => { w.clock.t = Date.parse(iso); windows.tick(); await settle(); };

    // Urgent windows through every card: the request, the ops agent's re-post, an old card's suggest, a partial and a
    // final approval (and the button handler's rewrite of the re-posted card), a decline, start, end, expiry, the
    // overdue page and every report, a failed one with its reply.
    const a = urgent('both', '2026-10-14T12:30:00Z', `&<${'x'.repeat(78)}`);
    const row = windows.window(a.window)!;
    w.core.append(a.window, 'ops', 'approval_request', { window: a.window, resource: 'both', resource_name: resources[0]!.name, note: resources[0]!.note, title: row.title,
      start: row.start_at, end: row.end_at, minutes: 30, ...terms, approvers: row.approvers, require: 'all', requested_by: row.requested_by });
    await settle();
    await press(a.window, SLACK.bob, 'suggest');
    await press(a.window, SLACK.bob, 'approve');
    await press(a.window, SLACK.alice, 'approve');
    await press(urgent('gw', '2026-10-14T13:00:00Z').window, SLACK.bob, 'decline');
    urgent('gw', '2026-10-14T12:10:00Z'); // never decided: it expires
    const reported = ['done', 'rolled_back', 'partial'].map((outcome, i) => ({ id: urgent('gw', `2026-10-14T1${4 + i}:00:00Z`).window, outcome }));
    for (const r of reported) await press(r.id, SLACK.bob, 'approve');
    await settle();
    await tick('2026-10-14T12:31:00Z');
    await tick('2026-10-14T13:00:00Z');
    await tick('2026-10-14T13:30:00Z');
    windows.report(w.agents.scout, { id: a.window, outcome: 'failed', evidence });
    await tick('2026-10-14T16:05:00Z');
    for (const r of reported) windows.report(w.agents.scout, { id: r.id, outcome: r.outcome, evidence });
    await settle();
    // A title is at most 80 characters when requested; one written into an event some other way is still capped.
    const body = { ...w.core.events(a.window, 0, 1)[0]!.body, title: 'T'.repeat(5000) };
    const direct = bridge.render(w.core.thread(a.window)!, { thread_id: a.window, seq: 99, actor: 'agent:alice/scout', type: 'window_requested', created_at: '2026-10-14T12:00:00.000Z', body })!;

    // The nightly slot: both approvers' cards, a supplementary card, every decision, the summary, and a new time.
    for (const resource of ['both', 'gw']) windows.queue(w.agents.scout, { resource, ...terms });
    await settle();
    const standing = (approver: string, user: string, decision: string) => {
      const card = w.core.db.prepare('SELECT id FROM standing_cards WHERE approver = ? ORDER BY id DESC LIMIT 1').get(approver) as { id: number };
      return bridge.onAction({ actionId: `sb_std_${decision}`, value: JSON.stringify({ k: card.id }), user, channel: SLACK.ops, messageTs: '8.8' });
    };
    await standing('bob', SLACK.bob, 'approve');
    await standing('bob', SLACK.bob, 'revoke');
    await standing('alice', SLACK.alice, 'decline');
    windows = new Windows(w.core, [...resources, { id: 'extra', name: huge('Extra'), owners: ['alice'], approvers: ['bob'], require: 'any', max_duration_minutes: 60 }]);
    windows.queue(w.agents.scout, { resource: 'extra', ...terms });
    await settle();
    await standing('bob', SLACK.bob, 'approve');
    const failed = windows.queue(w.agents.builder, { resource: 'gw', ...terms });
    w.clock.t = Date.parse('2026-10-14T21:10:00Z');
    windows.report(w.agents.builder, { id: failed.change, outcome: 'failed', evidence });
    await tick('2026-10-14T23:30:00Z');
    windows.setSchedule({ start: '22:00', duration_minutes: 120 }, 'ops:alice');
    await settle();

    // Notices: long text, a memory edit's long reason, an engine's long detail, an idle ping.
    const t = w.core.createThread({ kind: 'chat', visibility: 'shared', title: 'notices', participants: ['ops'] });
    w.core.append(t.id, 'system', 'notice', { text: `${huge('NOTICE')} @alice` });
    w.core.append(t.id, 'system', 'notice', { text: 'Ops memory edit `rules/x.md` (commit abc1234). Revert: `switchboard admin memory-revert abc1234`', reason: huge('REASON') });
    w.core.append(t.id, 'system', 'notice', { text: 'Claude (API credits) failed (other), so Claude (subscription) takes this turn.', detail: huge('DETAIL') });
    w.s.scout.sendMessage('builder', 'are you there?');
    w.clock.advance(31);
    w.core.pingIdleAgents(30);
    await settle();

    const shown = [...slack.posts, ...slack.updates, direct];
    const texts = shown.flatMap((m) => [m.text, ...(m.blocks ?? []).filter((b) => b['type'] === 'section').map((b) => (b['text'] as { text: string }).text)]);
    for (const text of texts) {
      assert.ok(text.length <= 300, `${text.length} chars: ${text.slice(0, 120)}`);
      assert.doesNotMatch(text, /PLANSECRET|ROLLBACKSECRET|VERIFYSECRET|EVIDENCESECRET/, text.slice(0, 120));
      assert.doesNotMatch(text, /&[a-z]*…|<[^>]*…/, `no entity or mention cut in half: ${text.slice(-40)}`);
    }
    for (const card of shown) assert.equal((card.blocks ?? []).at(-1)?.['type'], 'context', `a system card: ${card.text.slice(0, 60)}`);
    // Every card type was there to check.
    for (const marker of [':wrench:', 'Still needs a decision.', 'asked for another time.', 'waiting for', ':white_check_mark:', ':construction:', ':hourglass_flowing_sand:',
      ':heavy_minus_sign:', ':no_entry:', ':x:', ':leftwards_arrow_with_hook:', ':warning:', 'reported a failed change', "hasn't reported", 'Approved by Bob and Alice. Starts',
      'Approve once?', 'also needs your OK for Extra R&amp;D', 'Revoked by', 'Declined by', 'Void:', 'Maintenance Oct 14 21:00–23:00 UTC: 4 changes', 'Nightly maintenance is now',
      'NOTICE', 'Ops memory edit', 'DETAIL', 'switchboard message(s) have waited']) {
      assert.ok(texts.some((x) => x.includes(marker)), marker);
    }
    const summary = slack.posts.find((p) => p.text.includes('Maintenance Oct 14'))!;
    assert.match(summary.text, new RegExp(`^<@${SLACK.alice}>, check prod is in a known state\\.`), 'the summary keeps its tag whatever the resource names');
  });
});

describe('emoji at a cut (P2)', () => {
  test('a clipped resource name, note, title or summary never cuts an emoji in half', async () => {
    const w = world('open');
    const resources: Resource[] = [{ id: 'emoji', name: '😀'.repeat(200), owners: ['alice', 'bob'], approvers: ['bob'], require: 'any', max_duration_minutes: 60, note: `x${'🚀'.repeat(400)}` }];
    const windows = new Windows(w.core, resources);
    const slack = new FakeSlack();
    const bridge = new SlackBridge({ core: w.core, port: slack, opsChannel: SLACK.ops, botUserId: SLACK.bot, windows });
    bridge.start();
    const settle = async () => { for (let i = 0; i < 4; i++) await bridge.sweep(); };
    windows.request(w.agents.scout, { resource: 'emoji', start: 'now', duration_minutes: 30, plan: `${'é'.repeat(60)}${'😀'.repeat(60)}`, rollback: 'r', verify: 'v' });
    windows.queue(w.agents.scout, { resource: 'emoji', plan: 'p', rollback: 'r', verify: 'v' });
    w.clock.t = Date.parse('2026-10-14T23:30:00Z');
    windows.tick();
    await settle();
    const texts = [...slack.posts, ...slack.updates].flatMap((m) => [m.text, ...(m.blocks ?? []).filter((b) => b['type'] === 'section').map((b) => (b['text'] as { text: string }).text)]);
    assert.ok(texts.some((t) => t.includes('Maintenance Oct 14')), 'the summary was posted');
    for (const text of texts) {
      assert.ok(text.isWellFormed(), `no emoji cut in half: ${JSON.stringify(text.slice(-30))}`);
      assert.ok(text.length <= 300, `${text.length} chars`);
    }
  });
});

describe('inbound', () => {
  test('a human reply in a mirrored thread reaches the agents in it', async () => {
    const { s, slack, settle, bridge, core } = setup();
    const thread = humanThread(core).id;
    core.join(thread, 'agent:bob/helper');
    ops(core, thread, 'Helper can take the gateway restart.');
    s.helper.post(thread, 'I can take this one');
    await settle();
    s.scout.readInbox();
    const root = slack.posts[0]!.ts;
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.bob, text: 'helper, hold off', ts: '1.1', threadTs: root });
    const [item] = s.helper.readInbox().filter((i) => i.from === 'human');
    assert.equal(item!.thread, thread);
    assert.equal(item!.inbox_priority, 'steer');
    assert.equal(s.scout.readInbox()[0]!.inbox_priority, 'deferred');
  });
  test('a Slack message delivered twice (Socket Mode redelivery) is logged once and wakes the ops agent once', async () => {
    const { bridge, core } = setup();
    const mention = { channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> status?`, ts: '5.1' };
    const reply = { ...mention, text: `<@${SLACK.bot}> and now?`, ts: '5.2', threadTs: '5.1' };
    const dm = { channel: 'DALICE', channelType: 'im', user: SLACK.alice, text: 'between us', ts: '5.3' };
    for (const m of [mention, mention, reply, reply, dm, dm]) await bridge.onMessage(m);
    assert.deepEqual(core.events(core.threadBySlack(SLACK.ops, '5.1')!.id).map((e) => e.body['slack_ts']), ['5.1', '5.2']);
    assert.deepEqual(core.events(core.threadByKey('dm:alice')!.id).map((e) => e.body['slack_ts']), ['5.3']);
    assert.equal(core.unread('ops').unread, 3, 'one wake per message');
  });

  test('unknown Slack users and unrelated channel chatter are ignored', async () => {
    const { bridge, core } = setup();
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.stranger, text: `<@${SLACK.bot}> hi`, ts: '2.1' });
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: 'lunch?', ts: '2.2' });
    await bridge.onMessage({ channel: 'COTHER001', channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> hi`, ts: '2.3' });
    assert.equal((core.db.prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n, 0);
  });

  test('mentioning the bot starts a shared thread; a DM goes to the private DM thread', async () => {
    const { bridge, core } = setup();
    await bridge.onMessage({ channel: SLACK.ops, channelType: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> what's scheduled today?`, ts: '3.1' });
    const t = core.threadBySlack(SLACK.ops, '3.1')!;
    assert.equal(t.visibility, 'shared');
    assert.equal(core.events(t.id)[0]!.body['mentions_bot'], true);
    await bridge.onMessage({ channel: 'DALICE', channelType: 'im', user: SLACK.alice, text: 'between us', ts: '3.2' });
    const dm = core.threadByKey('dm:alice')!;
    assert.equal(dm.kind, 'dm');
    assert.equal(dm.visibility, 'private:alice');
  });

  test('ask_human buttons: only the asked human\'s click counts', async () => {
    const { s, slack, settle, bridge, core } = setup();
    const asked = s.scout.askHuman('bob', 'restart now?', ['yes', 'later']);
    core.presentAsk(asked.ask!, 'Bump the gateway now?');
    await settle();
    const msg = slack.posts.find((p) => p.blocks)!;
    const button = ((msg.blocks![1] as { elements: Array<{ action_id: string; value: string }> }).elements)[1]!;
    await bridge.onAction({ actionId: button.action_id, value: button.value, user: SLACK.alice, channel: SLACK.ops, messageTs: msg.ts });
    assert.match(slack.ephemerals[0]!.text, /for bob/);
    await bridge.onAction({ actionId: button.action_id, value: button.value, user: SLACK.bob, channel: SLACK.ops, messageTs: msg.ts });
    assert.match(slack.updates[0]!.text, /Bob answered: later/);
    assert.deepEqual(s.scout.readInbox().filter((i) => i.type === 'human_answer')[0]!.body, { ask_seq: asked.seq, answer: 'later', presented_as: 'Bump the gateway now?' });
  });
  test('an ask_human answer in a DM updates the card, in the ops agent\'s words, and posts nothing else (P3)', async () => {
    const { s, slack, settle, bridge, core } = setup();
    core.presentAsk(s.scout.askHuman('alice', 'SG-1 bounce gw now? B7 idle', ['yes', 'no']).ask!, 'Restart the gateway now? Nothing is using it.');
    await settle();
    const card = slack.posts.find((p) => p.blocks)!;
    assert.equal(card.channel, `D${SLACK.alice}`);
    const yes = ((card.blocks![1] as { elements: Array<{ action_id: string; value: string }> }).elements)[0]!;
    await bridge.onAction({ actionId: yes.action_id, value: yes.value, user: SLACK.alice, channel: card.channel, messageTs: card.ts });
    await settle();
    assert.equal(slack.updates[0]!.text, 'Restart the gateway now? Nothing is using it.\n*Alice answered: yes*', 'the ops agent\'s line, never the agent\'s question');
    assert.equal(slack.posts.length, 1, 'no separate "answered" reply');
  });
  test('a presented question with no options stays within the 300-character cap, its reply hint included', async () => {
    const { s, slack, settle, core } = setup();
    core.presentAsk(s.scout.askHuman('alice', 'q').ask!, `${'R&D '.repeat(74)}?`);
    core.presentAsk(s.scout.askHuman('bob', 'q').ask!, `${'R&D '.repeat(74)}?`);
    await settle();
    assert.equal(slack.posts.length, 2);
    for (const p of slack.posts) {
      assert.ok(p.text.length <= 300, `${p.text.length} chars`);
      assert.match(p.text, /\n_Reply (here|in this thread)\._$/, 'the hint survives the cut');
      assert.ok(!/&[a-z]*…/.test(p.text), 'no entity cut in half');
    }
  });

  test('a question with no options presented in a DM: the human\'s next DM reply is its answer; one such question per DM at a time', async () => {
    const { s, settle, bridge, core } = setup();
    const dm = (text: string, ts: string) => bridge.onMessage({ channel: `D${SLACK.alice}`, channelType: 'im', user: SLACK.alice, text, ts });
    const answers = (agent: 'scout' | 'builder') => s[agent].readInbox().filter((i) => i.type === 'human_answer').map((i) => [i.inbox_priority, i.body['ask_seq'], i.body['answer']]);
    const withButtons = s.scout.askHuman('alice', 'deploy?', ['yes', 'no']);
    core.presentAsk(withButtons.ask!, 'Deploy frontend tonight?');
    const first = s.scout.askHuman('alice', 'which box for the load test?');
    core.presentAsk(first.ask!, 'Which box should the load test run on?');
    const second = s.builder.askHuman('alice', 'what budget?');
    assert.equal(code(() => core.presentAsk(second.ask!, 'What budget for the new box?')), 'conflict', 'one open question without options per DM');
    assert.match((() => { try { core.presentAsk(second.ask!, 'x?'); } catch (err) { return String((err as Error).message); } return ''; })(),
      /already has an open question without options.*Wait until it is answered, or drop this one/);
    await settle();
    await dm('staging', '9.1');
    assert.deepEqual(answers('scout'), [['steer', first.seq, 'staging']]);
    core.presentAsk(second.ask!, 'What budget for the new box?');
    await dm('$80 a month', '9.2');
    await dm('thanks', '9.3');
    assert.deepEqual(answers('builder'), [['steer', second.seq, '$80 a month']]);
    assert.equal(core.events(withButtons.thread).filter((e) => e.type === 'human_answer').length, 2, 'a reply with nothing open answers nothing; buttons answer only by a button');
  });

  test('a DM reply answers an open question only when it is plainly an answer: not one to the ops agent, not after expiry, never empty or oversized', async () => {
    const { s, settle, bridge, core, clock } = setup();
    const dm = (text: string, ts: string) => bridge.onMessage({ channel: `D${SLACK.alice}`, channelType: 'im', user: SLACK.alice, text, ts });
    const answered = () => s.scout.readInbox().filter((i) => i.type === 'human_answer').map((i) => i.body['answer']);
    const asked = s.scout.askHuman('alice', 'which box?');
    core.presentAsk(asked.ask!, 'Which box should the load test run on?');
    await settle();
    await dm(`<@${SLACK.bot}> what's scheduled tonight?`, '8.1');
    await dm('', '8.2');                    // a file with no caption
    await dm('x'.repeat(16_001), '8.3');    // more than switchboard takes
    assert.deepEqual(answered(), [], 'none of those is the answer, and none throws');
    clock.advance(61);
    await dm('staging', '8.4');
    assert.deepEqual(answered(), [], 'presented more than ask_expiry_minutes ago: no longer open');
    const again = s.scout.askHuman('alice', 'which box, again?');
    core.presentAsk(again.ask!, 'Which box should the load test run on?');
    await dm('staging', '8.5');
    assert.deepEqual(answered(), ['staging']);
  });
  test('if Slack fails to update an answered question card, the answer is posted under it instead', async () => {
    const slack = new FakeSlack();
    slack.update = async () => { throw new Error('An API error occurred: message_not_found'); };
    const { s, settle, bridge, core } = setup('open', slack);
    const asked = s.scout.askHuman('alice', 'restart the gateway now?', ['yes', 'no']);
    core.presentAsk(asked.ask!, 'Bump the gateway now?');
    await settle();
    const card = slack.posts.find((p) => p.blocks)!;
    const yes = ((card.blocks![1] as { elements: Array<{ action_id: string; value: string }> }).elements)[0]!;
    await bridge.onAction({ actionId: yes.action_id, value: yes.value, user: SLACK.alice, channel: card.channel, messageTs: card.ts });
    assert.deepEqual(slack.posts.slice(1).map((p) => [p.threadTs, p.text]), [[card.ts, '*Alice answered: yes*']]);
    assert.deepEqual(s.scout.readInbox().filter((i) => i.type === 'human_answer')[0]!.body, { ask_seq: asked.seq, answer: 'yes', presented_as: 'Bump the gateway now?' }, 'the answer was recorded either way');
  });
});

describe('Bolt adapter', () => {
  test('a principal\'s message with a screenshot (subtype file_share) reaches the bridge; edits and bots don\'t', async () => {
    const listeners: Record<string, (a: { event: unknown }) => Promise<void>> = {};
    const app = { event: (name: string, fn: (a: { event: unknown }) => Promise<void>) => { listeners[name] = fn; }, action: () => {}, start: async () => {} };
    const bolt = Object.create(BoltSlack.prototype) as BoltSlack;
    Object.defineProperty(bolt, 'app', { value: app });
    const seen: InboundMessage[] = [];
    await bolt.start({ onMessage: async (m: InboundMessage) => { seen.push(m); } } as unknown as SlackBridge);
    const base = { channel: SLACK.ops, channel_type: 'channel', user: SLACK.alice, text: `<@${SLACK.bot}> what is this error?` };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['1.1', {}], ['1.2', { subtype: 'file_share', files: [{ id: 'F1', name: 'screenshot.png' }] }], ['1.3', { subtype: 'thread_broadcast', thread_ts: '1.0' }],
      ['1.4', { subtype: 'message_changed' }], ['1.5', { subtype: 'bot_message', bot_id: 'B1' }], ['1.6', { subtype: 'file_share', bot_id: 'B1' }],
    ];
    for (const [ts, extra] of cases) await listeners['message']!({ event: { ...base, ts, ...extra } });
    assert.deepEqual(seen.map((m) => m.ts), ['1.1', '1.2', '1.3']);
  });
});
