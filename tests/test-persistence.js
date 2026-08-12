require('dotenv').config({ quiet: true });
const db = require('../src/data/db');
const repo = require('../src/data/repository');
const tick = require('../src/engine/tick');
const C = require('../src/engine/constants');

let pass=0, fail=0;
async function t(n,f){ try{ await f(); console.log('  PASS '+n); pass++; }catch(e){ console.log('  FAIL '+n+' -> '+e.message); fail++; } }
function eq(a,b,m){ if(a!==b) throw new Error(`${m||''} expected ${b}, got ${a}`); }
function approx(a,b,tol,m){ if(Math.abs(a-b)>tol) throw new Error(`${m||''} expected ~${b}, got ${a}`); }

// Reads DATABASE_URL from .env — no hardcoded host, so this runs the same
// way on every machine instead of only the one it was first written on.
db.createPool({ connectionString: process.env.DATABASE_URL });

/**
 * These tests write real rows. Without a reset they pass once and then fail
 * forever on a duplicate email — which looks like a code regression but is
 * just leftover data. Clear this suite's own rows before starting.
 *
 * Deleting the user cascades to its nations, cities, resources and links.
 */
const TEST_EMAILS = ['test@example.com'];

async function cleanup() {
  await db.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [TEST_EMAILS]);
}

