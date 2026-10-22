// Engines, in the order the ops agent prefers them (P7): the Claude Agent SDK on an Anthropic API key, then
// `claude -p` on a Claude subscription token, then `codex app-server` (failover). All run Claude Code / Codex as a
// subprocess with the same tools: the ops MCP server plus read-only files in the context dir. No shell, no web, no
// writes, no permission-bypass flags. Claude runs only the configured model (P8). Contract: docs/design/ops-agent.md.

import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const OPS_MODEL = 'claude-opus-5-5';
export const MCP_SERVER_NAME = 'switchboard-ops';

export interface TurnRequest {
  /** The engine's own session/thread id for this switchboard thread, or null to start fresh. */
  session: string | null;
  prompt: string;
  systemPrompt: string;
  mcp: { url: string; token: string };
  /** The context dir: read-only checkouts and memory. The engine's only filesystem view. */
  cwd: string;
}
export interface TurnResult { session: string; text: string; costUsd?: number }

export interface Engine {
  readonly kind: string;
  turn(req: TurnRequest): Promise<TurnResult>;
  /** A cheap call that succeeds only if the engine can take turns again (used to switch back). */
  probe(): Promise<void>;
}

// Quota/limit wording from both CLIs.
export const QUOTA = /usage limit|session limit|weekly limit|hit your .*limit|rate limit|quota|too many requests|\b429\b|limit reached|out of credits|credit balance/i;

// "Your credit balance is too low to access the Anthropic API": the API credits are spent for this cycle.
export const CREDITS = /credit balance is too low|credit balance too low/i;

export class EngineError extends Error {
  quota: boolean;
  /** API credits used up: they come back with the next billing cycle, not at a known hour. */
  credits: boolean;
  resetAt: Date | null;
  constructor(message: string, now: Date = new Date()) {
    super(message);
    this.name = 'EngineError';
    this.credits = CREDITS.test(message);
    this.quota = this.credits || QUOTA.test(message);
    this.resetAt = this.quota && !this.credits ? parseResetAt(message, now) : null;
  }
}

/** The engine no longer has the saved session (pruned transcripts, wiped HOME). The caller starts over with a fresh prompt. */
export class SessionLostError extends EngineError {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLostError';
  }
}

/** Finds when a limit resets: an epoch after '|' (older CLI), or "resets 3pm" / "resets at 15:30" (UTC). */
export function parseResetAt(message: string, now: Date): Date | null {
  const epoch = /\|(\d{10})\b/.exec(message);
  if (epoch) return new Date(Number(epoch[1]) * 1000);
  const m = /resets?(?: at)? (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(message);
  if (!m) return null;
  let hour = Number(m[1]) % 24;
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, Number(m[2] ?? 0)));
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/**
 * The ops MCP server's config, bearer token included, as a 0600 file in a private dir. Its path goes on
 * the command line instead of the JSON: any local user can read a process's argv in /proc/<pid>/cmdline.
 * The caller deletes it after the turn.
 */
function writeMcpConfig(runDir: string, mcp: TurnRequest['mcp']): string {
  const path = join(runDir, `mcp-${randomBytes(8).toString('hex')}.json`);
  writeFileSync(path, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }), { mode: 0o600 });
  return path;
}

/** A clean environment: the engine never inherits Slack or other service secrets. */
export function engineEnv(extra: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'LANG', 'TZ']) if (process.env[k]) env[k] = process.env[k]!;
  for (const [k, v] of Object.entries(extra)) if (v) env[k] = v;
  return env;
}

// ---- Claude Code ----

export const CLAUDE_TOOLS = ['Read', 'Grep', 'Glob'];
export const CLAUDE_DENIED = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'];

export interface ClaudeOptions {
  bin?: string;
  model?: string;
  effort?: string;
  /** Private dir for per-turn MCP config files (0700). */
  runDir: string;
  /** HOME for the CLI: where it keeps sessions. Outside the context dir, so Read can't reach transcripts. */
  home: string;
  oauthToken?: string | undefined;
  timeoutMs?: number;
}

