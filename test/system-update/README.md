# System update integration checks

Unit tests live in `src/updater/**/*.spec.ts` and the system-update module.
`helpers.ts` and `protocol.fixture.json` are test inputs excluded from production.
Run `npm test -- --runInBand` for authorization, release validation, planning,
maintenance, durable decisions and recovery tests.

After `npm run build`, run `node --test test/system-update/startup.integration.mjs`
to verify that the actual migration CLI waits behind maintenance before opening
SQLite and updater dispatch avoids loading the application database.

On an isolated Linux test environment with Python, sqlite3 and flock:

```sh
npx ts-node test/system-update/sqlite-backup.integration.ts
npx ts-node test/system-update/worker-crash.integration.ts
```

The SQLite check creates its own temporary database, including committed WAL data.
The worker check uses actual processes, locks, journal and SQLite I/O with a
filesystem deployment adapter; it does not replace deployment qualification.

For MySQL, create a disposable server with a `console_update_test` schema, a schema
restore account and a read-only account sharing the test password. Set
`MYSQL_TEST_HOST`, optional `MYSQL_TEST_PORT`, `MYSQL_TEST_DATABASE`,
`MYSQL_TEST_USERNAME`, `MYSQL_TEST_READONLY_USERNAME` and `MYSQL_TEST_PASSWORD_FILE`:

```sh
npx ts-node test/system-update/mysql-backup.integration.ts
```

Never run failure/restore checks against production or user data. Full release
qualification also needs actual Compose/systemd installations and both component
releases. Local fixture results cannot establish official-release provenance.