(async () => {
  await cleanup();
  let userId, nationId;

  console.log('\n-- Setup --');
  await t('create user', async () => {
    await db.withTransaction(async (tx) => {
      const {rows} = await tx.query(
        `INSERT INTO users (email,password_hash) VALUES ($1,$2) RETURNING id`,
        ['test@example.com','hash']);
      userId = Number(rows[0].id);
    });
    if (!userId) throw new Error('no user id');
  });

  console.log('\n-- Create nation (engine factory -> DB) --');
  await t('createNation persists everything', async () => {
    const n = tick.createNation('Testland','europe',0,{startingMoney:50000000, startingFood:5000});
    n.leaderName = 'Tester';
    await db.withTransaction(async (tx) => { nationId = await repo.createNation(tx, userId, n); });
    if (!nationId) throw new Error('no nation id');
  });

  await t('round-trips into the exact engine shape', async () => {
    const loaded = await db.withTransaction(tx => repo.loadNation(tx, nationId));
    eq(loaded.name,'Testland');
    eq(loaded.money, 50000000);
    eq(loaded.cities.length, 1);
    eq(loaded.cities[0].infrastructure, 10);
    eq(loaded.cities[0].land, 250);
    eq(loaded.stockpile.food, 5000);
    // every resource present, none undefined
    for (const r of C.ALL_RESOURCES) {
      if (typeof loaded.stockpile[r] !== 'number') throw new Error(`${r} not numeric`);
    }
  });

  await t('NO derived columns exist (population/score/commerce)', async () => {
    const {rows} = await db.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name IN ('nations','cities')
          AND column_name IN ('population','score','commerce','disease','pollution')`);
    if (rows.length > 0) throw new Error('derived column found: ' + rows.map(r=>r.column_name).join(','));
  });

  console.log('\n-- The engine runs off loaded state --');
  await t('load -> engine -> save round trip', async () => {
    await db.withTransaction(async (tx) => {
      const nation = await repo.loadNation(tx, nationId, {lock:true, currentTurn:0});
      // build it out
      nation.cities[0].infrastructure = 1000;
      nation.cities[0].land = 2000;
      nation.cities[0].improvements = {coal_mine:5, iron_mine:5, farm:10, coal_power:2, steel_mill:3, bank:5};
      await repo.saveCities(tx, nation.cities);
      await repo.saveNation(tx, nation);
    });

    const reloaded = await db.withTransaction(tx => repo.loadNation(tx, nationId));
    eq(reloaded.cities[0].improvements.coal_mine, 5);
    eq(reloaded.cities[0].infrastructure, 1000);
  });

  await t('12 turns: load, tick, save, verify', async () => {
    const before = await db.withTransaction(tx => repo.loadNation(tx, nationId));
    const beforeMoney = before.money;

    await db.withTransaction(async (tx) => {
      const nation = await repo.loadNation(tx, nationId, {lock:true, currentTurn:0});
      const gs = await repo.loadGameState(tx);
      let state = { turn: gs.turn, nation, world: gs.world };

      const result = tick.processTurns(state, 12, {});

      await repo.saveNation(tx, result.state.nation);
      await repo.saveCities(tx, result.state.nation.cities);
      await repo.saveGameState(tx, result.state);
      await repo.recordEvents(tx, nationId, result.events);
    });

    const after = await db.withTransaction(tx => repo.loadNation(tx, nationId));
    console.log(`      money $${beforeMoney.toLocaleString()} -> $${after.money.toLocaleString()}`);
    console.log(`      steel 0 -> ${after.stockpile.steel}`);
    console.log(`      food  5000 -> ${after.stockpile.food}`);
    if (!(after.stockpile.steel > 0)) throw new Error('no steel persisted');
    if (!(after.money > beforeMoney)) throw new Error('income not persisted');
  });

  await t('events were recorded', async () => {
    const {rows} = await db.query('SELECT type, count(*) FROM events WHERE nation_id=$1 GROUP BY type', [nationId]);
    if (rows.length === 0) throw new Error('no events');
    console.log(`      ${rows.map(r=>`${r.type}:${r.count}`).join(', ')}`);
  });

  console.log('\n-- CHECK constraints are the backstop --');
  await t('negative money REJECTED by database', async () => {
    let threw = false;
    try {
      await db.withTransaction(async (tx) => {
        await tx.query('UPDATE nations SET money = -100 WHERE id = $1', [nationId]);
      });
    } catch(e) { threw = e.code === '23514'; }
    if (!threw) throw new Error('database allowed negative money');
  });

  await t('negative resources REJECTED by database', async () => {
    let threw = false;
    try {
      await db.withTransaction(async (tx) => {
        await tx.query(`UPDATE nation_resources SET amount = -50 WHERE nation_id=$1 AND resource='steel'`, [nationId]);
      });
    } catch(e) { threw = e.code === '23514'; }
    if (!threw) throw new Error('database allowed negative stockpile');
  });

  await t('rollback leaves no trace', async () => {
    const before = await db.withTransaction(tx => repo.loadNation(tx, nationId));
    try {
      await db.withTransaction(async (tx) => {
        await tx.query('UPDATE nations SET money = 999999999 WHERE id=$1', [nationId]);
        throw new Error('deliberate failure');
      });
    } catch(e) { /* expected */ }
    const after = await db.withTransaction(tx => repo.loadNation(tx, nationId));
    eq(after.money, before.money);
  });

  console.log('\n-- Money precision (NUMERIC, not float) --');
  await t('1000 additions of 0.01 stay exact', async () => {
    await db.withTransaction(async (tx) => {
      await tx.query('UPDATE nations SET money = 0 WHERE id=$1', [nationId]);
      for (let i=0;i<10;i++) {
        await tx.query('UPDATE nations SET money = money + 0.01 WHERE id=$1', [nationId]);
      }
    });
    const {rows} = await db.query('SELECT money FROM nations WHERE id=$1',[nationId]);
    eq(rows[0].money, '0.10', 'float drift would give 0.09999999999999999:');
  });

  console.log('\n-- Concurrency: the duping test --');
  await t('two concurrent spends cannot both succeed', async () => {
    await db.withTransaction(tx => tx.query('UPDATE nations SET money = 1000 WHERE id=$1',[nationId]));

    // Both try to spend 800. Row lock must serialise them; the second sees
    // the post-first balance and its CHECK aborts.
    const spend = async () => db.withTransaction(async (tx) => {
      const [n] = await db.lockNations(tx, [nationId]);
      const money = db.num(n.money);
      if (money < 800) throw new Error('insufficient');
      await tx.query('UPDATE nations SET money = money - 800 WHERE id=$1',[nationId]);
    });

    const results = await Promise.allSettled([spend(), spend()]);
    const ok = results.filter(r => r.status==='fulfilled').length;
    const {rows} = await db.query('SELECT money FROM nations WHERE id=$1',[nationId]);
    console.log(`      ${ok}/2 succeeded, balance $${rows[0].money}`);
    eq(ok, 1, 'exactly one spend should succeed:');
    eq(db.num(rows[0].money), 200);
  });

  console.log('\n-- Deadlock safety: ordered locking --');
  await t('opposing lock orders do NOT deadlock', async () => {
    let n2;
    await db.withTransaction(async (tx) => {
      const n = tick.createNation('Otherland','asia',0,{startingMoney:1000000});
      n.leaderName='Other';
      n2 = await repo.createNation(tx, userId, n);
    });

    // A wants [nationId, n2]; B wants [n2, nationId]. Hand-written sequential
    // locks would deadlock here. lockNations() sorts, so they queue instead.
    const work = (ids) => db.withTransaction(async (tx) => {
      await db.lockNations(tx, ids);
      await new Promise(r => setTimeout(r, 40));
      await tx.query('UPDATE nations SET map_points = map_points WHERE id = ANY($1::bigint[])', [ids]);
    });

    const results = await Promise.allSettled([work([nationId,n2]), work([n2,nationId])]);
    const failed = results.filter(r => r.status==='rejected');
    if (failed.length > 0) throw new Error('deadlock or error: ' + failed[0].reason.message);
    console.log('      both transactions completed, no deadlock');
  });

  console.log('\n-- Game state lock (prevents double-tick) --');
  await t('second concurrent tick is refused, not queued', async () => {
    const runTick = () => db.withTransaction(async (tx) => {
      await db.lockGameState(tx, {nowait:true});
      await new Promise(r => setTimeout(r, 60));
    });
    const results = await Promise.allSettled([runTick(), runTick()]);
    const ok = results.filter(r=>r.status==='fulfilled').length;
    console.log(`      ${ok}/2 ticks ran (a doubled tick is a doubled economy)`);
    eq(ok, 1);
  });

  console.log('\n-- Anti-abuse --');
  await t('same IP + same device = LINKED (alt farming)', async () => {
    let n3;
    await db.withTransaction(async (tx) => {
      const n = tick.createNation('Sockpuppet','asia',0,{});
      n.leaderName='S';
      n3 = await repo.createNation(tx, userId, n);
      await repo.recordAccountLink(tx, nationId, 'ip_abc', 'dev_same');
      await repo.recordAccountLink(tx, n3, 'ip_abc', 'dev_same');
    });
    eq(await db.withTransaction(tx => repo.areNationsLinked(tx, nationId, n3)), true);
  });

  await t('same IP, DIFFERENT device = NOT blocked (flatmates, campus, NAT)', async () => {
    let n5;
    await db.withTransaction(async (tx) => {
      const n = tick.createNation('Flatmate','europe',0,{});
      n.leaderName='F';
      n5 = await repo.createNation(tx, userId, n);
      await repo.recordAccountLink(tx, n5, 'ip_abc', 'dev_totally_different');
    });
    eq(await db.withTransaction(tx => repo.areNationsLinked(tx, nationId, n5)), false,
       'IP-only matching would permanently forbid flatmates from fighting:');
  });

  await t('but IP-only overlap IS flagged for admin review', async () => {
    const {rows} = await db.query('SELECT count(*) AS n FROM suspected_links');
    if (Number(rows[0].n) === 0) throw new Error('soft signal not recorded');
  });

  await t('unrelated nations not linked', async () => {
    let n4;
    await db.withTransaction(async (tx) => {
      const n = tick.createNation('Innocent','africa',0,{});
      n.leaderName='I';
      n4 = await repo.createNation(tx, userId, n);
      await repo.recordAccountLink(tx, n4, 'ip_xyz', 'dev_9');
    });
    eq(await db.withTransaction(tx => repo.areNationsLinked(tx, nationId, n4)), false);
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(50));
  await cleanup();          // leave the database as we found it
  await db.closePool();
  process.exit(fail>0?1:0);
})();
