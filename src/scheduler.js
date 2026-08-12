/**
 * ============================================================================
 *  scheduler.js — The game clock
 * ============================================================================
 *
 *  Advances every nation by one turn on a fixed interval.
 *
 *  THE DOUBLE-TICK PROBLEM
 *  --------------------------------------------------------------------------
 *  If two tick runs overlap, every nation gets paid twice. That is not a
 *  rounding error — it is an economy-wide duplication event, and it is very
 *  hard to unwind after the fact.
 *
 *  Two guards, deliberately belt-and-braces:
 *    1. An in-process flag, which handles a slow tick overrunning its interval.
 *    2. A SELECT ... FOR UPDATE NOWAIT on game_state, which handles TWO SERVER
 *       PROCESSES. The first is useless the moment you run more than one node
 *       instance; the second is what actually protects you in production.
 *
 *  NOWAIT is the important detail. If the lock queued instead of failing, the
 *  second tick would simply run immediately after the first — which is exactly
 *  the double-tick you were preventing.
 *
 *  CATCH-UP
 *  --------------------------------------------------------------------------
 *  If the server was down for six hours, three turns were missed. The
 *  scheduler processes the backlog rather than silently skipping it, but caps
 *  the batch — a catch-up job that tries to run 4000 turns is how downtime
 *  becomes an outage.
 * ============================================================================
 */

'use strict';

const db = require('./data/db');
const repo = require('./data/repository');
const tick = require('./engine/tick');
const C = require('./engine/constants');

let timer = null;
let running = false;

const MAX_CATCHUP_TURNS = 50;

/**
 * Advance every nation by one turn.
 *
 * Each nation is processed in its OWN transaction. That is deliberate: one
 * nation with corrupt state should not roll back the entire world's turn. The
 * tradeoff is that a tick is not globally atomic, which is fine — turns are
 * independent per nation.
 */
async function runTurn(opts = {}) {
  // Guard 1: in-process.
  if (running) {
    console.warn('[tick] previous tick still running, skipping');
    return { skipped: true, reason: 'overlap' };
  }
  running = true;

  const started = Date.now();
  let turn;

  try {
    // Guard 2: cross-process. Claim the turn and release immediately so we do
    // not hold a global lock while processing thousands of nations.
    try {
      turn = await db.withTransaction(async (tx) => {
        const gs = await db.lockGameState(tx, { nowait: true });
        const next = Number(gs.current_turn) + 1;
        await tx.query('UPDATE game_state SET current_turn = $1, last_tick_at = now() WHERE id = 1', [next]);
        return next;
      });
    } catch (err) {
      if (err.code === '55P03') {   // lock_not_available
        console.warn('[tick] another process holds the tick lock, skipping');
        return { skipped: true, reason: 'locked_by_other_process' };
      }
      throw err;
    }

    const { rows } = await db.query(
      'SELECT id FROM nations WHERE is_deleted = FALSE ORDER BY id'
    );

    let processed = 0;
    let failed = 0;

    for (const row of rows) {
      const nationId = Number(row.id);
      try {
        await processNation(nationId, turn);
        processed++;
      } catch (err) {
        // One bad nation must not stop the world.
        failed++;
        console.error(`[tick] nation ${nationId} failed:`, err.message);
      }
    }

    const ms = Date.now() - started;
    console.log(`[tick] turn ${turn} — ${processed} nations, ${failed} failed, ${ms}ms`);

    if (opts.onTurn) opts.onTurn({ turn, processed, failed, ms });

    return { turn, processed, failed, ms };
  } finally {
    running = false;
  }
}

/**
 * One nation, one transaction: lock, load, run the engine, save.
 * The engine call is pure and synchronous, so the lock is held for microseconds.
 */
async function processNation(nationId, turn) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { lock: true, currentTurn: turn });
    if (!nation) return;

    // The turn number was already advanced globally, so process from turn-1.
    const state = { turn: turn - 1, nation, world: gs.world };

    const result = tick.processTurn(state, {
      allianceTaxRates: nation.allianceId
        ? await loadAllianceTaxRates(tx, nation.allianceId)
        : null,
    });

    await repo.saveNation(tx, result.state.nation);
    await repo.saveCities(tx, result.state.nation.cities);

    // Only persist events worth showing a player. City warnings fire every
    // single turn — writing 12 identical rows a day per city would bury the
    // events that actually matter under noise.
    const notable = result.events.filter(e =>
      !['city_warning', 'economy_warning', 'color_bloc_bonus'].includes(e.type)
    );
    if (notable.length > 0) {
      await repo.recordEvents(tx, nationId, notable);
    }
  });
}

async function loadAllianceTaxRates(tx, allianceId) {
  const { rows } = await tx.query(
    'SELECT tax_money_rate, tax_resource_rate FROM alliances WHERE id = $1',
    [allianceId]
  );
  if (rows.length === 0) return null;
  return { money: db.num(rows[0].tax_money_rate), resources: db.num(rows[0].tax_resource_rate) };
}

/**
 * Process any turns missed while the server was down.
 */
async function catchUp() {
  const { rows } = await db.query(
    'SELECT current_turn, last_tick_at FROM game_state WHERE id = 1'
  );
  const lastTick = new Date(rows[0].last_tick_at).getTime();
  const interval = Number(process.env.TURN_INTERVAL_MS) || C.TICK.TURN_INTERVAL_MS;
  const missed = Math.floor((Date.now() - lastTick) / interval);

  if (missed <= 0) return { missed: 0 };

  const toRun = Math.min(missed, MAX_CATCHUP_TURNS);
  if (missed > MAX_CATCHUP_TURNS) {
    console.warn(`[tick] ${missed} turns missed, capping catch-up at ${MAX_CATCHUP_TURNS}`);
  }

  console.log(`[tick] catching up ${toRun} turn(s)...`);
  for (let i = 0; i < toRun; i++) await runTurn();

  return { missed, processed: toRun };
}

function start(opts = {}) {
  const interval = Number(process.env.TURN_INTERVAL_MS) || C.TICK.TURN_INTERVAL_MS;

  if (timer) { console.warn('[tick] scheduler already started'); return; }

  console.log(`[tick] scheduler starting, interval ${interval}ms (${interval / 1000}s)`);
  if (interval < 60000) {
    console.warn(`[tick] NOTE: ${interval / 1000}s turns are a DEV setting. Production is ${C.TICK.TURN_INTERVAL_MS / 1000}s.`);
  }

  timer = setInterval(() => {
    runTurn(opts).catch(err => console.error('[tick] fatal:', err));
  }, interval);

  // Do not hold the process open just for the scheduler.
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; console.log('[tick] scheduler stopped'); }
}

module.exports = { start, stop, runTurn, catchUp, processNation, isRunning: () => running };
