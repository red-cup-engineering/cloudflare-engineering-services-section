// src/apply-migrations.mjs — a minimal migration applier over the D1
// prepare/exec surface: forward-only, named migrations recorded in a
// `d1_migrations` bookkeeping table so re-running the same list is a no-op
// for names already applied. Works against the real Cloudflare D1 binding or
// the sqlite-d1.mjs double identically — it composes only prepare/bind/
// first/run/exec, the shape both expose. Reading migration files off a
// filesystem is the caller's (a seat's scripts, a test) through the file owners.

const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

/**
 * Apply `migrations` ({ name, sql }[], in order) to `d1`, skipping any name
 * already recorded as applied. Returns { applied: string[], skipped: string[] }.
 */
export async function applyMigrations(d1, migrations) {
  if (!d1 || typeof d1.prepare !== "function" || typeof d1.exec !== "function") {
    throw new TypeError("applyMigrations requires a D1Database with prepare(sql) and exec(sql)");
  }
  if (!Array.isArray(migrations)) throw new TypeError("applyMigrations requires an array of { name, sql } migrations");

  await d1.exec(MIGRATIONS_TABLE_SQL);

  const applied = [];
  const skipped = [];
  for (const migration of migrations) {
    if (!migration || typeof migration.name !== "string" || typeof migration.sql !== "string") {
      throw new TypeError("applyMigrations: each migration requires a string name and sql");
    }
    const { name, sql } = migration;
    const already = await d1.prepare("SELECT name FROM d1_migrations WHERE name = ?").bind(name).first();
    if (already) {
      skipped.push(name);
      continue;
    }
    await d1.exec(sql);
    await d1.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)").bind(name, new Date().toISOString()).run();
    applied.push(name);
  }
  return { applied, skipped };
}
