/**
 * ============================================================================
 *  db.js — Connection pool, transactions, and row locking
 * ============================================================================
 *
 *  THE ONE RULE THAT MATTERS
 *  --------------------------------------------------------------------------
 *  Never compute game math inside a transaction.
 *
 *  The correct shape is always:
 *      1. BEGIN
 *      2. SELECT ... FOR UPDATE  (lock the rows)
 *      3. read state into memory
 *      4. call the engine — pure, in-memory, no I/O
 *      5. write the finished result
 *      6. COMMIT
 *
 *  Steps 3-5 must not contain a network call, a second query round-trip, or
 *  anything slow. Transactions hold locks; long transactions hold them longer;
 *  held locks are how a game server becomes unresponsive under load.
 *
 *  Because the engine is pure and synchronous, step 4 costs microseconds. That
 *  is not an accident — it is the entire reason the engine was built that way.
 *
 *  DEADLOCKS
 *  --------------------------------------------------------------------------
 *  Any operation touching two nations (a trade, a war, a bank transfer) must
 *  lock them in a CONSISTENT ORDER or two concurrent operations will deadlock:
 *  A locks 1 and waits for 2; B locks 2 and waits for 1.
 *
 *  lockNations() sorts by id before locking. Always use it. Never hand-write
 *  two SELECT ... FOR UPDATE calls in sequence.
 * ============================================================================
 */

'use strict';

const { Pool } = require('pg');

// ============================================================================
// POOL
// ============================================================================

let pool = null;

/**
 * Never hardcode credentials. Read from env, fail loudly if missing.
 */
function createPool(config = {}) {
  const connectionString = config.connectionString || process.env.DATABASE_URL;

  if (!connectionString && !config.host && !process.env.PGHOST) {
    throw new Error(
      'No database configuration. Set DATABASE_URL in .env — never hardcode credentials in source.'
    );
  }

  pool = new Pool({
    connectionString,
    host: config.host || process.env.PGHOST,
    port: config.port || process.env.PGPORT,
    database: config.database || process.env.PGDATABASE,
    user: config.user || process.env.PGUSER,
    password: config.password || process.env.PGPASSWORD,

    max: config.max || 20,
    idleTimeoutMillis: 30000,
    // A connection that cannot be acquired in 5s means the pool is exhausted.
    // Fail fast rather than queueing requests behind a stuck transaction.
    connectionTimeoutMillis: 5000,
    // Backstop against a transaction that forgot to commit.
    statement_timeout: config.statementTimeout || 10000,
  });

  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

function getPool() {
  if (!pool) throw new Error('Pool not initialised — call createPool() first');
  return pool;
}

async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}

// ============================================================================
// TRANSACTIONS
// ============================================================================

/** Postgres error codes worth retrying rather than surfacing. */
const RETRYABLE = new Set([
  '40001',  // serialization_failure
  '40P01',  // deadlock_detected
]);

/**
 * Run `fn` inside a transaction, retrying on serialization failures.
 *
 * `fn` receives a client with query() bound to the transaction. Everything it
 * does is atomic: either all writes land or none do.
 *
 *   await withTransaction(async (tx) => {
 *     const nation = await repo.loadNation(tx, id, { lock: true });
 *     const { state, events } = tick.processTurn({ nation, turn });
 *     await repo.saveNation(tx, state.nation);
 *     await repo.recordEvents(tx, id, events);
 *   });
 *
 * Retries re-run `fn` from the top, so `fn` must be idempotent — do not
 * mutate anything outside the transaction inside it (no writing to a cache,
 * no sending an email, no incrementing a counter in memory).
 */
async function withTransaction(fn, opts = {}) {
  const client = await getPool().connect();
  const maxAttempts = opts.maxAttempts || 3;
  const isolation = opts.isolation || 'READ COMMITTED';

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});

        if (RETRYABLE.has(err.code) && attempt < maxAttempts) {
          // Exponential backoff with jitter so retrying clients do not
          // synchronise and collide again immediately.
          const backoff = Math.pow(2, attempt) * 10 + Math.random() * 20;
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

// ============================================================================
// LOCKING
// ============================================================================

/**
 * Lock one or more nations for update, in a deadlock-safe order.
 *
 * ALWAYS use this instead of writing SELECT ... FOR UPDATE by hand when more
 * than one nation is involved. Sorting the ids before locking is what
 * guarantees two concurrent operations acquire them in the same sequence and
 * therefore queue instead of deadlocking.
 *
 * @returns {Array} locked nation rows, in the order requested
 */
async function lockNations(tx, nationIds) {
  const ids = (Array.isArray(nationIds) ? nationIds : [nationIds])
    .map(Number)
    .filter(Number.isFinite);

  if (ids.length === 0) return [];

  const sorted = [...new Set(ids)].sort((a, b) => a - b);

  const { rows } = await tx.query(
    `SELECT * FROM nations WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [sorted]
  );

  if (rows.length !== sorted.length) {
    const found = new Set(rows.map(r => Number(r.id)));
    const missing = sorted.filter(id => !found.has(id));
    throw new Error(`Nation(s) not found: ${missing.join(', ')}`);
  }

  // Return in the caller's requested order, not lock order.
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  return ids.map(id => byId.get(id));
}

/**
 * Lock the global game state row. The tick scheduler takes this so two tick
 * runs can never overlap — a doubled tick is a doubled economy.
 *
 * Uses NOWAIT: if another tick holds it, fail immediately rather than queue.
 * Queueing would mean the second tick runs right after the first, which is
 * exactly the double-tick you were preventing.
 */
async function lockGameState(tx, { nowait = true } = {}) {
  const { rows } = await tx.query(
    `SELECT * FROM game_state WHERE id = 1 FOR UPDATE ${nowait ? 'NOWAIT' : ''}`
  );
  return rows[0];
}

/**
 * Advisory lock — for coordinating work that is not tied to a specific row,
 * e.g. "only one market matcher at a time".
 */
async function tryAdvisoryLock(tx, key) {
  const { rows } = await tx.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [key]);
  return rows[0].locked;
}

// ============================================================================
// HELPERS
// ============================================================================

/** One-off query outside a transaction. Reads only — never mutate with this. */
async function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Postgres NUMERIC comes back as a string to preserve precision. That is
 * correct behaviour, and silently doing `+row.money` on it in application code
 * is how precision gets thrown away.
 *
 * Convert deliberately, at the boundary, and only for values the engine will
 * treat as numbers.
 */
function num(value) {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) throw new TypeError(`Expected numeric, got: ${value}`);
  return n;
}

/** Build a key->value object from rows, e.g. resources or units. */
function toMap(rows, keyCol, valueCol, transform = num) {
  const out = {};
  for (const row of rows) out[row[keyCol]] = transform(row[valueCol]);
  return out;
}

module.exports = {
  createPool,
  getPool,
  closePool,
  withTransaction,
  lockNations,
  lockGameState,
  tryAdvisoryLock,
  query,
  num,
  toMap,
  RETRYABLE,
};
