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

  console.log('\n-- Economy ledger --');

  await t('economy.html loads', async () => {
    const r = await get('/economy.html');
    eq(r.status, 200);
    has(r.body, 'Where it comes from', 'economy.html');
  });

  await t('economy.js loads and comes AFTER api.js', async () => {
    const r = await get('/js/economy.js');
    eq(r.status, 200);
    has(r.body, 'renderByImprovement', 'economy.js');
    const page = await get('/economy.html');
    if (page.body.indexOf('/js/api.js') > page.body.indexOf('/js/economy.js')) {
      throw new Error('api.js loads after economy.js');
    }
  });

  await t('every page links to the economy ledger', async () => {
    for (const p of ['/dashboard.html','/cities.html','/military.html','/market.html']) {
      const r = await get(p);
      if (!r.body.includes('economy.html')) throw new Error(`${p} has no Economy nav link`);
    }
  });

  await t('ledger returns every section the page renders', async () => {
    const r = await get('/api/economy', token);
    eq(r.status, 200);
    for (const k of ['turn','money','totalPopulation','cash','food','flow','byImprovement','perCity']) {
      if (r.body[k] === undefined) throw new Error(`economy.${k} missing`);
    }
    for (const k of ['grossIncomePerDay','improvementUpkeepPerDay','unitUpkeepPerDay','netIncomePerDay','outOfFood']) {
      if (r.body.cash[k] === undefined) throw new Error(`cash.${k} missing`);
    }
  });

  await t('RUNWAY: a deficit reports turns remaining, not just a rate', async () => {
    const r = await get('/api/economy', token);
    const food = r.body.flow.food;
    for (const k of ['stockpile','producedPerTurn','consumedPerTurn','netPerTurn','turnsRemaining']) {
      if (food[k] === undefined) throw new Error(`flow.food.${k} missing`);
    }
    // A new nation eats food and grows none, so it must have a finite runway.
    if (food.netPerTurn >= 0) throw new Error('new nation should be running a food deficit');
    if (food.turnsRemaining === null) throw new Error('deficit with stock must report a runway');
    if (!(food.turnsRemaining > 0)) throw new Error('runway should be positive');
  });

  await t('ATTRIBUTION: production traces to the building that made it', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    const post = (body) => fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }).then(r => r.json());

    // Earlier tests may already have built some, so compare against the
    // count the snapshot reports rather than assuming a fresh city.
    await post({ improvement: 'coal_mine', count: 2 });

    const after = await get('/api/nation', token);
    const expected = after.body.perCity.find(c => c.id === cityId).improvements.coal_mine;

    const r = await get('/api/economy', token);
    const mine = r.body.byImprovement.find(l => l.key === 'coal_mine');
    if (!mine) throw new Error('coal_mine missing from attribution table');
    if (!(mine.produces.coal > 0)) throw new Error('coal_mine shows no coal production');
    if (mine.count !== expected) throw new Error(`ledger says ${mine.count}, city has ${expected}`);
    if (!mine.cities.length) throw new Error('no city attributed');
  });

  await t('IDLE DIAGNOSIS: says WHY a building produces nothing', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    // A steel mill with no power is the classic case.
    await fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ improvement: 'steel_mill', count: 1 }),
    });

    const r = await get('/api/economy', token);
    const city = r.body.perCity.find(c => c.id === cityId);
    if (!Array.isArray(city.idle)) throw new Error('idle is not an array');
    if (!city.powered) {
      const mill = city.idle.find(i => i.key === 'steel_mill');
      if (!mill) throw new Error('unpowered steel mill not reported as idle');
      if (!mill.reason) throw new Error('idle building has no reason given');
    }
  });

  await t('MATERIALS: commerce building blocked without steel', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    // Ensure there is no steel to spend.
    await db.query(
      `UPDATE nation_resources SET amount = 0 WHERE nation_id = $1 AND resource IN ('steel','aluminum')`,
      [snap.body.nation.id]);

    const res = await fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ improvement: 'supermarket', count: 1 }),
    });
    eq(res.status, 400);
    const body = await res.json();
    if (!body.error.includes('steel')) throw new Error('error does not name the missing material');
    if (!body.missing) throw new Error('no missing-materials breakdown returned');
  });

  await t('MATERIALS: succeeds once you have them, and they are DEDUCTED', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    await db.query(
      `UPDATE nation_resources SET amount = 500 WHERE nation_id = $1 AND resource IN ('steel','aluminum')`,
      [snap.body.nation.id]);

    const r = await fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ improvement: 'supermarket', count: 1 }),
    }).then(r => r.json());

    if (!r.materials || !r.materials.steel) throw new Error('build did not report materials');

    const after = await get('/api/nation', token);
    const steelLeft = after.body.nation.stockpile.steel;
    if (steelLeft >= 500) throw new Error(`steel not deducted: ${steelLeft}`);
    if (Math.abs(steelLeft - (500 - r.materials.steel)) > 0.01) {
      throw new Error(`deducted the wrong amount: ${500 - steelLeft} vs ${r.materials.steel}`);
    }
  });

  await t('MATERIALS: demolition salvages half, no money back', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    const before = snap.body.nation.stockpile.steel;

    const r = await fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ improvement: 'supermarket', count: -1 }),
    }).then(r => r.json());

    if (!r.salvage || !r.salvage.steel) throw new Error('no salvage returned');
    eq(r.refund, 0, 'money should never be refunded:');

    const after = await get('/api/nation', token);
    if (!(after.body.nation.stockpile.steel > before)) throw new Error('salvage not credited');
  });

  await t('reference exposes materials so the UI can show costs', async () => {
    const r = await get('/api/reference');
    const bank = r.body.improvements.bank;
    if (!bank.materials) throw new Error('bank has no materials in reference data');
    if (!bank.materials.steel) throw new Error('bank materials missing steel');
    // Raw buildings must stay material-free.
    const mine = r.body.improvements.coal_mine;
    if (mine.materials && Object.keys(mine.materials).length) {
      throw new Error('coal_mine should need no materials');
    }
  });

  await t('EVERY building explains itself in its OWN terms', async () => {
    const snap = await get('/api/nation', token);
    const cityId = snap.body.perCity[0].id;
    const build = (improvement, count) => fetch(BASE + `/api/city/${cityId}/improvements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ improvement, count }),
    });
    // One from each category that produces no RESOURCE — these were the rows
    // showing nothing but dashes.
    await build('bank', 1);
    await build('police_station', 1);
    await build('barracks', 1);

    const r = await get('/api/economy', token);
    const expect = {
      bank: 'commerce',
      police_station: 'crime',
      barracks: 'holds',
    };
    for (const [key, label] of Object.entries(expect)) {
      const line = r.body.byImprovement.find(l => l.key === key);
      if (!line) continue;   // slots may have run out
      if (!line.effect) throw new Error(`${key} has no effect description`);
      if (!line.effect.parts.some(p => p.label === label)) {
        throw new Error(`${key} does not report "${label}" — its row would be empty`);
      }
    }
  });

  await t('POWER: ledger says WHICH power problem it is', async () => {
    const r = await get('/api/economy', token);
    const city = r.body.perCity[0];
    if (!city.power) throw new Error('perCity.power missing');
    if (city.power.powered === undefined) throw new Error('power.powered missing');
    if (!city.powered) {
      if (!['capacity','fuel'].includes(city.power.reason)) {
        throw new Error(`unpowered city gave reason "${city.power.reason}"`);
      }
      if (!city.power.message) throw new Error('no message explaining the outage');
    }
  });

  console.log('\n-- Mobile --');

  await t('mobile.css is served', async () => {
    const r = await get('/css/mobile.css');
    eq(r.status, 200);
    has(r.body, '@media (max-width: 640px)', 'mobile.css');
    has(r.body, 'data-label', 'mobile.css');
  });

  await t('EVERY page loads mobile.css, and AFTER app.css', async () => {
    // Order matters: mobile.css overrides, so it must come second.
    for (const p of ['/index.html','/dashboard.html','/cities.html','/economy.html',
                     '/policy.html','/market.html','/military.html','/admin.html']) {
      const r = await get(p);
      if (!r.body.includes('mobile.css')) throw new Error(`${p} does not load mobile.css`);
      if (r.body.indexOf('app.css') > r.body.indexOf('mobile.css')) {
        throw new Error(`${p} loads mobile.css BEFORE app.css — overrides will not apply`);
      }
    }
  });

  await t('every page declares a viewport', async () => {
    // Without this a phone renders at 980px and scales down — everything
    // becomes unreadably small regardless of the CSS.
    for (const p of ['/index.html','/dashboard.html','/cities.html','/economy.html',
                     '/policy.html','/market.html','/military.html','/admin.html']) {
      const r = await get(p);
      if (!r.body.includes('name="viewport"')) throw new Error(`${p} has no viewport meta`);
      if (!r.body.includes('width=device-width')) throw new Error(`${p} viewport is not device-width`);
    }
  });

  await t('CARD LABELS: wide tables emit data-label so rows read as cards', async () => {
    // On phones these tables become cards and the column header is pulled from
    // data-label. Without it a card is a column of unlabelled numbers.
    const checks = [
      ['/js/economy.js', ['Stockpile', 'Produced', 'Consumed', 'Net /turn', 'Runway']],
      ['/js/market.js', ['You hold', 'Bid', 'Ask', 'Last', 'Change']],
      ['/js/military.js', ['Score', 'Cities', 'Infrastructure']],
      ['/js/admin.js', ['Email', 'Money', 'Status']],
    ];
    for (const [file, labels] of checks) {
      const r = await get(file);
      for (const label of labels) {
        if (!r.body.includes(`data-label="${label}"`)) {
          throw new Error(`${file} is missing data-label="${label}"`);
        }
      }
    }
  });

  console.log('\n-- Policy --');

  await t('policy.html loads', async () => {
    const r = await get('/policy.html');
    eq(r.status, 200);
    has(r.body, 'In force', 'policy.html');
  });

  await t('policy.js loads and comes AFTER api.js', async () => {
    const r = await get('/js/policy.js');
    eq(r.status, 200);
    has(r.body, 'renderSlots', 'policy.js');
    const page = await get('/policy.html');
    if (page.body.indexOf('/js/api.js') > page.body.indexOf('/js/policy.js')) {
      throw new Error('api.js loads after policy.js');
    }
  });

  await t('every page links to Policy', async () => {
    for (const p of ['/dashboard.html','/cities.html','/military.html','/market.html','/economy.html']) {
      const r = await get(p);
      if (!r.body.includes('policy.html')) throw new Error(`${p} has no Policy nav link`);
    }
  });

  await t('catalogue returns all three slots with options', async () => {
    const r = await get('/api/policy', token);
    eq(r.status, 200);
    for (const slot of ['economic','social','military']) {
      if (!r.body.catalogue[slot]) throw new Error(`${slot} missing from catalogue`);
      if (r.body.catalogue[slot].policies.length < 2) throw new Error(`${slot} has too few options`);
      if (!r.body.slots[slot]) throw new Error(`${slot} state missing`);
    }
  });

  await t('EVERY policy sent to the UI shows a gain AND a cost', async () => {
    const r = await get('/api/policy', token);
    for (const info of Object.values(r.body.catalogue)) {
      for (const p of info.policies) {
        if (!p.gain?.length) throw new Error(`${p.key} has no gain`);
        if (!p.cost?.length) throw new Error(`${p.key} has no cost — it would be a free win`);
        if (!p.summary) throw new Error(`${p.key} has no summary text`);
      }
    }
  });

  await t('PREVIEW shows the diff before committing', async () => {
    const res = await fetch(BASE + '/api/policy/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ slot: 'economic', policy: 'austerity' }),
    });
    eq(res.status, 200);
    const p = await res.json();
    if (!Array.isArray(p.changes) || !p.changes.length) throw new Error('no changes reported');
    if (!p.lockDays) throw new Error('lock duration not stated');
    // Austerity must show BOTH sides.
    const improved = p.changes.filter(c => c.improved).length;
    const worse = p.changes.filter(c => !c.improved).length;
    if (!improved || !worse) throw new Error('preview did not show both gain and cost');
  });

  await t('adopting works, then LOCKS the slot', async () => {
    const set = (slot, policy) => fetch(BASE + '/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ slot, policy }),
    });

    const first = await set('economic', 'austerity');
    eq(first.status, 200);

    const second = await set('economic', 'laissez_faire');
    eq(second.status, 400, 'second change should be locked:');
    const body = await second.json();
    if (!body.error.toLowerCase().includes('lock')) throw new Error(body.error);
  });

  await t('a policy cannot be put in the wrong slot', async () => {
    const res = await fetch(BASE + '/api/policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ slot: 'social', policy: 'austerity' }),
    });
    eq(res.status, 400);
  });

  await t('active effects appear once a policy is in force', async () => {
    const r = await get('/api/policy', token);
    if (!r.body.activeEffects.length) throw new Error('no active effects after adopting');
    for (const e of r.body.activeEffects) {
      if (!e.text) throw new Error('effect has no readable text');
      if (typeof e.good !== 'boolean') throw new Error('effect does not say if it helps');
    }
  });

  console.log('\n-- Market --');

  await t('market.html loads', async () => {
    const r = await get('/market.html');
    eq(r.status, 200);
    has(r.body, 'Order book', 'market.html');
  });

  await t('market.js loads and comes AFTER api.js', async () => {
    const r = await get('/js/market.js');
    eq(r.status, 200);
    has(r.body, 'renderBook', 'market.js');
    const page = await get('/market.html');
    if (page.body.indexOf('/js/api.js') > page.body.indexOf('/js/market.js')) {
      throw new Error('api.js loads after market.js');
    }
  });

  await t('every page links to the market', async () => {
    for (const p of ['/dashboard.html','/cities.html','/military.html']) {
      const r = await get(p);
      if (!r.body.includes('market.html')) throw new Error(`${p} has no Market nav link`);
    }
  });

  await t('market overview covers every tradeable resource', async () => {
    const r = await get('/api/market', token);
    eq(r.status, 200);
    if (!Array.isArray(r.body.resources)) throw new Error('resources not an array');
    for (const res of r.body.resources) {
      for (const k of ['resource','bid','ask','medianPrice']) {
        if (res[k] === undefined) throw new Error(`overview.${res.resource}.${k} missing`);
      }
    }
  });

  await t('book returns the shape the UI renders', async () => {
    const r = await get('/api/market/coal', token);
    eq(r.status, 200);
    for (const k of ['bids','asks','bid','ask','spread','medianPrice','recentTrades','myOrders']) {
      if (r.body[k] === undefined) throw new Error(`book.${k} missing`);
    }
    if (!Array.isArray(r.body.bids)) throw new Error('bids not an array');
  });

  await t('MAKER PRICE WINS: bid above the ask pays the ask', async () => {
    // Second nation to trade against.
    await db.query(`DELETE FROM users WHERE email = 'mkt@test.com'`);
    const reg2 = await fetch(BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'market-counterparty' },
      body: JSON.stringify({ email: 'mkt@test.com', password: 'password123',
        nationName: 'Bourse', leaderName: 'B', continent: 'asia' }),
    });
    const t2 = (await reg2.json()).token;
    const n2 = await get('/api/nation', t2);
    await db.query(
      `UPDATE nation_resources SET amount = 200 WHERE nation_id = $1 AND resource = 'coal'`,
      [n2.body.nation.id]);

    const post = (tok, body) => fetch(BASE + '/api/market/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify(body),
    }).then(r => r.json());

    await post(t2, { resource: 'coal', side: 'sell', price: 100, quantity: 50 });
    const buy = await post(token, { resource: 'coal', side: 'buy', price: 150, quantity: 20 });

    if (buy.filled !== 20) throw new Error('did not fill: ' + JSON.stringify(buy));
    if (buy.averagePrice !== 100) {
      throw new Error(`paid ${buy.averagePrice}, should pay the resting 100 not the bid 150`);
    }
    if (buy.spent !== 2000) throw new Error(`spent ${buy.spent}, expected 2000`);

    await db.query(`DELETE FROM users WHERE email = 'mkt@test.com'`);
  });

  await t('PRICE CHART: history, change and stats are returned', async () => {
    const r = await get('/api/market/coal', token);
    for (const k of ['history','current','change','changePercent','direction','stats']) {
      if (r.body[k] === undefined) throw new Error(`book.${k} missing — chart/ticker cannot render`);
    }
    if (!Array.isArray(r.body.history)) throw new Error('history is not an array');
    for (const p of r.body.history) {
      for (const k of ['turn','open','high','low','close','volume']) {
        if (typeof p[k] !== 'number') throw new Error(`history point missing ${k}`);
      }
    }
  });

  await t('ticker data present on every overview row', async () => {
    const r = await get('/api/market', token);
    for (const res of r.body.resources) {
      if (res.direction === undefined) throw new Error(`${res.resource}: direction missing`);
      if (!['up','down','flat'].includes(res.direction)) throw new Error(`${res.resource}: bad direction ${res.direction}`);
      if (!Array.isArray(res.spark)) throw new Error(`${res.resource}: spark not an array`);
    }
  });

  await t('a RISING price reports up, not down', async () => {
    // Regression guard: priceChange once passed trade OBJECTS to a function
    // expecting PRICES, got NaN, and reported a 47% rise as "down".
    const engine = require('../src/market/engine');
    const rising = [
      { price: 120, quantity: 1, turn: 6 }, { price: 115, quantity: 1, turn: 5 },
      { price: 100, quantity: 1, turn: 4 }, { price: 95, quantity: 1, turn: 3 },
      { price: 82, quantity: 1, turn: 2 },  { price: 80, quantity: 1, turn: 1 },
    ];
    const c = engine.priceChange(rising);
    if (c.direction !== 'up') throw new Error(`rising market reported "${c.direction}"`);
    if (c.changePercent === null) throw new Error('changePercent is null on a clear trend');
    if (!(c.changePercent > 0)) throw new Error('changePercent should be positive');

    const falling = [...rising].map((t, i) => ({ ...t, price: rising[rising.length - 1 - i].price }));
    if (engine.priceChange(falling).direction !== 'down') throw new Error('falling market not reported as down');
  });

  await t('chart handles a flat and an empty market without dividing by zero', async () => {
    const engine = require('../src/market/engine');
    const flat = engine.priceChange([{ price: 100, quantity: 1, turn: 2 }, { price: 100, quantity: 1, turn: 1 }]);
    eq(flat.direction, 'flat');
    eq(engine.priceChange([]).direction, 'flat');
    eq(engine.priceHistory([]).length, 0);
  });

  await t('cannot sell resources you do not have', async () => {
    const res = await fetch(BASE + '/api/market/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ resource: 'uranium', side: 'sell', price: 100, quantity: 99999 }),
    });
    eq(res.status, 400);
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