/** The exact argv. Tested: the allowlist is the whole point. The prompt itself goes on stdin (see run). */
export function claudeArgs(o: { session: string; fresh: boolean; model: string; effort: string; systemPrompt: string; mcpConfigPath: string }): string[] {
  return [
    '-p',
    '--output-format', 'stream-json', '--verbose',
    '--model', o.model, '--effort', o.effort,
    o.fresh ? '--session-id' : '--resume', o.session,
    '--system-prompt', o.systemPrompt,
    // --restricted: no command-running tools, no settings files, file tools confined to the cwd.
    '--restricted',
    '--strict-mcp-config', '--mcp-config', o.mcpConfigPath,
    '--tools', CLAUDE_TOOLS.join(','),
    '--allowedTools', [`mcp__${MCP_SERVER_NAME}`, ...CLAUDE_TOOLS].join(','),
    '--disallowedTools', CLAUDE_DENIED.join(','),
    '--permission-mode', 'dontAsk',
  ];
}

export class ClaudeEngine implements Engine {
  readonly kind = 'claude';
  readonly o: Required<Omit<ClaudeOptions, 'oauthToken'>> & { oauthToken?: string | undefined };

  constructor(options: ClaudeOptions) {
    const model = options.model ?? OPS_MODEL;
    if (model !== OPS_MODEL) throw new Error(`ops engine model must be ${OPS_MODEL}, the configured model, got ${model}`);
    this.o = { bin: 'claude', effort: 'high', timeoutMs: 15 * 60_000, ...options, model };
    mkdirSync(this.o.runDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.o.home, { recursive: true, mode: 0o700 });
  }

  private env(): Record<string, string> {
    return engineEnv({ HOME: this.o.home, CLAUDE_CODE_OAUTH_TOKEN: this.o.oauthToken });
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const fresh = req.session === null;
    const session = req.session ?? randomUUID();
    const mcpConfigPath = writeMcpConfig(this.o.runDir, req.mcp);
    try {
      const args = claudeArgs({ session, fresh, model: this.o.model, effort: this.o.effort, systemPrompt: req.systemPrompt, mcpConfigPath });
      const { result, tail, code } = await this.run(args, req.cwd, req.prompt);
      if (!result || result['is_error']) {
        const message = String(result?.['result'] ?? '') || tail.join(' ') || `claude exited ${code}`;
        if (!fresh && /no conversation found/i.test(message)) throw new SessionLostError(message);
        throw new EngineError(message);
      }
      return { session: String(result['session_id'] ?? session), text: String(result['result'] ?? '') };
    } finally {
      rmSync(mcpConfigPath, { force: true });
    }
  }

  async probe(): Promise<void> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', this.o.model,
      '--restricted', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk'];
    const { result, tail, code } = await this.run(args, this.o.runDir, 'Reply with the single word OK.');
    if (!result || result['is_error']) throw new EngineError(String(result?.['result'] ?? '') || tail.join(' ') || `claude exited ${code}`);
  }

  private run(args: string[], cwd: string, prompt: string): Promise<{ result: Record<string, unknown> | null; tail: string[]; code: number | null }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.o.bin, args, { cwd, env: this.env(), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        // Some spawn failures (E2BIG, …) throw instead of emitting 'error'. They are this engine failing, not a bug.
        reject(new EngineError(`can't run ${this.o.bin}: ${(err as Error).message}`));
        return;
      }
      // On stdin, not argv: a thread's prompt can outgrow Linux's 128 KiB limit on one argv string.
      child.stdin.on('error', () => {}); // the CLI may exit before reading it all; its exit code and output say why
      child.stdin.end(prompt);
      let result: Record<string, unknown> | null = null;
      let tail: string[] = [];
      const keep = (line: string) => { if (line.trim()) tail = [...tail, line.trim().slice(0, 500)].slice(-5); };
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event['type'] === 'result') result = event;
        } catch { keep(line); }
      });
      createInterface({ input: child.stderr }).on('line', keep);
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new EngineError(`claude turn timed out after ${this.o.timeoutMs / 1000}s`)); }, this.o.timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); reject(new EngineError(`can't run ${this.o.bin}: ${err.message}`)); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ result, tail, code }); });
    });
  }
}

