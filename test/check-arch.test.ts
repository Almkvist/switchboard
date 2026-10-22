// The arch check's guarded calls (scripts/check-arch.ts): each fails the check when a file outside its allowed list
// references it. Runs the real script on a copy of the app.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('every guarded call fails check-arch when a file outside its allowed list references it', () => {
  const app = new URL('..', import.meta.url).pathname;
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: app, encoding: 'utf8' }).split('\n').filter(Boolean);
  const dir = mkdtempSync(join(tmpdir(), 'sb-arch-'));
  try {
    for (const f of files) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      copyFileSync(join(app, f), join(dir, f));
    }
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const check = () => spawnSync(process.execPath, ['scripts/check-arch.ts'], { cwd: dir, encoding: 'utf8' });
    assert.equal(check().status, 0, 'the copy passes as it is');
    const main = readFileSync(join(dir, 'src/main.ts'), 'utf8');
    for (const fn of ['decideFromSlackButton', 'decideStandingFromSlackButton', 'answerAsk', 'messageAgents', 'setSchedule',
      'setDelegate', 'setMute', 'setOwnMute', 'presentAsk', 'handleHumanItems', 'skipAsk']) {
      writeFileSync(join(dir, 'src/main.ts'), `${main}\n// ${fn}\n`);
      const r = check();
      assert.equal(r.status, 1, `${fn}: ${r.stdout}`);
      assert.match(r.stderr, new RegExp(`src/main\\.ts references ${fn}\\b`), fn);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
