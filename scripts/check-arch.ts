// Mechanical invariants. Each failure says what rule broke and how to fix it, because the output is
// read by the next agent. Rules and rationale: ARCHITECTURE.md. Run: npm run check:arch

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

// Which src files each src file may import. A file missing here fails the check.
const LAYERS: Record<string, string[]> = {
  'config.ts': [],
  'db.ts': [],
  'wake.ts': ['core.ts'],
  'core.ts': ['db.ts', 'wake.ts'],
  'windows.ts': ['core.ts', 'db.ts'],
  'engines.ts': [],
  'status.ts': [],
  'context.ts': [],
  'agent-mcp.ts': ['core.ts', 'windows.ts'],
  'slack.ts': ['core.ts', 'windows.ts'],
  'ops-mcp.ts': ['agent-mcp.ts', 'context.ts', 'core.ts', 'status.ts', 'windows.ts'],
  'ops.ts': ['config.ts', 'core.ts', 'db.ts', 'engines.ts', 'ops-mcp.ts', 'windows.ts'],
  'main.ts': ['agent-mcp.ts', 'config.ts', 'context.ts', 'core.ts', 'db.ts', 'engines.ts', 'ops.ts', 'ops-mcp.ts', 'slack.ts', 'status.ts', 'windows.ts'],
  'cli.ts': ['config.ts', 'context.ts', 'core.ts', 'db.ts', 'main.ts', 'windows.ts'],
};

// The only places that may call these functions (besides their definition and tests).
const GUARDED_CALLS: Record<string, { allowed: string[]; why: string }> = {
  decideFromSlackButton: { allowed: ['src/windows.ts', 'src/slack.ts'], why: 'only the Slack button handler may approve or decline a window (P1, plan §9)' },
  decideStandingFromSlackButton: { allowed: ['src/windows.ts', 'src/slack.ts'], why: 'only the Slack button handler may approve, decline or revoke a standing approval (P1, P5)' },
  answerAsk: { allowed: ['src/core.ts', 'src/slack.ts'], why: 'only a Slack button press or reply is a human answer' },
  setSchedule: { allowed: ['src/windows.ts', 'src/ops-mcp.ts'], why: 'only the ops agent\'s set_maintenance_time, in a turn a human\'s own #ops message woke, may move the nightly slot and void every standing approval (P5)' },
  messageAgents: { allowed: ['src/core.ts', 'src/ops-mcp.ts'], why: 'only the ops agent\'s message_agents, in a turn the principal\'s own Slack message woke, may steer that principal\'s agents (P1)' },
  presentAsk: { allowed: ['src/core.ts', 'src/ops-mcp.ts'], why: 'only the ops agent\'s present_ask puts an agent\'s question to a human, in its words with the agent\'s options (P3)' },
  handleHumanItems: { allowed: ['src/core.ts', 'src/ops-mcp.ts'], why: 'only the ops agent\'s tell_human, respond and do_not_respond mark what agents wrote for humans as told or skipped (P3)' },
  skipAsk: { allowed: ['src/core.ts', 'src/ops-mcp.ts'], why: 'only the ops agent\'s do_not_respond drops an agent\'s question (P3)' },
  setDelegate: { allowed: ['src/core.ts', 'src/cli.ts'], why: 'only an operator names a principal\'s delegate, with the admin CLI (P4)' },
  setMute: { allowed: ['src/core.ts', 'src/cli.ts', 'scripts/e2e.ts'], why: 'mutes change only from the admin CLI; the ops agent changes the asking human\'s own side only through setOwnMute (P1)' },
  setOwnMute: { allowed: ['src/core.ts', 'src/ops-mcp.ts'], why: 'only the ops agent\'s set_my_mute, in a turn the human\'s own message woke, changes that human\'s side, with a notice in their DM (P1)' },
};

// agent-mcp.ts talks to the core only through these (everything else is behind AgentSession).
const AGENT_MCP_CORE_API = new Set(['authenticate', 'forAgent', 'audit', 'unread']);

const problems: string[] = [];
const fail = (msg: string): void => { problems.push(msg); };

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((f) => f && existsSync(f));
const text = (f: string): string => readFileSync(f, 'utf8');
const src = files.filter((f) => /^src\/[^/]+\.ts$/.test(f));

// 1. Layering.
for (const f of src) {
  const name = basename(f);
  const allowed = LAYERS[name];
  if (!allowed) { fail(`${f}: not in LAYERS. Add it to scripts/check-arch.ts and to the layer table in ARCHITECTURE.md.`); continue; }
  for (const m of text(f).matchAll(/from '\.\/([^']+)'/g)) {
    if (!allowed.includes(m[1]!)) fail(`${f} imports ./${m[1]}, which its layer may not use. Allowed: ${allowed.join(', ') || 'nothing internal'}. See ARCHITECTURE.md.`);
  }
}

