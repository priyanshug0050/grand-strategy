/**
 * ==========================================================================
 *  test-frontend.js — is the frontend actually reachable and wired up?
 * ==========================================================================
 *
 *  The other suites prove the engine, database and API work. None of them
 *  prove a BROWSER can load the game. This one boots the real server and
 *  fetches the same URLs a browser would.
 *
 *  It catches the failures that are invisible to every other test:
 *    - a file missing from public/ (blank page, no error anywhere)
 *    - api.js failing to load (every page dies with "API is not defined")
 *    - the API 404 handler swallowing frontend routes
 *    - the snapshot missing a field the ledger renders (undefined on screen)
 */

require('dotenv').config({ quiet: true });

// Dedicated port, forced BEFORE requiring the server — otherwise this collides
// with a running dev server or VS Code Live Preview on 3000, and every request
// silently reaches the wrong process.
process.env.PORT = process.env.TEST_PORT || '3112';

const { start } = require('../server');
const db = require('../src/data/db');
const scheduler = require('../src/scheduler');

let pass = 0, fail = 0;
async function t(n, f) {
  try { await f(); console.log('  PASS ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + ' -> ' + e.message); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ''} expected ${b}, got ${a}`); }
function has(text, needle, what) {
  if (!String(text).includes(needle)) throw new Error(`${what} missing "${needle}"`);
}

const BASE = 'http://127.0.0.1:' + process.env.PORT;
const TEST_EMAIL = 'frontend@test.com';

async function get(path, token) {
  const res = await fetch(BASE + path, {
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  const ct = res.headers.get('content-type') || '';
  return {
    status: res.status,
    contentType: ct,
    body: ct.includes('json') ? await res.json() : await res.text(),
  };
}

async function cleanup() {
  await db.query('DELETE FROM users WHERE email = $1', [TEST_EMAIL]);
}

(async () => {
  const server = await start();
  await cleanup();
  await new Promise(r => setTimeout(r, 300));

  console.log('\n-- Static files reach the browser --');

  await t('/ serves the login page', async () => {
    const r = await get('/');
    eq(r.status, 200);
    has(r.body, 'Grand Strategy', 'index.html');
  });

  await t('stylesheet loads', async () => {
    const r = await get('/css/app.css');
    eq(r.status, 200);
    has(r.body, '--phosphor', 'app.css');
    has(r.body, '.ledger', 'app.css');
  });

  await t('api.js loads (or every page dies with "API is not defined")', async () => {
    const r = await get('/js/api.js');
    eq(r.status, 200);
    has(r.body, 'const API', 'api.js');
    has(r.body, 'requireLogin', 'api.js');
  });

  await t('dashboard.js loads', async () => {
    const r = await get('/js/dashboard.js');
    eq(r.status, 200);
    has(r.body, 'populationLedger', 'dashboard.js');
  });

  await t('dashboard.html loads', async () => {
    const r = await get('/dashboard.html');
    eq(r.status, 200);
    has(r.body, 'Situation', 'dashboard.html');
  });

  await t('script order is correct — api.js before dashboard.js', async () => {
    const r = await get('/dashboard.html');
    const apiPos = r.body.indexOf('/js/api.js');
    const dashPos = r.body.indexOf('/js/dashboard.js');
    if (apiPos === -1 || dashPos === -1) throw new Error('a script tag is missing');
    if (apiPos > dashPos) throw new Error('api.js loads AFTER dashboard.js — "API is not defined"');
  });

  console.log('\n-- Routing does not swallow the frontend --');

  await t('unknown API path returns JSON, not HTML', async () => {
    const r = await get('/api/does-not-exist');
    eq(r.status, 404);
    if (!r.contentType.includes('json')) throw new Error('got ' + r.contentType);
  });

  await t('unknown page falls back to the app, not JSON', async () => {
    const r = await get('/some-page-that-does-not-exist');
    if (r.contentType.includes('json')) throw new Error('frontend route returned JSON');
  });

  console.log('\n-- Data the UI actually renders --');

  await t('signup page can populate its continent list', async () => {
    const r = await get('/api/reference');
    eq(r.status, 200);
    if (!Array.isArray(r.body.continents) || r.body.continents.length === 0) {
      throw new Error('no continents — signup dropdown would be empty');
    }
    if (typeof r.body.turnIntervalMs !== 'number') {
      throw new Error('turnIntervalMs missing');
    }
  });

  await t('turn countdown has what it needs', async () => {
    const r = await get('/api/health');
    eq(r.status, 200);
    if (!r.body.lastTick) throw new Error('lastTick missing — countdown cannot render');
    if (typeof r.body.turnIntervalMs !== 'number') throw new Error('turnIntervalMs missing');
  });

  // Register a real nation so the ledger has something to render.
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'frontend-test' },
    body: JSON.stringify({
      email: TEST_EMAIL, password: 'password123',
      nationName: 'Ledgerland', leaderName: 'Tester', continent: 'europe',
    }),
  });
  const { token } = await reg.json();

  await t('THE LEDGER: every field it displays is present', async () => {
    if (!token) throw new Error('registration failed, cannot check');
    const r = await get('/api/nation', token);
    eq(r.status, 200);

    const d = r.body.perCity[0] && r.body.perCity[0].populationDetail;
    if (!d) throw new Error('populationDetail missing — ledger would be blank');

    // Exactly the fields populationLedger() renders. A missing one shows as
    // "undefined" on screen with no error in the console.
    for (const k of ['basePopulation', 'diseaseRatePercent', 'diseaseDeaths',
                     'crimeRatePercent', 'crimeDeaths', 'ageMultiplier',
                     'cityAgeDays', 'population', 'density']) {
      if (d[k] === undefined) throw new Error(`ledger field "${k}" missing`);
      if (typeof d[k] !== 'number') throw new Error(`ledger field "${k}" is not a number`);
    }
  });

  await t('treasury panel has its itemised figures', async () => {
    const r = await get('/api/nation', token);
    for (const k of ['grossIncomePerDay', 'improvementUpkeepPerDay',
                     'unitUpkeepPerDay', 'netIncomePerDay', 'netIncomePerTurn']) {
      if (typeof r.body.revenue[k] !== 'number') throw new Error(`revenue.${k} missing`);
    }
  });

  await t('vitals panel has score, war range and vulnerability', async () => {
    const r = await get('/api/nation', token);
    for (const k of ['score', 'totalPopulation', 'warRange', 'vulnerableTo', 'colorState']) {
      if (r.body[k] === undefined) throw new Error(`${k} missing`);
    }
    if (typeof r.body.warRange.min !== 'number') throw new Error('warRange.min missing');
    if (typeof r.body.vulnerableTo.max !== 'number') throw new Error('vulnerableTo.max missing');
  });

  await t('density bar has infra and land to compare', async () => {
    const r = await get('/api/nation', token);
    const c = r.body.perCity[0];
    if (typeof c.infrastructure !== 'number') throw new Error('perCity.infrastructure missing');
    if (typeof c.land !== 'number') throw new Error('perCity.land missing');
    if (typeof c.id !== 'number') throw new Error('perCity.id missing — actions cannot target a city');
  });

  console.log('\n-- Cities page --');

  await t('cities.html loads', async () => {
    const r = await get('/cities.html');
    eq(r.status, 200);
    has(r.body, 'Improvements', 'cities.html');
  });

  await t('cities.js loads and comes AFTER api.js', async () => {
    const r = await get('/js/cities.js');
    eq(r.status, 200);
    has(r.body, 'renderPreview', 'cities.js');
    const page = await get('/cities.html');
    if (page.body.indexOf('/js/api.js') > page.body.indexOf('/js/cities.js')) {
      throw new Error('api.js loads after cities.js');
    }
  });

  await t('PREVIEW: cost and consequence before committing', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    const res = await fetch(BASE + `/api/city/${cityId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ infrastructure: 500, land: 250 }),
    });
    eq(res.status, 200);
    const p = await res.json();
    for (const k of ['infraCost','totalCost','affordable','before','after','populationChange','slotsAfter']) {
      if (p[k] === undefined) throw new Error(`preview.${k} missing`);
    }
    if (!(p.infraCost > 0)) throw new Error('infra cost should be positive');
    if (!(p.after.diseaseRatePercent > p.before.diseaseRatePercent)) {
      throw new Error('50x infra with no extra land should RAISE disease');
    }
  });

  await t('preview matches what the purchase actually charges', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    const pre = await fetch(BASE + `/api/city/${cityId}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ infrastructure: 200 }),
    }).then(r => r.json());

    const buy = await fetch(BASE + `/api/city/${cityId}/infrastructure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ target: 200 }),
    }).then(r => r.json());

    if (Math.abs(pre.infraCost - buy.cost) > 0.01) {
      throw new Error(`preview said ${pre.infraCost}, charged ${buy.cost} — the UI would be lying`);
    }
  });

  console.log('\n-- Cities: improvement counts (the bug) --');

  await t('perCity carries its own improvements map', async () => {
    const r = await get('/api/nation', token);
    const c = r.body.perCity[0];
    if (c.improvements === undefined) {
      throw new Error('perCity.improvements missing — every count renders as 0 and demolish stays disabled');
    }
    if (typeof c.improvements !== 'object') throw new Error('improvements is not an object');
  });

  await t('built improvements actually appear in the snapshot', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;

    // Need slots before anything can be built.
    await fetch(BASE + `/api/city/${cityId}/infrastructure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ target: 500 }),
    });
    const build = await fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ improvement: 'coal_mine', count: 3 }),
    }).then(r => r.json());
    if (build.total !== 3) throw new Error('build failed: ' + JSON.stringify(build));

    const after = await get('/api/nation', token);
    const c = after.body.perCity.find(x => x.id === cityId);
    if (c.improvements.coal_mine !== 3) {
      throw new Error(`snapshot says ${c.improvements.coal_mine} coal mines, should be 3`);
    }
    if (c.usedSlots !== 3) throw new Error(`usedSlots ${c.usedSlots}, should be 3`);
  });

  await t('DEMOLISH works and the count drops', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;

    const r = await fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ improvement: 'coal_mine', count: -2 }),
    }).then(r => r.json());
    if (r.total !== 1) throw new Error('demolish left ' + r.total + ', expected 1');

    const after = await get('/api/nation', token);
    const c = after.body.perCity.find(x => x.id === cityId);
    if (c.improvements.coal_mine !== 1) throw new Error('snapshot not updated after demolish');
  });

  await t('cannot demolish more than you own', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    const res = await fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ improvement: 'coal_mine', count: -99 }),
    });
    eq(res.status, 400);
  });

  await t('reference exposes recipes so the UI can show conversions', async () => {
    const r = await get('/api/reference');
    if (!r.body.recipes || !r.body.recipes.steel) throw new Error('recipes missing');
    if (!r.body.recipes.steel.inputs) throw new Error('recipe inputs missing');
  });

  console.log('\n-- Military page --');

  await t('military.html loads', async () => {
    const r = await get('/military.html');
    eq(r.status, 200);
    has(r.body, 'Targets in range', 'military.html');
  });

  await t('military.js loads and comes AFTER api.js', async () => {
    const r = await get('/js/military.js');
    eq(r.status, 200);
    has(r.body, 'showOdds', 'military.js');
    const page = await get('/military.html');
    if (page.body.indexOf('/js/api.js') > page.body.indexOf('/js/military.js')) {
      throw new Error('api.js loads after military.js');
    }
  });

  await t('target finder returns a war range', async () => {
    const r = await get('/api/targets', token);
    eq(r.status, 200);
    if (typeof r.body.myScore !== 'number') throw new Error('myScore missing');
    if (typeof r.body.range.min !== 'number') throw new Error('range.min missing');
    if (!Array.isArray(r.body.targets)) throw new Error('targets not an array');
  });

  await t('targets say WHY they cannot be attacked', async () => {
    const r = await get('/api/targets', token);
    for (const t of r.body.targets) {
      if (!t.attackable && !t.blockedReason) {
        throw new Error(`${t.name} is blocked with no reason given`);
      }
      if (t.onBeige && t.attackable) throw new Error('beige target marked attackable');
    }
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('='.repeat(50));

  await cleanup();
  scheduler.stop();
  server.close();
  await db.closePool();
  process.exit(fail > 0 ? 1 : 0);
})();
