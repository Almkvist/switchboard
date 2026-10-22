// Config: a YAML file (path from SWITCHBOARD_CONFIG or --config) for shape, the environment for
// secrets. Secrets never live in the YAML. Contract: docs/design/service.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

const Schema = z.object({
  listen: z.object({
    host: z.string().min(1),
    port: z.number().int().min(0).max(65535), // 0 = any free port (tests)
  }),
  data_dir: z.string().min(1),
  research_lane_default: z.enum(['deny', 'relayed_only', 'open']).default('deny'),
  slack: z.object({
    ops_channel: z.string().regex(/^[CG][A-Z0-9]+$/, 'a Slack channel id like C0123ABCD'),
  }),
  idle_ping_minutes: z.number().int().min(1).default(30),
  // P4: replies in a thread where an agent wrote to the other side's agents reach it past its mute for this long.
  solicited_reply_hours: z.number().int().min(1).default(24),
  // P3: an ask_human the ops agent hasn't presented by then expires, and the asking agent is told "not presented".
  ask_expiry_minutes: z.number().int().min(1).default(60),
  window_grace_minutes: z.number().int().min(0).default(30),
  // window_remind_minutes is gone (urgent windows send no T-10 reminder); an old config that still sets it parses fine.
  // P5: the nightly maintenance slot (UTC). Seeds the DB once; after that the ops agent sets it (set_maintenance_time).
  maintenance: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, UTC'),
    duration_minutes: z.number().int().min(1).max(720),
  }).default({ start: '21:00', duration_minutes: 120 }),
  resources: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,63}$/),
    name: z.string().min(1),
    owners: z.array(z.string().min(1)).min(1),
    approvers: z.array(z.string().min(1)).min(1).optional(),
    require: z.enum(['any', 'all']).default('any'),
    max_duration_minutes: z.number().int().min(1).max(24 * 60).default(120),
    note: z.string().optional(),
  })).default([]).refine((rs) => new Set(rs.map((r) => r.id)).size === rs.length, 'resource ids must be unique'),
  // M3. Without this section the service runs without the ops agent (M1/M2 behaviour).
  ops: z.object({
    mcp_port: z.number().int().min(0).max(65535).default(7421), // loopback only
    model: z.literal('claude-opus-5-5').default('claude-opus-5-5'), // P8: the only model allowed
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    // Order of preference (P7): Claude on an API key's credits, the Claude subscription, Codex.
    engines: z.array(z.enum(['claude-api', 'claude', 'codex'])).min(1).default(['claude-api', 'claude', 'codex'])
      .refine((e) => new Set(e).size === e.length, 'each engine at most once'),
    claude_bin: z.string().default('claude'),
    codex: z.object({ bin: z.string().default('codex'), model: z.string().optional(), effort: z.string().optional() }).default({ bin: 'codex' }),
    failover_after_errors: z.number().int().min(1).default(3),
    turn_timeout_minutes: z.number().int().min(1).default(15),
    max_concurrent_turns: z.number().int().min(1).default(2),
    memory_seed_dir: z.string().optional(),
    context: z.object({
      refresh_minutes: z.number().int().min(1).default(10),
      repos: z.array(z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), url: z.string().min(1), branch: z.string().default('main') })).default([]),
    }).default({ refresh_minutes: 10, repos: [] }),
  }).optional(),
});

export type Config = z.infer<typeof Schema> & { path: string };

export interface Secrets {
  slackBotToken?: string | undefined;
  slackAppToken?: string | undefined;
  anthropicApiKey?: string | undefined;
  claudeOauthToken?: string | undefined;
  codexHome?: string | undefined;
  deployKeyPath?: string | undefined;
}

export function loadConfig(path = process.env['SWITCHBOARD_CONFIG'] ?? 'config.yaml'): Config {
  const full = resolve(path);
  let raw: unknown;
  try {
    raw = parse(readFileSync(full, 'utf8'));
  } catch (err) {
    throw new Error(`can't read config ${full}: ${(err as Error).message}. Copy config.example.yaml and edit it.`);
  }
  return parseConfig(raw, full);
}

export function parseConfig(raw: unknown, path = '<inline>'): Config {
  const result = Schema.safeParse(raw);
  if (!result.success) throw new Error(`invalid config ${path}:\n${z.prettifyError(result.error)}`);
  return { ...result.data, path };
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  return {
    slackBotToken: env['SLACK_BOT_TOKEN'] || undefined,
    slackAppToken: env['SLACK_APP_TOKEN'] || undefined,
    anthropicApiKey: env['ANTHROPIC_API_KEY'] || undefined,
    claudeOauthToken: env['CLAUDE_CODE_OAUTH_TOKEN'] || undefined,
    codexHome: env['CODEX_HOME'] || undefined,
    deployKeyPath: env['CONTEXT_DEPLOY_KEY_PATH'] || undefined,
  };
}
