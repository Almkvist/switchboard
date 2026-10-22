#!/usr/bin/env node
// Stands in for the `claude` CLI. Records argv, env and the MCP config it was given into $HOME, then
// prints stream-json like `claude -p --output-format stream-json`. $HOME/mode picks the behaviour.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME;
const args = process.argv.slice(2);
const mode = existsSync(join(home, 'mode')) ? readFileSync(join(home, 'mode'), 'utf8').trim() : 'ok';
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const mcpPath = flag('--mcp-config');
// `claude -p` reads the prompt from stdin; the Agent SDK instead keeps stdin open for stream-json.
const stdin = flag('--input-format') === 'stream-json' ? null : readFileSync(0, 'utf8');
const record = {
  args, stdin, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(),
  mcp: !mcpPath ? null : mcpPath.startsWith('{') ? { inline: JSON.parse(mcpPath) }
    : { content: JSON.parse(readFileSync(mcpPath, 'utf8')), mode: (statSync(mcpPath).mode & 0o777).toString(8), path: mcpPath },
};
writeFileSync(join(home, `record-${Date.now()}-${Math.random()}.json`), JSON.stringify(record));
const session = flag('--resume') ?? flag('--session-id') ?? 'probe';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: session });
if (mode === 'quota') { out({ type: 'result', is_error: true, result: "You've hit your usage limit · resets 3pm (UTC)", session_id: session }); process.exit(1); }
if (mode === 'noconv' && flag('--resume')) { out({ type: 'result', is_error: true, result: `No conversation found with session ID: ${session}` }); process.exit(1); }
if (mode === 'crash') { process.stderr.write('segfault-ish\n'); process.exit(3); }
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'scratch' }] } });
out({ type: 'result', is_error: false, result: 'done', session_id: session });
