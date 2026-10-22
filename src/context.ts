// What the ops agent knows (plan §8): read-only git checkouts of the context repos, refreshed on a loop
// with a read-only deploy key, and the ops memory, a git dir of markdown the agent can propose edits to.
// Both live under one context dir, the engine's only filesystem view. Contract: docs/design/ops-agent.md.

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface RepoSpec { name: string; url: string; branch: string }

async function git(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: options.cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/nonexistent', GIT_TERMINAL_PROMPT: '0', ...options.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export class ContextRepos {
  readonly dir: string;
  readonly repos: RepoSpec[];
  readonly deployKeyPath: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: { dir: string; repos: RepoSpec[]; deployKeyPath?: string | undefined }) {
    this.dir = options.dir;
    this.repos = options.repos;
    this.deployKeyPath = options.deployKeyPath;
    for (const r of this.repos) if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(r.name)) throw new Error(`context repo name '${r.name}' must be a plain directory name`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private env(): Record<string, string> {
    return this.deployKeyPath
      ? { GIT_SSH_COMMAND: `ssh -i ${this.deployKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes` }
      : {};
  }

  /** Clones or hard-resets each repo to origin/<branch>. Never pushes; local edits don't survive. */
  async syncOnce(): Promise<Array<{ name: string; head?: string; error?: string }>> {
    const out: Array<{ name: string; head?: string; error?: string }> = [];
    for (const r of this.repos) {
      const path = join(this.dir, r.name);
      try {
        if (!existsSync(join(path, '.git'))) {
          await git(['clone', '--depth', '1', '--single-branch', '--branch', r.branch, r.url, path], { env: this.env() });
        } else {
          await git(['fetch', '--depth', '1', 'origin', r.branch], { cwd: path, env: this.env() });
          await git(['reset', '--hard', 'FETCH_HEAD'], { cwd: path });
          await git(['clean', '-fdq'], { cwd: path });
        }
        out.push({ name: r.name, head: await git(['rev-parse', '--short', 'HEAD'], { cwd: path }) });
      } catch (err) {
        out.push({ name: r.name, error: (err as Error).message.split('\n')[0] ?? 'git failed' });
      }
    }
    return out;
  }

  start(intervalMs: number, onResult: (r: Awaited<ReturnType<ContextRepos['syncOnce']>>) => void = () => {}): void {
    const run = () => { void this.syncOnce().then(onResult); };
    run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}

const MEMORY_PATH = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*\.md$/;
const AUTHOR = ['-c', 'user.name=switchboard-ops', '-c', 'user.email=ops@switchboard.invalid'];

/** The ops memory: markdown in a git repo. Every edit is a commit humans can see and revert. */
export class Memory {
  readonly dir: string;

  constructor(dir: string) { this.dir = resolve(dir); }

  async init(seedDir?: string): Promise<void> {
    if (existsSync(join(this.dir, '.git'))) return;
    // A configured seed that isn't there is a config mistake; seeding nothing would hide it, and init runs once.
    if (seedDir && !existsSync(seedDir)) {
      throw new Error(`ops.memory_seed_dir ${seedDir} doesn't exist. A relative path is resolved from the config file's directory; fix it or remove the key.`);
    }
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    await git(['init', '-q', '-b', 'main'], { cwd: this.dir });
    if (seedDir) cpSync(seedDir, this.dir, { recursive: true });
    else writeFileSync(join(this.dir, 'README.md'), '# Ops memory\n\nStanding rules and facts the ops agent keeps. Edit with git; the agent proposes edits as commits.\n');
    await git(['add', '-A'], { cwd: this.dir });
    await git([...AUTHOR, 'commit', '-q', '-m', 'seed ops memory'], { cwd: this.dir });
  }

  private resolve(path: string): string {
    if (!MEMORY_PATH.test(path) || path.length > 120) throw new MemoryError(`memory paths are lowercase .md paths like 'rules/gateway.md' (got '${path}')`);
    const full = resolve(this.dir, path);
    if (!full.startsWith(this.dir + sep)) throw new MemoryError('path escapes the memory dir');
    return full;
  }

  list(): string[] {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
      if (n === '.git') return [];
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : n.endsWith('.md') ? [relative(this.dir, p)] : [];
    });
    return walk(this.dir).sort();
  }

  read(path: string): string {
    const full = this.resolve(path);
    if (!existsSync(full)) throw new MemoryError(`no memory file '${path}'. Files: ${this.list().join(', ')}`);
    return readFileSync(full, 'utf8');
  }

  async propose(path: string, content: string, reason: string): Promise<{ sha: string; path: string }> {
    const full = this.resolve(path);
    if (content.length > 32_000) throw new MemoryError('a memory file is at most 32 000 characters; split it');
    if (!reason.trim()) throw new MemoryError('say why (reason)');
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    await git(['add', '--', path], { cwd: this.dir });
    await git([...AUTHOR, 'commit', '-q', '--allow-empty', '-m', `ops: ${reason.split('\n')[0]!.slice(0, 100)}`], { cwd: this.dir });
    return { sha: await git(['rev-parse', '--short', 'HEAD'], { cwd: this.dir }), path };
  }

  async revert(sha: string): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new MemoryError('sha must be a commit hash');
    await git([...AUTHOR, 'revert', '--no-edit', sha], { cwd: this.dir });
    return git(['rev-parse', '--short', 'HEAD'], { cwd: this.dir });
  }
}

export class MemoryError extends Error {}
