import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackupContext } from '../../src/updater/contracts';
import { MysqlBackupAdapter } from '../../src/updater/backups/mysql';
import { runBackupCommand } from '../../src/updater/backups/process';

function required(key: string): string {
  const value = process.env[key];
  assert(value, `Set ${key} for this disposable MySQL integration instance`);
  return value;
}

async function main(): Promise<void> {
  const database = {
    kind: 'mysql' as const,
    host: required('MYSQL_TEST_HOST'),
    port: Number(process.env.MYSQL_TEST_PORT || '3306'),
    database: required('MYSQL_TEST_DATABASE'),
    username: required('MYSQL_TEST_USERNAME'),
    passwordFile: required('MYSQL_TEST_PASSWORD_FILE'),
    exclusiveSchema: true,
  };
  const readonlyUsername = required('MYSQL_TEST_READONLY_USERNAME');
  assert(
    /^console_update_test(?:_[a-z0-9]+)?$/.test(database.database),
    'Use a dedicated console_update_test schema',
  );
  const root = await fs.mkdtemp('/tmp/console-system-update-test-mysql-');
  const dataDir = join(root, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });
  const passwordFile = database.passwordFile;
  await fs.chmod(passwordFile, 0o600);
  const context: BackupContext = {
    jobId: randomUUID(),
    database,
    dataDir,
    backupDir: join(root, 'backups'),
    servicesStopped: true,
  };
  const password = (await fs.readFile(passwordFile, 'utf8')).trim();
  const options = join(root, 'client.cnf');
  await fs.writeFile(
    options,
    [
      '[client]',
      `host=${JSON.stringify(database.host)}`,
      `port=${database.port}`,
      `user=${JSON.stringify(database.username)}`,
      `password=${JSON.stringify(password)}`,
      'protocol=TCP',
      'ssl=0',
      `database=${JSON.stringify(database.database)}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const query = (sql: string): Promise<string> =>
    runBackupCommand({
      executable: 'mariadb',
      args: [
        `--defaults-file=${options}`,
        '--batch',
        '--skip-column-names',
        '--raw',
      ],
      input: sql,
      home: root,
      cwd: root,
    });
  try {
    await query(
      "DROP TABLE IF EXISTS evidence, added_by_upgrade; CREATE TABLE evidence(id INT PRIMARY KEY, value VARCHAR(80)) ENGINE=InnoDB; INSERT INTO evidence VALUES(1, 'before-update');",
    );
    await fs.writeFile(join(dataDir, 'business.txt'), 'before-update');
    console.log('mysql: fixture seeded');
    const adapter = new MysqlBackupAdapter();
    const blockers = await adapter.preflight(context);
    assert.deepEqual(blockers, []);
    console.log('mysql: preflight passed');
    const grants = await query('SHOW GRANTS FOR CURRENT_USER;');
    assert(!/GRANT (?:ALL PRIVILEGES|[^\n]*CREATE[^\n]*) ON \*\.\*/.test(grants));
    const readonly = await adapter.preflight({
      ...context,
      database: {
        ...database,
        username: readonlyUsername,
      },
    });
    assert.equal(readonly[0]?.code, 'MYSQL_RESTORE_PRIVILEGES_REQUIRED');
    await assert.rejects(adapter.backup({ ...context, servicesStopped: false }));
    const snapshot = await adapter.backup(context);
    console.log('mysql: snapshot created');
    await adapter.validate(context, snapshot);
    await query(
      "ALTER TABLE evidence ADD COLUMN introduced INT; INSERT INTO evidence(id,value) VALUES(2,'after-update'); CREATE TABLE added_by_upgrade(id INT PRIMARY KEY) ENGINE=InnoDB;",
    );
    await fs.writeFile(join(dataDir, 'business.txt'), 'after-update');
    await fs.writeFile(join(dataDir, 'new.txt'), 'new-file');
    await adapter.restore(context, snapshot);
    console.log('mysql: restore finished');
    assert.equal(
      (await query('SELECT group_concat(id) FROM evidence;')).trim(),
      '1',
    );
    assert.equal(
      (
        await query(
          "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='evidence' ORDER BY ORDINAL_POSITION;",
        )
      ).trim(),
      'id\nvalue',
    );
    assert.equal(
      (
        await query(
          "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='added_by_upgrade';",
        )
      ).trim(),
      '0',
    );
    assert.equal(
      await fs.readFile(join(dataDir, 'business.txt'), 'utf8'),
      'before-update',
    );
    await assert.rejects(fs.stat(join(dataDir, 'new.txt')));
    await query(
      "INSERT INTO evidence(id,value) VALUES(3,'after-restore-new-write');",
    );
    await fs.appendFile(join(snapshot.path, 'database.sql'), 'tampered');
    await assert.rejects(adapter.restore(context, snapshot));
    assert.equal(
      (await query('SELECT value FROM evidence WHERE id=3;')).trim(),
      'after-restore-new-write',
    );
    console.log(
      JSON.stringify({
        suite: 'mysql-real-backup-adapter',
        root,
        passed: [
          'schema-only-DDL-grants',
          'missing-restore-privileges-blocked',
          'writer-stop-required',
          'schema-and-data-rollback',
          'business-files-rollback',
          'corrupt-backup-rejected-before-mutation',
        ],
        scope:
          'adapter integration only; not deployment or published-release acceptance',
      }),
    );
  } finally {
    await fs.unlink(options);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Integration failed');
  process.exitCode = 1;
});