// ---- Claude Agent SDK on API credits (primary, P7) ----

export interface ClaudeSdkOptions {
  /** An Anthropic Console API key; its credits pay for this engine's turns. */
  apiKey: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** HOME for the SDK's Claude Code process: where sessions live. Outside the context dir. */
  home: string;
  /** Private dir for per-turn MCP config files (0700). */
  runDir: string;
  timeoutMs?: number;
  /** Test seam: the SDK's query(), narrowed to what run() uses. */
  query?: QueryFn;
}

export type QueryFn = (p: { prompt: string; options?: Options }) => AsyncIterable<{ type: string }>;

/**
 * The same confinement as claudeArgs, through the SDK's options: Read/Grep/Glob plus the ops MCP server,
 * no settings files, no other MCP servers, dontAsk, --restricted, and an env that holds only the API key.
 * The MCP server comes from a 0600 file (writeMcpConfig), not `mcpServers`, which the SDK puts in argv.
 */
export function claudeSdkOptions(o: { req: TurnRequest; model: string; effort: string; home: string; apiKey: string; mcpConfigPath: string; abort: AbortController }) {
  return {
    model: o.model,
    effort: o.effort as 'high',
    systemPrompt: o.req.systemPrompt,
    cwd: o.req.cwd,
    tools: CLAUDE_TOOLS,
    allowedTools: [`mcp__${MCP_SERVER_NAME}`, ...CLAUDE_TOOLS],
    disallowedTools: CLAUDE_DENIED,
    permissionMode: 'dontAsk' as const,
    permissionPrompts: 'none' as const,
    settingSources: [],
    strictMcpConfig: true,
    extraArgs: { restricted: null, 'mcp-config': o.mcpConfigPath },
    env: engineEnv({ HOME: o.home, ANTHROPIC_API_KEY: o.apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: 'switchboard/0.1.0' }),
    abortController: o.abort,
    ...(o.req.session ? { resume: o.req.session } : {}),
  };
}

export class ClaudeSdkEngine implements Engine {
  readonly kind = 'claude-api';
  readonly o: Required<Omit<ClaudeSdkOptions, 'query'>> & { query: QueryFn };

  constructor(options: ClaudeSdkOptions) {
    const model = options.model ?? OPS_MODEL;
    if (model !== OPS_MODEL) throw new Error(`ops engine model must be ${OPS_MODEL}, the configured model, got ${model}`);
    this.o = { effort: 'high', timeoutMs: 15 * 60_000, query, ...options, model };
    mkdirSync(this.o.home, { recursive: true, mode: 0o700 });
    mkdirSync(this.o.runDir, { recursive: true, mode: 0o700 });
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const abort = new AbortController();
    const mcpConfigPath = writeMcpConfig(this.o.runDir, req.mcp);
    try {
      const result = await this.run(req.prompt, claudeSdkOptions({ req, model: this.o.model, effort: this.o.effort, home: this.o.home, apiKey: this.o.apiKey, mcpConfigPath, abort }), abort);
      return { session: String(result['session_id']), text: String(result['result'] ?? ''), costUsd: Number(result['total_cost_usd'] ?? 0) };
    } catch (err) {
      if (req.session && err instanceof EngineError && /no conversation found/i.test(err.message)) throw new SessionLostError(err.message);
      throw err;
    } finally {
      rmSync(mcpConfigPath, { force: true });
    }
  }

