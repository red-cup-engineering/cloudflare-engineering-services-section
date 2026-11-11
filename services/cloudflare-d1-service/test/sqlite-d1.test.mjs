// The local D1 double's own surface: prepare/bind/first/all/run/raw, batch
// atomicity, exec, close, and the bind-value contract (numbers, strings,
// null, bigint, Uint8Array; undefined refused). Every SQL shape exercised
// here is a shape the Assist store (src/db/store.mjs in
// personal-intelligence-systems-services-section) actually prepares against
// D1: INSERT ... RETURNING, ON CONFLICT DO UPDATE, UPDATE ... RETURNING,
// and SELECT ... ORDER BY ... LIMIT ?.
import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteD1 } from "../src/sqlite-d1.mjs";

function freshDb() {
  const d1 = createSqliteD1();
  d1.exec(`
    CREATE TABLE widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      widget_key TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      data BLOB,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return d1;
}

test("prepare().bind().first() returns the RETURNING row from an INSERT", () => {
  const d1 = freshDb();
  const row = d1
    .prepare("INSERT INTO widgets (widget_key, name, count) VALUES (?, ?, ?) RETURNING id, widget_key, name, count")
    .bind("w1", "Widget One", 3)
    .first();
  assert.equal(row.id, 1);
  assert.equal(row.widget_key, "w1");
  assert.equal(row.name, "Widget One");
  assert.equal(row.count, 3);
  // A plain object, not the null-prototype object node:sqlite itself returns.
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
});

test("first(column) projects a single column's value", () => {
  const d1 = freshDb();
  d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w1", "Widget One").run();
  const name = d1.prepare("SELECT name FROM widgets WHERE widget_key = ?").bind("w1").first("name");
  assert.equal(name, "Widget One");
  const missing = d1.prepare("SELECT name FROM widgets WHERE widget_key = ?").bind("nope").first("name");
  assert.equal(missing, null);
});

test("first() returns null, not undefined, when no row matches", () => {
  const d1 = freshDb();
  const row = d1.prepare("SELECT * FROM widgets WHERE widget_key = ?").bind("missing").first();
  assert.equal(row, null);
});

test("run() reports success, changes, and last_row_id for a plain INSERT", () => {
  const d1 = freshDb();
  const result = d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w1", "Widget One").run();
  assert.equal(result.success, true);
  assert.equal(result.meta.changes, 1);
  assert.equal(result.meta.last_row_id, 1);
});

test("INSERT ... ON CONFLICT(col) DO UPDATE SET upserts in place", () => {
  const d1 = freshDb();
  const upsert = () =>
    d1
      .prepare(`INSERT INTO widgets (widget_key, name, count) VALUES (?, ?, ?)
         ON CONFLICT(widget_key) DO UPDATE SET name = excluded.name, count = excluded.count`)
      .bind("w1", "First Name", 1)
      .run();
  upsert();
  const secondUpsert = d1
    .prepare(`INSERT INTO widgets (widget_key, name, count) VALUES (?, ?, ?)
       ON CONFLICT(widget_key) DO UPDATE SET name = excluded.name, count = excluded.count`)
    .bind("w1", "Second Name", 2)
    .run();
  assert.equal(secondUpsert.success, true);
  const rows = d1.prepare("SELECT * FROM widgets").all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].name, "Second Name");
  assert.equal(rows.results[0].count, 2);
});

test("UPDATE ... WHERE ... RETURNING returns the updated row via first()", () => {
  const d1 = freshDb();
  d1.prepare("INSERT INTO widgets (widget_key, name, count) VALUES (?, ?, ?)").bind("w1", "Widget One", 1).run();
  const updated = d1
    .prepare("UPDATE widgets SET count = ? WHERE widget_key = ? RETURNING id, widget_key, count")
    .bind(99, "w1")
    .first();
  assert.equal(updated.count, 99);
  const noMatch = d1.prepare("UPDATE widgets SET count = ? WHERE widget_key = ? RETURNING id").bind(1, "missing").first();
  assert.equal(noMatch, null);
});

test("SELECT ... ORDER BY ... LIMIT ? returns rows in order, bounded by the bound limit", () => {
  const d1 = freshDb();
  const insert = d1.prepare("INSERT INTO widgets (widget_key, name, count) VALUES (?, ?, ?)");
  insert.bind("w1", "A", 1).run();
  insert.bind("w2", "B", 2).run();
  insert.bind("w3", "C", 3).run();
  const { results } = d1.prepare("SELECT widget_key, count FROM widgets ORDER BY count DESC LIMIT ?").bind(2).all();
  assert.deepEqual(results.map((r) => r.widget_key), ["w3", "w2"]);
});

test("all() returns { results, success, meta } even for zero rows", () => {
  const d1 = freshDb();
  const { results, success } = d1.prepare("SELECT * FROM widgets").all();
  assert.deepEqual(results, []);
  assert.equal(success, true);
});

test("raw() returns arrays instead of row objects", () => {
  const d1 = freshDb();
  d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w1", "Widget One").run();
  const rows = d1.prepare("SELECT widget_key, name FROM widgets").raw();
  assert.deepEqual(rows, [["w1", "Widget One"]]);
});

test("bound values: numbers, strings, null, bigint, and Uint8Array all round-trip", () => {
  const d1 = freshDb();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  d1.prepare("INSERT INTO widgets (widget_key, name, count, data) VALUES (?, ?, ?, ?)").bind("w1", "Widget", 7n, bytes).run();
  const row = d1.prepare("SELECT * FROM widgets WHERE widget_key = ?").bind("w1").first();
  assert.equal(row.count, 7);
  assert.deepEqual(new Uint8Array(row.data), bytes);
  d1.prepare("INSERT INTO widgets (widget_key, name, data) VALUES (?, ?, ?)").bind("w2", "No Data", null).run();
  const row2 = d1.prepare("SELECT data FROM widgets WHERE widget_key = ?").bind("w2").first();
  assert.equal(row2.data, null);
});

test("an undefined bound value is refused with a TypeError", () => {
  const d1 = freshDb();
  assert.throws(() => d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w1", undefined).run(), TypeError);
});

test("INTEGER PRIMARY KEY ids come back as plain numbers", () => {
  const d1 = freshDb();
  d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w1", "Widget One").run();
  const row = d1.prepare("SELECT id FROM widgets WHERE widget_key = ?").bind("w1").first();
  assert.equal(typeof row.id, "number");
  assert.equal(row.id, 1);
});

test("batch() runs statements in order inside one transaction and returns their results", () => {
  const d1 = freshDb();
  const results = d1.batch([
    d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w1", "A"),
    d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w2", "B"),
    d1.prepare("SELECT widget_key FROM widgets ORDER BY widget_key").bind(),
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(
    results[2].results.map((r) => r.widget_key),
    ["w1", "w2"],
  );
});

test("batch() rolls back every statement when one of them fails", () => {
  const d1 = freshDb();
  d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("existing", "Existing").run();
  assert.throws(() =>
    d1.batch([
      d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w1", "A"),
      d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("existing", "Duplicate"), // UNIQUE violation
      d1.prepare("INSERT INTO widgets (widget_key, name) VALUES (?, ?)").bind("w2", "B"),
    ]),
  );
  const { results } = d1.prepare("SELECT widget_key FROM widgets ORDER BY widget_key").all();
  // Only the pre-existing row survives; neither w1 nor w2 from the failed batch made it in.
  assert.deepEqual(results.map((r) => r.widget_key), ["existing"]);
});

test("exec() runs multiple semicolon-separated statements and reports a count and duration", () => {
  const d1 = createSqliteD1();
  const result = d1.exec(`
    CREATE TABLE a (id INTEGER PRIMARY KEY);
    CREATE TABLE b (id INTEGER PRIMARY KEY);
    INSERT INTO a (id) VALUES (1);
  `);
  assert.equal(result.count, 3);
  assert.equal(typeof result.duration, "number");
  assert.ok(result.duration >= 0);
  assert.equal(d1.prepare("SELECT id FROM a").first("id"), 1);
  assert.equal(d1.prepare("SELECT id FROM b").first(), null);
});

test("close() shuts down the underlying database", () => {
  const d1 = createSqliteD1();
  d1.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
  d1.close();
  assert.throws(() => d1.prepare("SELECT * FROM t").all());
});
