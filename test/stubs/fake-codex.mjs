#!/usr/bin/env node
// Stands in for `codex app-server`: newline JSON-RPC on stdio. Records every message it receives into
// $HOME/codex-record.jsonl. $HOME/codex-mode = 'fail' makes turns fail.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = process.env.HOME;
const mode = existsSync(join(home, 'codex-mode')) ? readFileSync(join(home, 'codex-mode'), 'utf8').trim() : 'ok';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync(join(home, 'codex-record.jsonl'), line + '\n');
  if (msg.method === 'initialize') send({ id: msg.id, result: { userAgent: 'fake' } });
  else if (msg.method === 'thread/start') send({ id: msg.id, result: { thread: { id: 'th_new' } } });
  else if (msg.method === 'thread/resume') {
    if (msg.params.threadId === 'stale') send({ id: msg.id, error: { code: 1, message: 'no rollout found' } });
    else send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
  } else if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'tu_1' } } });
    send({ id: 500, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf /' } });
    if (mode === 'fail') send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'usage limit reached' } } } });
  } else if (msg.id === 500 && mode !== 'fail') {
    // finish only after the engine answered the approval request, so the record always holds that answer
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'codex says hi' } } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  }
});
