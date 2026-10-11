// Migration application against real migration files this D1 double must
// actually run: the Assist engine's own migrations/0001_assist.sql
// (personal-intelligence-systems-services-section) and the EVE Assist
// package's migrations/000{1,2,3}_*.sql (eve-online-services-section),
// whose 0003 rewrites EVE's own schema onto the Assist engine's six tables.
import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteD1 } from "../src/sqlite-d1.mjs";
import { walkPosixPaths } from "@red-cup-engineering/computer-filepath-engineering-services-section/walk-posix-paths";
import { readFileText } from "@red-cup-engineering/computer-file-engineering-services-section/read-file";
import { applyMigrations } from "../src/apply-migrations.mjs";

/** Every *.sql directly under `directory`, in lexical order, read through the file owners. */
async function readMigrationsDirectory(directory) {
  const walk = await walkPosixPaths({ root: directory, extensions: [".sql"], maxDepth: 0 });
  const base = directory.endsWith("/") ? directory.slice(0, -1) : directory;
  const migrations = [];
  for (const entry of walk.files) migrations.push({ name: entry.path, sql: await readFileText(`${base}/${entry.path}`) });
  return migrations;
}

const ASSIST_MIGRATIONS_DIR =
  "/home/emsenn/info/lib/emsenn/services/561-group/services/engineering-services-section/services/computer-engineering-services-section/services/computer-systems-engineering-services-section/services/personal-computer-systems-services-section/services/personal-intelligence-systems-services-section/migrations";

const EVE_MIGRATIONS_DIR =
  "/home/emsenn/info/lib/emsenn/services/561-group/services/engineering-services-section/services/computer-engineering-services-section/services/computer-systems-engineering-services-section/services/computer-game-system-services-section/services/web-game-services-section/services/eve-online-services-section/migrations";

test("the test reader reads the Assist engine's one migration in lexical order", async () => {
  const migrations = await readMigrationsDirectory(ASSIST_MIGRATIONS_DIR);
  assert.deepEqual(migrations.map((m) => m.name), ["0001_assist.sql"]);
  assert.match(migrations[0].sql, /CREATE TABLE principals/);
});

test("the test reader reads EVE's three migrations in lexical (numeric-prefixed) order", async () => {
  const migrations = await readMigrationsDirectory(EVE_MIGRATIONS_DIR);
  assert.deepEqual(migrations.map((m) => m.name), ["0001_init.sql", "0002_ai_provider.sql", "0003_assist_platform.sql"]);
});

test("applyMigrations runs the Assist 0001 migration and every statement shape the store composes", async () => {
  const d1 = createSqliteD1();
  const migrations = await readMigrationsDirectory(ASSIST_MIGRATIONS_DIR);
  const result = await applyMigrations(d1, migrations);
  assert.deepEqual(result, { applied: ["0001_assist.sql"], skipped: [] });

  // INSERT ... RETURNING (createPrincipal)
  const principal = d1
    .prepare(
      `INSERT INTO principals (principal_key, kind, subject, display_name) VALUES (?, ?, ?, ?)
       RETURNING id, principal_key, kind, subject, display_name, created_at`,
    )
    .bind("web:alice", "web", "alice", "Alice")
    .first();
  assert.equal(principal.id, 1);
  assert.equal(principal.kind, "web");

  // INSERT ... ON CONFLICT(col) DO UPDATE SET (saveCredential, upsert twice)
  const upsertCredential = (sealed) =>
    d1
      .prepare(
        `INSERT INTO credentials (credential_key, principal_id, provider, sealed_json, expires_at, scopes_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(credential_key) DO UPDATE SET
           sealed_json = excluded.sealed_json,
           expires_at = excluded.expires_at,
           scopes_json = excluded.scopes_json`,
      )
      .bind(`${principal.id}:github`, principal.id, "github", sealed, null, "[]")
      .run();
  upsertCredential("sealed-v1");
  upsertCredential("sealed-v2");
  const credential = d1
    .prepare("SELECT sealed_json FROM credentials WHERE credential_key = ?")
    .bind(`${principal.id}:github`)
    .first();
  assert.equal(credential.sealed_json, "sealed-v2");

  // INSERT ... RETURNING then UPDATE ... RETURNING (mintMcpToken, revokeMcpToken)
  const token = d1
    .prepare("INSERT INTO mcp_tokens (principal_id, token_hash, label) VALUES (?, ?, ?) RETURNING id, principal_id, token_hash, label, created_at, revoked_at")
    .bind(principal.id, "hash-1", "laptop")
    .first();
  assert.equal(token.revoked_at, null);
  const revoked = d1
    .prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND principal_id = ? AND revoked_at IS NULL RETURNING id")
    .bind("2026-09-11T00:00:00.000Z", token.id, principal.id)
    .first();
  assert.equal(revoked.id, token.id);
  // Revoking again matches no row (revoked_at IS NULL no longer holds).
  const revokedAgain = d1
    .prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE id = ? AND principal_id = ? AND revoked_at IS NULL RETURNING id")
    .bind("2026-09-11T00:00:01.000Z", token.id, principal.id)
    .first();
  assert.equal(revokedAgain, null);

  // SELECT ... ORDER BY ... LIMIT ? (getChatMessages)
  const appendMessage = (threadId, role, contentJson) =>
    d1
      .prepare("INSERT INTO chat_messages (principal_id, thread_id, role, content_json) VALUES (?, ?, ?, ?) RETURNING id")
      .bind(principal.id, threadId, role, contentJson)
      .first();
  appendMessage("thread-1", "user", JSON.stringify({ text: "hi" }));
  appendMessage("thread-1", "assistant", JSON.stringify({ text: "hello" }));
  appendMessage("thread-1", "user", JSON.stringify({ text: "how are you" }));
  const { results: recent } = d1
    .prepare("SELECT id, role FROM chat_messages WHERE principal_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?")
    .bind(principal.id, "thread-1", 2)
    .all();
  assert.deepEqual(recent.map((m) => m.role), ["user", "assistant"]);
});