// 2. Guarded calls.
for (const [fn, rule] of Object.entries(GUARDED_CALLS)) {
  for (const f of files.filter((x) => x.startsWith('src/') || x.startsWith('scripts/'))) {
    if (f === 'scripts/check-arch.ts' || rule.allowed.includes(f)) continue;
    if (new RegExp(`\\b${fn}\\b`).test(text(f))) fail(`${f} references ${fn}: ${rule.why}. Route it through ${rule.allowed.join(' or ')}.`);
  }
}

// 3. agent-mcp.ts reaches the core only through AgentSession.
if (existsSync('src/agent-mcp.ts')) {
  for (const m of text('src/agent-mcp.ts').matchAll(/deps\.core\.(\w+)/g)) {
    if (!AGENT_MCP_CORE_API.has(m[1]!)) fail(`src/agent-mcp.ts calls core.${m[1]} directly. Agent tools must go through AgentSession (core.forAgent) so plan §4 holds.`);
  }
}

// 4. Models: only the configured model id (P8). Checked everywhere we ship.
const shipped = files.filter((f) => /^(src|prompts|clients|scripts|test)\//.test(f) || ['config.example.yaml', '.env.example', 'docs/runbook.md', 'AGENTS.md'].includes(f));
for (const f of shipped) {
  if (f === 'scripts/check-arch.ts') continue;
  // A line may opt out only to prove the guard refuses a model: it must say so with this marker.
  const t = text(f).split('\n').filter((l) => !l.includes('check-arch: allow-model')).join('\n');
  for (const m of t.matchAll(/claude-[a-z]+-[0-9][0-9a-z-]*/g)) {
    if (m[0] !== 'claude-opus-5-5') fail(`${f}: model id ${m[0]}. Only claude-opus-5-5 is allowed (P8).`);
  }
  if (!f.endsWith('.md') && /\b(haiku|sonnet)\b/i.test(t)) fail(`${f}: mentions Haiku/Sonnet. No Haiku, Sonnet or pre-5.5 model anywhere (P8), not even for a gate.`);
}

// 5. Engine permission-bypass flags must never reach src (AGENTS.md rules).
for (const f of src) {
  for (const flag of ['bypassPermissions', 'dangerously-skip-permissions', 'danger-full-access', 'allow-dangerously']) {
    if (text(f).includes(flag)) fail(`${f}: contains '${flag}'. The ops engine runs with a strict allowlist; never add permission-bypass flags.`);
  }
}

// 6. Secrets (AGENTS.md rules). Fake ids in tests and examples use obviously fake shapes.
const SECRET = [/xox[abposr]-[0-9A-Za-z-]{10,}/, /xapp-[0-9]-[A-Za-z0-9-]{10,}/, /sk-ant-[A-Za-z0-9_-]{10,}/, /sk-[A-Za-z0-9]{32,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsb_[A-Za-z0-9_-]{43}\b/];
for (const f of files) {
  if (f.startsWith('node_modules/') || f === 'package-lock.json' || f === 'scripts/check-arch.ts') continue;
  const t = text(f);
  for (const re of SECRET) if (re.test(t)) fail(`${f}: looks like a secret (${re}). Secrets come from the environment only; see .env.example.`);
}

// 7. Docs route to every file: each src file is named in a design doc, each design doc is in the index.
const designDocs = files.filter((f) => /^docs\/design\/[^/]+\.md$/.test(f) && !f.endsWith('index.md'));
const index = existsSync('docs/design/index.md') ? text('docs/design/index.md') : '';
if (!index) fail('docs/design/index.md is missing. It routes agents to component docs.');
for (const d of designDocs) if (!index.includes(basename(d))) fail(`${d} is not linked from docs/design/index.md.`);
const designText = designDocs.map(text).join('\n');
for (const f of src) if (!designText.includes(f)) fail(`${f} is not listed under "Implementation files" in any docs/design/*.md. Add it to its component doc.`);

// 8. Principle ids (P1, P2, ...) cite docs/design-principles.md, so each must be defined there.
const principles = new Set([...(existsSync('docs/design-principles.md') ? text('docs/design-principles.md') : '').matchAll(/^## (P\d+)\./gm)].map((m) => m[1]));
for (const f of files) {
  if (f === 'package-lock.json' || f === 'scripts/check-arch.ts') continue;
  for (const id of new Set(text(f).match(/\bP\d+\b/g) ?? [])) {
    if (!principles.has(id)) fail(`${f}: cites ${id}, which docs/design-principles.md doesn't define. Cite an existing principle, or add it there.`);
  }
}

if (problems.length) {
  console.error(`check-arch: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`check-arch: ok (${src.length} src files, ${designDocs.length} design docs, ${files.length} files scanned)`);
