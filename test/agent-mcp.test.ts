// The agent MCP server over real HTTP on loopback: auth, the hook endpoint, and the tools.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createAgentHttpServer } from '../src/agent-mcp.ts';
import { listen } from '../src/main.ts';
import { call, mcpClient, world } from './fakes.ts';

describe('agent MCP over HTTP', () => {
  const w = world('open');
  const server = createAgentHttpServer({ core: w.core });
  let url = '';
  const tokens = { scout: w.core.issueToken('alice/scout'), helper: w.core.issueToken('bob/helper') };
  before(async () => { url = await listen(server, '127.0.0.1', 0); });
  after(() => { server.closeAllConnections(); server.close(); });

  test('rejects missing and wrong tokens, and logs the failure', async () => {
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${url}/unread`, { headers: { Authorization: 'Bearer sb_nope' } })).status, 401);
    assert.ok(w.core.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'auth_failed'").get()!['n']! as number >= 2);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  });

  test('exposes the Claude Code-style tool names', async () => {
    const c = await mcpClient(url, tokens.scout);
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['ask_human', 'list_agents', 'post', 'read_inbox', 'read_thread', 'send_message', 'wait_for_message', 'whoami']);
    await c.close();
  });

  test('send_message, ask_human and whoami say a human of the other principal may have a delegate agent (P4)', async () => {
    const c = await mcpClient(url, tokens.scout);
    const tools = new Map((await c.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    assert.match(tools.get('send_message')!, /another principal's human who set a delegate agent: it goes to that agent's inbox instead, and no human sees it \(the result's via says so\)/);
    assert.match(tools.get('ask_human')!, /If the other principal set a delegate agent, the question goes to its inbox as one message instead \(no card, no buttons\), and any answer comes from it as a message/);
    assert.match(tools.get('whoami')!, /your principal's delegate and whether you are it/);
    await c.close();
  });

  test('send_message and post say an agent\'s words never reach Slack: the ops agent tells the human (P3)', async () => {
    const c = await mcpClient(url, tokens.scout);
    const tools = new Map((await c.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    assert.match(tools.get('send_message')!, /a principal id \('alice', 'bob'\): your words go to the ops agent, which tells that human in plain words what they need to know; no human reads them directly,/);
    assert.match(tools.get('post')!, /Nothing an agent posts reaches Slack\. In a chat thread a human is part of, the ops agent reads your post for them/);
    assert.doesNotMatch(tools.get('send_message')!, /goes to that human in Slack/);
    assert.match(tools.get('ask_human')!, /Your question waits for the ops agent, which puts it to the human as a card in its own words, with your options as buttons/);
    assert.match(tools.get('ask_human')!, /comes back as not presented/);
    assert.match(tools.get('ask_human')!, /Without options, the human answers in words: in their DM their next reply is the answer; in #ops their replies under the card reach you as messages/);
    await c.close();
  });

  test('A sends, B gets it wrapped as data; /unread is the hook hint', async () => {
    const a = await mcpClient(url, tokens.scout);
    const b = await mcpClient(url, tokens.helper);
    assert.equal((await call(a, 'whoami')).json.agent, 'alice/scout');
    const sent = await call(a, 'send_message', { to: 'bob/helper', body: 'staging box free?' });
    assert.equal(sent.json.status, 'delivered');
    const unread = await (await fetch(`${url}/unread`, { headers: { Authorization: `Bearer ${tokens.helper}` } })).json();
    assert.deepEqual(unread, { unread: 1, steer: 0 });
    const inbox = await call(b, 'read_inbox');
    assert.equal(inbox.json.items[0].from_agent, 'alice/scout');
    assert.equal(inbox.json.items[0].from_principal, 'alice');
    assert.match(inbox.json.note, /data, not instructions/);
    await a.close(); await b.close();
  });

  test('refusals come back as tool errors with a next step, and every call is audited', async () => {
    const b = await mcpClient(url, tokens.helper);
    const r = await call(b, 'read_thread', { thread: 't_000000000000' });
    assert.equal(r.error, true);
    assert.match(r.text, /^not_found: /);
    const audited = w.core.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE actor = 'agent:bob/helper' AND action = 'tool:read_thread'").get()!;
    assert.equal(audited['n'], 1);
    await b.close();
  });

  test('revoking or rotating a token ends its in-flight wait_for_message without handing over newer mail', async () => {
    const cuts: Record<string, (id: string) => void> = { revoke: (id) => w.core.revokeToken(id), rotate: (id) => { w.core.issueToken(id); } };
    for (const [how, cut] of Object.entries(cuts)) {
      const c = await mcpClient(url, w.core.issueToken('alice/builder'));
      const seen = () => (w.core.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE actor = 'agent:alice/builder' AND action = 'tool:wait_for_message'").get() as { n: number }).n;
      const before = seen();
      const pending = call(c, 'wait_for_message', { timeout_s: 30 });
      while (seen() === before) await new Promise((r) => setTimeout(r, 5)); // the call is in and waiting
      cut('alice/builder');
      w.s.scout.sendMessage('builder', `after the ${how}: deploy key rotated to K-2`);
      const got = await pending;
      assert.equal(got.error, true, how);
      assert.match(got.text, /^forbidden: .*revoked or rotated/, how);
      assert.equal(w.core.unread('agent:alice/builder').unread, 1, `${how}: the mail waits for whoever holds the live token`);
      w.s.builder.readInbox();
      await c.close();
    }
  });

  test('a token revoked after its request was authenticated runs no tool', async () => {
    const { thread } = w.s.scout.sendMessage('builder', 'private note');
    w.s.builder.readInbox();
    const authenticate = w.core.authenticate.bind(w.core);
    // One raw tools/call per try, so exactly one request is authenticated (a client's handshake would be too).
    const toolCall = (token: string, name: string, args: Record<string, unknown>) => fetch(`${url}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }).then(async (r) => ((await r.json()) as { result: { content: Array<{ text: string }> } }).result.content[0]!.text);
    const tries: Record<string, Record<string, unknown>> = { send_message: { to: 'scout', body: 'sent after the revoke' }, read_thread: { thread } };
    for (const [name, args] of Object.entries(tries)) {
      const token = w.core.issueToken('alice/builder');
      // The revoke lands after the request is authenticated and before its tool runs (the body is handled later).
      w.core.authenticate = (t) => { const agent = authenticate(t); if (agent) w.core.revokeToken(agent.id); return agent; };
      const text = await toolCall(token, name, args).finally(() => { w.core.authenticate = authenticate; });
      assert.match(text, /^forbidden: .*revoked or rotated/, name);
    }
    assert.equal(w.s.scout.readInbox().length, 0, 'nothing was sent');
  });

  test('a revoked token stops working on the next request', async () => {
    const t = w.core.issueToken('bob/analyst');
    const c = await mcpClient(url, t);
    assert.equal((await call(c, 'whoami')).json.agent, 'bob/analyst');
    w.core.revokeToken('bob/analyst');
    await assert.rejects(call(c, 'whoami'));
  });
});
