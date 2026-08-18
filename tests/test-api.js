require('dotenv').config({quiet:true});

/**
 * Force a dedicated test port BEFORE requiring the server.
 *
 * Without this the suite uses PORT from .env — usually 3000 — and collides
 * with whatever is already there: a leftover `npm start`, or VS Code's Live
 * Preview. On Windows two processes can bind the same port on different
 * interfaces, so Node happily reports "listening" while requests to
 * 127.0.0.1 reach the OTHER process. Every route then 404s and it looks like
 * the routes vanished.
 *
 * Override with TEST_PORT if 3111 is also taken.
 */
process.env.PORT = process.env.TEST_PORT || '3111';

const { start } = require('../server');
const db = require('../src/data/db');
const scheduler = require('../src/scheduler');

let pass=0, fail=0;
async function t(n,f){ try{ await f(); console.log('  PASS '+n); pass++; }catch(e){ console.log('  FAIL '+n+' -> '+e.message); fail++; } }
function eq(a,b,m){ if(a!==b) throw new Error(`${m||''} expected ${b}, got ${a}`); }

const BASE = 'http://127.0.0.1:' + process.env.PORT;
let token, token2, cityId, nationId, nationId2, warId;

async function api(path, opts={}) {
  const res = await fetch(BASE+path, {
    method: opts.method || 'GET',
    headers: {
      'Content-Type':'application/json',
      // Distinct UA per simulated player. All requests share 127.0.0.1, so
      // without this every test nation looks like one person's alt army —
      // which is the anti-multi-accounting system working correctly.
      'User-Agent': opts.ua || 'test-agent-default',
      ...(opts.token ? {Authorization:'Bearer '+opts.token} : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(()=>({}));
  return { status: res.status, body: json };
}

/**
 * These tests register real users. Without a reset they pass once and then
 * fail on a duplicate email, which looks like a regression but is just
 * leftover data. Clear this suite's own rows first — deleting a user cascades
 * to its nations, cities, wars and battles.
 */
const TEST_EMAILS = ['a@test.com','d@test.com','e@test.com','alt@test.com','alt2@test.com','ui@t.com'];

async function cleanup() {
  await db.query(`DELETE FROM users WHERE email = ANY($1::text[])`, [TEST_EMAILS]);
}

(async () => {
  const server = await start();
  await cleanup();
  await new Promise(r=>setTimeout(r,300));

  console.log('\n-- Health --');
  await t('health responds', async () => {
    const r = await api('/api/health');
    eq(r.status,200); eq(r.body.ok,true);
  });

  console.log('\n-- Auth --');
  await t('register creates user + nation', async () => {
    const r = await api('/api/auth/register',{method:'POST',body:{
      email:'a@test.com', password:'password123', nationName:'Alpha',
      leaderName:'Leader A', continent:'europe'}, ua:'player-alpha'});
    eq(r.status,201);
    if (!r.body.token) throw new Error('no token');
    token = r.body.token; nationId = r.body.nationId;
  });
  await t('duplicate email rejected', async () => {
    const r = await api('/api/auth/register',{method:'POST',body:{
      email:'a@test.com', password:'password123', nationName:'Dup', continent:'asia'}});
    eq(r.status,400);
  });
  await t('invalid continent rejected', async () => {
    const r = await api('/api/auth/register',{method:'POST',body:{
      email:'b@test.com',password:'password123',nationName:'B',continent:'atlantis'}});
    eq(r.status,400);
  });
  await t('short password rejected', async () => {
    const r = await api('/api/auth/register',{method:'POST',body:{
      email:'c@test.com',password:'123',nationName:'C',continent:'asia'}});
    if (r.status === 201) throw new Error('accepted short password');
  });
  await t('login works', async () => {
    const r = await api('/api/auth/login',{method:'POST',body:{email:'a@test.com',password:'password123'}});
    eq(r.status,200); if(!r.body.token) throw new Error('no token');
  });
  await t('wrong password + unknown email give IDENTICAL response', async () => {
    const wrong = await api('/api/auth/login',{method:'POST',body:{email:'a@test.com',password:'nope12345'}});
    const unknown = await api('/api/auth/login',{method:'POST',body:{email:'nobody@test.com',password:'nope12345'}});
    eq(wrong.status, unknown.status);
    eq(JSON.stringify(wrong.body), JSON.stringify(unknown.body), 'must not enumerate emails:');
  });

  console.log('\n-- Auth enforcement --');
  await t('protected route rejects no token', async () => {
    eq((await api('/api/nation')).status, 401);
  });
  await t('protected route rejects garbage token', async () => {
    eq((await api('/api/nation',{token:'not.a.real.token'})).status, 401);
  });

  console.log('\n-- Nation snapshot --');
  await t('returns full derived state', async () => {
    const r = await api('/api/nation',{token});
    eq(r.status,200);
    for (const k of ['score','totalPopulation','revenue','warRange','perCity','colorState']) {
      if (r.body[k]===undefined) throw new Error('missing '+k);
    }
    cityId = r.body.perCity[0] ? (await db.query('SELECT id FROM cities WHERE nation_id=$1',[nationId])).rows[0].id : null;
    console.log(`      score ${r.body.score}, pop ${r.body.totalPopulation}, money $${r.body.nation.money.toLocaleString()}`);
  });
  await t('new nation is beige-protected', async () => {
    const r = await api('/api/nation',{token});
    eq(r.body.colorState.color,'beige');
    eq(r.body.colorState.immuneToNewDeclarations,true);
  });

  console.log('\n-- City actions --');
  await t('buy infrastructure', async () => {
    const r = await api(`/api/city/${cityId}/infrastructure`,{method:'POST',token,body:{target:500}});
    eq(r.status,200); eq(r.body.infrastructure,500);
    console.log(`      cost $${r.body.cost.toLocaleString()}, efficient: ${r.body.efficient}`);
  });
  await t('inefficient purchase warns but succeeds', async () => {
    const r = await api(`/api/city/${cityId}/infrastructure`,{method:'POST',token,body:{target:550}});
    eq(r.status,200); eq(r.body.efficient,false);
    if(!r.body.warning) throw new Error('no warning given');
  });
  await t('buy land', async () => {
    const r = await api(`/api/city/${cityId}/land`,{method:'POST',token,body:{target:1000}});
    eq(r.status,200); eq(r.body.land,1000);
  });
  await t('build improvements', async () => {
    const r = await api(`/api/city/${cityId}/improvements`,{method:'POST',token,body:{improvement:'coal_mine',count:5}});
    eq(r.status,200); eq(r.body.total,5);
  });
  await t('per-city limit enforced (400 not 500)', async () => {
    const r = await api(`/api/city/${cityId}/improvements`,{method:'POST',token,body:{improvement:'coal_mine',count:20}});
    eq(r.status,400);
    if(!r.body.error.includes('limit')) throw new Error(r.body.error);
  });
  await t('unaffordable purchase rejected', async () => {
    const r = await api(`/api/city/${cityId}/infrastructure`,{method:'POST',token,body:{target:99999}});
    eq(r.status,400);
  });
  await t('bad input rejected before touching DB', async () => {
    eq((await api(`/api/city/${cityId}/infrastructure`,{method:'POST',token,body:{target:'lots'}})).status, 400);
    eq((await api(`/api/city/${cityId}/improvements`,{method:'POST',token,body:{improvement:'coal_mine',count:0}})).status, 400);
  });

  console.log('\n-- Ownership: cannot act on another nation --');
  await t('register second nation', async () => {
    const r = await api('/api/auth/register',{method:'POST',body:{
      email:'d@test.com',password:'password123',nationName:'Bravo',leaderName:'B',continent:'asia'}, ua:'player-bravo'});
    eq(r.status,201); token2=r.body.token; nationId2=r.body.nationId;
  });
  await t('cannot buy infra in someone else\'s city', async () => {
    const r = await api(`/api/city/${cityId}/infrastructure`,{method:'POST',token:token2,body:{target:600}});
    eq(r.status,400);
    if(!r.body.error.includes('City not found')) throw new Error(r.body.error);
  });

  console.log('\n-- Military --');
  await t('recruit soldiers', async () => {
    await api(`/api/city/${cityId}/improvements`,{method:'POST',token,body:{improvement:'barracks',count:3}});
    const r = await api('/api/military/recruit',{method:'POST',token,body:{unit:'soldiers',count:1000}});
    eq(r.status,200); eq(r.body.total,1000);
  });
  await t('daily recruitment cap enforced', async () => {
    const r = await api('/api/military/recruit',{method:'POST',token,body:{unit:'soldiers',count:999999}});
    eq(r.status,400);
  });

  console.log('\n-- War --');
  await t('cannot declare on beige nation', async () => {
    const r = await api('/api/war/declare',{method:'POST',token,body:{targetId:nationId2,warType:'ordinary'}});
    eq(r.status,400);
    if(!r.body.error.toLowerCase().includes('beige')) throw new Error(r.body.error);
  });
  await t('cannot declare war on yourself', async () => {
    const r = await api('/api/war/declare',{method:'POST',token,body:{targetId:nationId}});
    eq(r.status,400);
  });
  await t('war declaration works once beige lifts', async () => {
    await db.query(`UPDATE nations SET beige_until_turn = NULL, color='blue' WHERE id IN ($1,$2)`,[nationId,nationId2]);
    // make scores comparable
    await db.query(`UPDATE cities SET infrastructure=500 WHERE nation_id=$1`,[nationId2]);
    const r = await api('/api/war/declare',{method:'POST',token,body:{targetId:nationId2,warType:'raid'}});
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    warId = r.body.warId;
  });
  await t('duplicate war rejected', async () => {
    const r = await api('/api/war/declare',{method:'POST',token,body:{targetId:nationId2}});
    eq(r.status,400);
  });
  await t('attack BLOCKED with no MAP (action points must accrue)', async () => {
    const r = await api(`/api/war/${warId}/attack`,{method:'POST',token,body:{attackType:'ground_battle'}});
    eq(r.status,400);
    if(!r.body.error.includes('MAP')) throw new Error(r.body.error);
  });
  await t('attack executes and records a seed', async () => {
    for (let i=0;i<5;i++) await scheduler.runTurn();   // accrue MAP
    const r = await api(`/api/war/${warId}/attack`,{method:'POST',token,body:{attackType:'ground_battle'}});
    if (r.status!==200) throw new Error(JSON.stringify(r.body));
    console.log(`      ${r.body.victoryName}, resistance now ${r.body.resistanceRemaining}`);
    if (typeof r.body.seed !== 'number') throw new Error('no seed returned');
  });
  await t('BATTLE REPLAYS from stored seed', async () => {
    const {rows} = await db.query('SELECT id FROM battles ORDER BY id DESC LIMIT 1');
    const r = await api(`/api/battle/${rows[0].id}`,{token});
    eq(r.status,200);
    eq(r.body.verified, true, 'replay must reproduce the recorded outcome:');
    console.log(`      replay reproduced victoryType ${r.body.replay.victoryType} exactly`);
  });
  await t('non-participant cannot attack in a war', async () => {
    const r = await api('/api/auth/register',{method:'POST',body:{
      email:'e@test.com',password:'password123',nationName:'Charlie',continent:'africa'}, ua:'player-charlie'});
    const r2 = await api(`/api/war/${warId}/attack`,{method:'POST',token:r.body.token,body:{attackType:'ground_battle'}});
    eq(r2.status,400);
    if(!r2.body.error.includes('not a participant')) throw new Error(r2.body.error);
  });

  await t('LINKED accounts still blocked from warring', async () => {
    // ALLOW_LINKED_WARS is an escape hatch for local testing and shared
    // connections, and it is read per request. Leaving it to whatever is in
    // .env made this test report on the developer's config rather than on the
    // code: set it to true to fight your own alts locally and this test starts
    // failing for a reason that has nothing to do with the guard.
    const flagBefore = process.env.ALLOW_LINKED_WARS;
    process.env.ALLOW_LINKED_WARS = 'false';
    try {
      const alt = await api('/api/auth/register',{method:'POST',body:{
        email:'alt@test.com',password:'password123',nationName:'AlphaAlt',continent:'europe'},
        ua:'player-alpha'});   // same fingerprint as Alpha
      await db.query(`UPDATE nations SET beige_until_turn = NULL, color='blue' WHERE id=$1`,[alt.body.nationId]);
      await db.query('UPDATE cities SET infrastructure=500 WHERE nation_id=$1',[alt.body.nationId]);
      const r = await api('/api/war/declare',{method:'POST',token,ua:'player-alpha',
        body:{targetId:alt.body.nationId}});
      eq(r.status,400);
      if(!r.body.error.includes('linked')) throw new Error(r.body.error);
    } finally {
      if (flagBefore === undefined) delete process.env.ALLOW_LINKED_WARS;
      else process.env.ALLOW_LINKED_WARS = flagBefore;
    }
  });

  await t('ALLOW_LINKED_WARS=true really does open the gate (and is a prod footgun)', async () => {
    // The other half of the same guard. If this ever stops working the escape
    // hatch is dead and local testing gets painful; if the test above stops
    // working, live alt-farming is wide open. Both directions are asserted so
    // neither can rot unnoticed.
    const flagBefore = process.env.ALLOW_LINKED_WARS;
    process.env.ALLOW_LINKED_WARS = 'true';
    try {
      const alt2 = await api('/api/auth/register',{method:'POST',body:{
        email:'alt2@test.com',password:'password123',nationName:'AlphaAlt2',continent:'europe'},
        ua:'player-alpha'});
      await db.query(`UPDATE nations SET beige_until_turn = NULL, color='blue' WHERE id=$1`,[alt2.body.nationId]);
      await db.query('UPDATE cities SET infrastructure=500 WHERE nation_id=$1',[alt2.body.nationId]);
      const r = await api('/api/war/declare',{method:'POST',token,ua:'player-alpha',
        body:{targetId:alt2.body.nationId}});
      if (r.status !== 201) throw new Error('escape hatch did not open: ' + JSON.stringify(r.body));
    } finally {
      if (flagBefore === undefined) delete process.env.ALLOW_LINKED_WARS;
      else process.env.ALLOW_LINKED_WARS = flagBefore;
    }
  });
  await t('invalid war id gives 400, not 500', async () => {
    const r = await api('/api/war/abc/attack',{method:'POST',token,body:{attackType:'ground_battle'}});
    eq(r.status,400);
  });

  console.log('\n-- Scheduler --');
  await t('a turn advances the clock and pays nations', async () => {
    const before = (await api('/api/health')).body.turn;
    const moneyBefore = (await api('/api/nation',{token})).body.nation.money;
    for (let i=0;i<12;i++) await scheduler.runTurn();
    const after = (await api('/api/health')).body.turn;
    const moneyAfter = (await api('/api/nation',{token})).body.nation.money;
    eq(after, before+12);
    console.log(`      turn ${before} -> ${after}, money $${moneyBefore.toLocaleString()} -> $${moneyAfter.toLocaleString()}`);
  });
  await t('overlapping ticks are refused', async () => {
    const results = await Promise.all([scheduler.runTurn(), scheduler.runTurn()]);
    const skipped = results.filter(r=>r.skipped).length;
    eq(skipped,1,'exactly one tick should be skipped:');
  });
  await t('events were written', async () => {
    const r = await api('/api/nation/events',{token});
    if (r.body.events.length===0) throw new Error('no events');
    const types = [...new Set(r.body.events.map(e=>e.type))];
    console.log(`      ${types.join(', ')}`);
  });

  console.log('\n-- Reference data --');
  await t('reference endpoint serves game data', async () => {
    const r = await api('/api/reference');
    eq(r.status,200);
    if (Object.keys(r.body.improvements).length < 20) throw new Error('improvements missing');
  });

  console.log('\n-- Error handling --');
  await t('404 for unknown route', async () => eq((await api('/api/nope')).status,404));
  await t('errors never leak stack traces', async () => {
    const r = await api(`/api/city/999999/infrastructure`,{method:'POST',token,body:{target:100}});
    const s = JSON.stringify(r.body);
    if (s.includes('at ') || s.includes('SELECT') || s.includes('node_modules')) {
      throw new Error('leaked internals: '+s);
    }
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(50));
  await cleanup();          // leave the database as we found it
  scheduler.stop(); server.close(); await db.closePool();
  process.exit(fail>0?1:0);
})();
