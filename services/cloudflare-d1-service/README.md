# Cloudflare D1 service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

The Cloudflare D1 database handle contract, seated in the Cloudflare platform section so that every Workers application store composes one D1 shape on the platform and in tests.
The contract is D1's own: `prepare(sql)` returning a statement with `bind(...values)`, `first(column?)`, `all()`, `run()`, and `raw()`; `batch(statements)` applied atomically; `exec(sqlText)`.

`./sqlite` exports `createSqliteD1(location = ":memory:")`, the local double over node:sqlite's `DatabaseSync`: the same surface, plain-object rows, `RETURNING` through `first` and `all`, batch as one transaction, and `PRAGMA foreign_keys = OFF` as D1 defaults, so the migrations a seat applies in production apply identically in a test.
`./migrations` exports `applyMigrations(d1, migrations)`: forward-only `{ name, sql }` migrations recorded in a `d1_migrations` table and skipped once applied.
Reading migration files from a directory is the caller's, through the file owners (path-walking-service, file-services), never a raw filesystem import here.

The Assist engine (personal-intelligence-systems-services-section) binds its store to this contract; its tests and every seat's tests run over `createSqliteD1` in place of a hand-written emulator.