test("applyMigrations is idempotent: re-running the same list skips already-applied names", async () => {
  const d1 = createSqliteD1();
  const migrations = await readMigrationsDirectory(ASSIST_MIGRATIONS_DIR);
  const first = await applyMigrations(d1, migrations);
  assert.deepEqual(first, { applied: ["0001_assist.sql"], skipped: [] });
  const second = await applyMigrations(d1, migrations);
  assert.deepEqual(second, { applied: [], skipped: ["0001_assist.sql"] });
  // The table is not recreated (which would have wiped data) on the skipped re-run.
  d1.prepare("INSERT INTO principals (principal_key, kind, subject, display_name) VALUES (?, ?, ?, ?)").bind("web:bob", "web", "bob", "Bob").run();
  await applyMigrations(d1, migrations);
  const { results } = d1.prepare("SELECT subject FROM principals").all();
  assert.deepEqual(results.map((r) => r.subject), ["bob"]);
});

test("EVE's migrations apply in order, and 0003 rewrites prior data onto the Assist schema", async () => {
  const d1 = createSqliteD1();
  const migrations = await readMigrationsDirectory(EVE_MIGRATIONS_DIR);
  const [init, aiProvider, assistPlatform] = migrations;

  // Apply only 0001_init + 0002_ai_provider first, and seed data under EVE's
  // original users/user_settings/mcp_tokens/chat_messages shape.
  const early = await applyMigrations(d1, [init, aiProvider]);
  assert.deepEqual(early, { applied: ["0001_init.sql", "0002_ai_provider.sql"], skipped: [] });

  d1.prepare("INSERT INTO users (id, character_id, character_name) VALUES (?, ?, ?)").bind(1, 90000001, "Some Capsuleer").run();
  d1.prepare(
    "INSERT INTO user_settings (user_id, gemini_key_sealed, gemini_model, ai_provider, ai_base_url, ai_model) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(1, "sealed-gemini-key", "gemini-2.5-flash", "gemini", null, null)
    .run();
  const mcpToken = d1
    .prepare("INSERT INTO mcp_tokens (user_id, token_hash, label) VALUES (?, ?, ?) RETURNING id")
    .bind(1, "eve-hash-1", "eve-laptop")
    .first();
  d1.prepare("INSERT INTO chat_messages (user_id, thread_id, role, content_json) VALUES (?, ?, ?, ?)")
    .bind(1, "eve-thread", "user", JSON.stringify({ text: "o7" }))
    .run();

  // Now apply the full list: 0001/0002 are skipped (already applied), 0003 runs and migrates the seeded data.
  const full = await applyMigrations(d1, migrations);
  assert.deepEqual(full, { applied: ["0003_assist_platform.sql"], skipped: ["0001_init.sql", "0002_ai_provider.sql"] });

  const tableNames = d1
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .results.map((r) => r.name);
  assert.ok(!tableNames.includes("users"), "users table should be dropped by 0003");
  assert.ok(!tableNames.includes("esi_tokens"), "esi_tokens table should be dropped by 0003");
  assert.ok(!tableNames.includes("user_settings"), "user_settings table should be dropped by 0003");
  assert.ok(tableNames.includes("principals"));
  assert.ok(tableNames.includes("ai_settings"));

  const principal = d1.prepare("SELECT * FROM principals WHERE id = ?").bind(1).first();
  assert.equal(principal.principal_key, "eve-character:90000001");
  assert.equal(principal.kind, "eve-character");
  assert.equal(principal.subject, "90000001");
  assert.equal(principal.display_name, "Some Capsuleer");

  const aiSettings = d1.prepare("SELECT * FROM ai_settings WHERE principal_id = ?").bind(1).first();
  assert.equal(aiSettings.key_sealed, "sealed-gemini-key");
  assert.equal(aiSettings.provider, "gemini");
  assert.equal(aiSettings.model, "gemini-2.5-flash"); // COALESCE(ai_model, gemini_model): ai_model was NULL

  const migratedToken = d1.prepare("SELECT principal_id, token_hash, label FROM mcp_tokens WHERE id = ?").bind(mcpToken.id).first();
  assert.equal(migratedToken.principal_id, 1);
  assert.equal(migratedToken.token_hash, "eve-hash-1");

  const { results: chatRows } = d1.prepare("SELECT principal_id, thread_id, role FROM chat_messages WHERE principal_id = ?").bind(1).all();
  assert.equal(chatRows.length, 1);
  assert.equal(chatRows[0].thread_id, "eve-thread");

  assert.equal(assistPlatform.name, "0003_assist_platform.sql");
});
