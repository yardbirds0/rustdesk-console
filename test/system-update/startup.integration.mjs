import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const entrypoint = resolve('dist/main.js');

function invoke(command, env) {
  const child = spawn(process.execPath, [entrypoint, command], {
    env,
    timeout: 20_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (bytes) => (output += bytes));
  child.stderr.on('data', (bytes) => (output += bytes));
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
  return { child, result };
}

test(
  'migration CLI waits for maintenance permission before opening SQLite',
  { timeout: 30_000 },
  async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'console-startup-test-'));
    const data = join(root, 'data');
    const fence = join(root, 'maintenance.json');
    const env = {
      ...process.env,
      DB_TYPE: 'sqlite',
      DATA_DIR: data,
      SYSTEM_UPDATE_MAINTENANCE_FILE: fence,
    };
    await fs.writeFile(
      fence,
      JSON.stringify({
        schemaVersion: 1,
        jobId: 'test',
        active: true,
        allowStart: false,
      }),
    );
    const migration = invoke('migrate', env);
    t.after(async () => {
      if (migration.child.exitCode === null) migration.child.kill();
      await migration.result;
      await fs.rm(root, { recursive: true, force: true });
    });

    await delay(1200);
    assert.equal(migration.child.exitCode, null);
    await assert.rejects(fs.stat(data), { code: 'ENOENT' });

    await fs.writeFile(
      fence,
      JSON.stringify({
        schemaVersion: 1,
        jobId: 'test',
        active: true,
        allowStart: true,
      }),
    );
    const migrated = await migration.result;
    assert.equal(migrated.code, 0, migrated.output);
    assert.ok((await fs.stat(join(data, 'rustdesk-console.db'))).size > 0);
    const shown = await invoke('show-migrations', env).result;
    assert.equal(shown.code, 0, shown.output);
    assert.match(shown.output, /Database migrations are current/);
    const baselined = await invoke('baseline', env).result;
    assert.equal(baselined.code, 1);
    assert.match(baselined.output, /There is no unbaselined existing database/);
  },
);

test(
  'updater dispatch does not load the application database',
  { timeout: 30_000 },
  async (t) => {
    const root = await fs.mkdtemp(
      join(tmpdir(), 'console-updater-dispatch-test-'),
    );
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await invoke('--system-update-mode=invalid', {
      ...process.env,
      DB_TYPE: 'invalid',
      DATA_DIR: join(root, 'data'),
    }).result;
    assert.equal(result.code, 1);
    assert.match(result.output, /INVALID_MODE/);
    await assert.rejects(fs.stat(join(root, 'data')), { code: 'ENOENT' });
  },
);