  /** A one-word request with no tools: succeeds only if the key, credits and model all work. */
  async probe(): Promise<void> {
    const abort = new AbortController();
    await this.run('Reply with the single word OK.', {
      model: this.o.model, effort: 'low', cwd: this.o.home, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {},
      permissionMode: 'dontAsk', persistSession: false, maxTurns: 1, abortController: abort,
      env: engineEnv({ HOME: this.o.home, ANTHROPIC_API_KEY: this.o.apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: 'switchboard/0.1.0' }),
    }, abort);
  }

  private async run(prompt: string, options: Options, abort: AbortController): Promise<Record<string, unknown>> {
    const timer = setTimeout(() => abort.abort(), this.o.timeoutMs);
    let result: Record<string, unknown> | null = null;
    try {
      for await (const m of this.o.query({ prompt, options })) {
        if (m.type === 'result') result = m as Record<string, unknown>;
      }
    } catch (err) {
      if (abort.signal.aborted) throw new EngineError(`claude sdk turn timed out after ${this.o.timeoutMs / 1000}s`);
      throw new EngineError((err as Error)?.message ?? String(err));
    } finally {
      clearTimeout(timer);
    }
    if (!result || result['is_error'] || result['subtype'] !== 'success') {
      const errors = Array.isArray(result?.['errors']) ? (result['errors'] as string[]).join(' ') : '';
      throw new EngineError(String(result?.['result'] ?? '') || errors || 'claude sdk turn ended without a result');
    }
    return result;
  }
}

// ---- Codex (failover) ----

export interface CodexOptions {
  bin?: string;
  model?: string | undefined;
  effort?: string | undefined;
  /** CODEX_HOME holding the ChatGPT-plan login (`codex login --device-auth`). */
  codexHome: string;
  home: string;
  timeoutMs?: number;
}

type Json = Record<string, any>;

/** Newline JSON-RPC over a subprocess: the app-server wire format. */
class Rpc {
  private nextId = 0;
  private waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  readonly child: ReturnType<typeof spawn>;
  onNotify: (method: string, params: Json) => void = () => {};

  constructor(child: ReturnType<typeof spawn>) {
    this.child = child;
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let msg: Json;
      try { msg = JSON.parse(line) as Json; } catch { return; }
      if ('method' in msg && 'id' in msg) {
        // Server-initiated request. approvalPolicy=never means none should come; anything that does is declined.
        const reply = String(msg['method']).endsWith('requestApproval') ? { result: { decision: 'decline' } } : { error: { code: -32601, message: 'not supported by switchboard' } };
        this.send({ id: msg['id'], ...reply });
      } else if ('method' in msg) {
        this.onNotify(String(msg['method']), (msg['params'] as Json) ?? {});
      } else {
        const waiter = this.waiting.get(msg['id'] as number);
        if (!waiter) return;
        this.waiting.delete(msg['id'] as number);
        if (msg['error']) waiter.reject(new EngineError(String(msg['error'].message ?? JSON.stringify(msg['error']))));
        else waiter.resolve((msg['result'] as Json) ?? {});
      }
    });
    child.on('close', () => {
      for (const w of this.waiting.values()) w.reject(new EngineError('codex app-server exited'));
      this.waiting.clear();
      this.onNotify('_exit', {});
    });
  }

  send(msg: Json): void { this.child.stdin!.write(`${JSON.stringify(msg)}\n`); }

  request(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
}

export class CodexEngine implements Engine {
  readonly kind = 'codex';
  readonly o: Required<Omit<CodexOptions, 'model' | 'effort'>> & { model?: string | undefined; effort?: string | undefined };

  constructor(options: CodexOptions) {
    this.o = { bin: 'codex', timeoutMs: 15 * 60_000, ...options };
  }

