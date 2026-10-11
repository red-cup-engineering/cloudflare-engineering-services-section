// src/sqlite-d1.mjs — a local double for a Cloudflare D1Database, over
// node:sqlite's DatabaseSync. Real SQLite understands the full statement
// shapes D1 exposes (INSERT/UPDATE ... RETURNING, ON CONFLICT DO UPDATE,
// ORDER BY ... LIMIT ?, ALTER TABLE ... ADD COLUMN, transactional batches),
// so this module does no SQL parsing of its own — it only adapts
// DatabaseSync's StatementSync surface to the D1Database/D1PreparedStatement
// shape Workers code composes against: prepare/bind/first/all/run/raw,
// batch (one transaction, rolled back whole on any failure), and exec.
import { DatabaseSync } from "node:sqlite";

// node:sqlite returns rows as null-prototype objects; D1's own rows are
// plain, JSON-serializable objects, so callers that spread, JSON.stringify,
// or otherwise expect a normal Object prototype are not surprised.
function toPlainRow(row) {
  return row === undefined ? undefined : { ...row };
}

function assertBindable(values, sql) {
  for (const [index, value] of values.entries()) {
    if (value === undefined) {
      throw new TypeError(`sqlite-d1: bound value at position ${index} is undefined for statement: ${sql} (use null for SQL NULL)`);
    }
  }
}

function createBoundStatement(db, sql, boundValues) {
  function freshStatement() {
    assertBindable(boundValues, sql);
    return db.prepare(sql);
  }

  return {
    bind(...values) {
      return createBoundStatement(db, sql, values);
    },
    first(column) {
      const row = freshStatement().get(...boundValues);
      if (row === undefined) return null;
      if (column !== undefined) {
        return Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null;
      }
      return toPlainRow(row);
    },
    all() {
      const rows = freshStatement().all(...boundValues);
      return { results: rows.map(toPlainRow), success: true, meta: {} };
    },
    run() {
      const result = freshStatement().run(...boundValues);
      return {
        success: true,
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid),
        },
      };
    },
    raw() {
      const stmt = freshStatement();
      stmt.setReturnArrays(true);
      return stmt.all(...boundValues);
    },
  };
}

/**
 * Create a local D1Database double backed by node:sqlite's DatabaseSync.
 * `location` is a file path or ":memory:" (default), exactly as DatabaseSync accepts.
 */
export function createSqliteD1(location = ":memory:") {
  const db = new DatabaseSync(location);
  // node:sqlite enables SQLite's `foreign_keys` pragma by default; Cloudflare
  // D1 (and a plain sqlite3 library build) does not enforce foreign keys
  // unless a session opts in. Matching D1's default here matters for real
  // migrations (e.g. the EVE Assist package's 0003_assist_platform.sql)
  // that intentionally DROP TABLE a referenced parent before its dependents
  // in the same migration, which is only valid without FK enforcement.
  db.exec("PRAGMA foreign_keys = OFF");

  function prepare(sql) {
    if (typeof sql !== "string" || sql.length === 0) throw new TypeError("sqlite-d1: prepare(sql) requires a non-empty SQL string");
    return createBoundStatement(db, sql, []);
  }

  /** Run each already-bound statement in order inside one transaction; any failure rolls back every statement in the batch. */
  function batch(statements) {
    if (!Array.isArray(statements)) throw new TypeError("sqlite-d1: batch(statements) requires an array");
    db.exec("BEGIN");
    let results;
    try {
      results = statements.map((statement) => statement.all());
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    db.exec("COMMIT");
    return results;
  }

  /** Execute arbitrary SQL text (any number of statements) as D1's exec() does: the whole text handed to the engine at once. */
  function exec(sqlText) {
    if (typeof sqlText !== "string") throw new TypeError("sqlite-d1: exec(sqlText) requires a string");
    const count = sqlText
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0).length;
    const start = performance.now();
    db.exec(sqlText);
    const duration = performance.now() - start;
    return { count, duration };
  }

  function close() {
    db.close();
  }

  return Object.freeze({ prepare, batch, exec, close });
}