  /** One app-server per turn: the MCP token is per turn, and a fresh process can't carry stale state. */
  private async start(cwd: string): Promise<Rpc> {
    const child = spawn(this.o.bin, ['app-server'], { cwd, env: engineEnv({ HOME: this.o.home, CODEX_HOME: this.o.codexHome }), stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (err) => reject(new EngineError(`can't run ${this.o.bin}: ${err.message}`)));
    });
    const rpc = new Rpc(child);
    await rpc.request('initialize', { clientInfo: { name: 'switchboard', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized' });
    return rpc;
  }

  /** Thread settings: read-only sandbox, no approvals, no shell or web; the ops MCP server for a turn, none for a probe. */
  threadOptions(cwd: string, mcp?: TurnRequest['mcp']): Json {
    return {
      cwd,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ...(this.o.model ? { model: this.o.model } : {}),
      config: {
        ...(mcp ? { mcp_servers: { [MCP_SERVER_NAME]: { url: mcp.url, http_headers: { Authorization: `Bearer ${mcp.token}` }, default_tools_approval_mode: 'approve' } } } : {}),
        features: { shell_tool: false, web_search_request: false, apps: false, multi_agent: false },
        web_search: 'disabled',
      },
    };
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const rpc = await this.start(req.cwd);
    const timer = setTimeout(() => rpc.child.kill('SIGKILL'), this.o.timeoutMs);
    try {
      let started: Json | null = null;
      if (req.session) {
        try {
          started = await rpc.request('thread/resume', { ...this.threadOptions(req.cwd, req.mcp), threadId: req.session, excludeTurns: true });
        } catch (err) {
          if (rpc.child.exitCode !== null) throw err;
          // Stale thread. The prompt holds only what is new since it, so the caller re-renders the whole thread.
          throw new SessionLostError(`codex thread ${req.session} can't be resumed: ${(err as Error).message}`);
        }
      }
      const fresh = !started;
      if (!started) started = await rpc.request('thread/start', this.threadOptions(req.cwd, req.mcp));
      const threadId = String(started['thread']?.id);
      const text = fresh ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt; // app-server has no system prompt slot we rely on
      return { session: threadId, text: await this.runTurn(rpc, threadId, text) };
    } finally {
      clearTimeout(timer);
      rpc.child.kill();
    }
  }

  /** Runs one turn on a started thread and resolves with the agent's last message. */
  private async runTurn(rpc: Rpc, threadId: string, text: string): Promise<string> {
    let answer = '';
    const done = new Promise<string>((resolve, reject) => {
      rpc.onNotify = (method, params) => {
        if (method === 'item/completed' && params['item']?.type === 'agentMessage') answer = String(params['item'].text ?? answer);
        else if (method === 'turn/completed') {
          const turn = params['turn'] ?? {};
          if (turn.status === 'completed') resolve(answer);
          else reject(new EngineError(`codex turn ${turn.status}: ${turn.error?.message ?? JSON.stringify(turn.error ?? {})}`));
        } else if (method === 'error' && !params['willRetry']) reject(new EngineError(String(params['error']?.message ?? 'codex error')));
        else if (method === '_exit') reject(new EngineError('codex app-server exited mid-turn'));
      };
    });
    done.catch(() => {}); // if turn/start itself fails, that error is the one thrown; this one must not go unhandled
    await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }], ...(this.o.effort ? { effort: this.o.effort } : {}) });
    return await done;
  }

  /**
   * A one-word turn with no tools: succeeds only if the login, the plan's limits and the model all work.
   * The ops agent asks this to tell an engine that is down from one thread failing (ops.ts withEngine).
   */
  async probe(): Promise<void> {
    const rpc = await this.start(this.o.home);
    const timer = setTimeout(() => rpc.child.kill('SIGKILL'), this.o.timeoutMs);
    try {
      const started = await rpc.request('thread/start', this.threadOptions(this.o.home));
      await this.runTurn(rpc, String(started['thread']?.id), 'Reply with the single word OK.');
    } finally {
      clearTimeout(timer);
      rpc.child.kill();
    }
  }
}
