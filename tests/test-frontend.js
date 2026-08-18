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
const TEST_EMAIL_2 = 'frontend2@test.com';
const TEST_EMAIL_3 = 'frontend3@test.com';

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
  await db.query('DELETE FROM users WHERE email = ANY($1)', [[TEST_EMAIL, TEST_EMAIL_2, TEST_EMAIL_3]]);
}

(async () => {
  const server = await start();
  await cleanup();
  await new Promise(r => setTimeout(r, 300));

  console.log('\n-- Static files reach the browser --');

  await t('/ serves the LANDING page, not the login form', async () => {
    // The landing page is what Google and a first-time visitor see. If this
    // ever goes back to serving the login form, the site has no indexable
    // content again and the SEO work is undone.
    const r = await get('/');
    eq(r.status, 200);
    has(r.body, 'SOVRA', 'index.html');
    has(r.body, 'The World Order', 'index.html');
    if (r.body.includes('type="password"')) {
      throw new Error('/ is serving the login form — index.html and login.html are swapped');
    }
    if (!r.body.includes('/login.html')) {
      throw new Error('landing page has no route into the game');
    }
  });

  await t('/login.html serves the login form', async () => {
    const r = await get('/login.html');
    eq(r.status, 200);
    has(r.body, 'SOVRA', 'login.html');
    has(r.body, 'type="password"', 'login.html');
    has(r.body, 'registerPanel', 'login.html');
  });

  await t('LANDING PAGE IS SELF-CONTAINED (no game CSS to fight with)', async () => {
    // It deliberately carries its own styles. If it starts pulling app.css the
    // two design systems collide, and the marketing page inherits game layout.
    const r = await get('/');
    if (r.body.includes('/css/app.css')) throw new Error('landing page depends on app.css');
    has(r.body, 'name="viewport"', 'index.html');
    has(r.body, '<style>', 'index.html');
  });

  await t('SEO: landing page carries the tags Google reads', async () => {
    const r = await get('/');
    for (const needle of [
      '<title>', 'name="description"', 'rel="canonical"',
      'og:title', 'og:description', 'application/ld+json',
    ]) has(r.body, needle, 'index.html');
    if (!r.body.includes('"@type":"VideoGame"')) throw new Error('missing VideoGame schema');
    if (!r.body.includes('"@type":"FAQPage"')) throw new Error('missing FAQPage schema');
  });

  await t('nothing links to /index.html any more (it is the landing page now)', async () => {
    // A stale redirect here sends a logged-out player to marketing instead of
    // the login form, and they never find their way back in.
    const r = await get('/js/api.js');
    if (r.body.includes('/index.html')) {
      throw new Error('api.js still redirects to /index.html — should be /login.html');
    }
  });

  console.log('\n-- Legal pages (AdSense will not approve without these) --');

  await t('privacy policy and terms are served', async () => {
    for (const [p, needle] of [['/privacy.html','Privacy Policy'], ['/terms.html','Terms of Service']]) {
      const r = await get(p);
      eq(r.status, 200, p);
      has(r.body, needle, p);
      has(r.body, 'name="viewport"', p);
    }
  });

  await t('LEGAL PAGES HAVE NO UNFILLED PLACEHOLDERS', async () => {
    // Publishing a policy that still says __CONTACT_EMAIL__ is worse than
    // having no policy. This test is the forcing function.
    // Report EVERY page at once. Throwing on the first one hid the fact that
    // terms.html still had five placeholders while privacy.html had one, so
    // fixing privacy.html just revealed the next failure instead of the whole
    // list. A checklist test should hand you the whole checklist.
    const problems = [];
    for (const p of ['/privacy.html', '/terms.html']) {
      const r = await get(p);
      const left = [...new Set([...String(r.body).matchAll(/__[A-Z_]+__/g)].map(m => m[0]))];
      if (left.length) problems.push(`${p}: ${left.join(', ')}`);

      // The .fill class is the red "not filled in yet" marker. Left on a real
      // value it makes a finished policy look like a draft full of errors.
      if (String(r.body).includes('class="fill"')) {
        problems.push(`${p}: still has draft-marker <span class="fill"> around a real value`);
      }
    }
    if (problems.length) throw new Error(problems.join(' | '));
  });

  await t('THE POLICY DESCRIBES THE SITE WE ACTUALLY RUN', async () => {
    // AdSense reviewers compare the policy against the live site, and a policy
    // naming ad partners that receive nothing is simply inaccurate. When ads do
    // go live, this test is the reminder to update the page first.
    const r = await get('/privacy.html');
    if (/AdSense/i.test(r.body)) {
      throw new Error('privacy policy names an ad network — update it when ads actually go live, not before');
    }
    has(r.body, 'currently shows no advertising', 'privacy.html');
  });

  await t('NO DEAD INTERNAL LINKS on the public pages', async () => {
    // Every href="/..." on a page Google can crawl must actually resolve.
    // Dead links on a landing page cost you both players and ranking.
    for (const page of ['/', '/privacy.html', '/terms.html', '/login.html', '/rankings.html',
                        '/wiki/', '/wiki/cities.html', '/wiki/economy.html',
                        '/wiki/population.html', '/wiki/war.html',
                        '/wiki/policies.html', '/wiki/projects.html']) {
      const r = await get(page);
      const links = [...String(r.body).matchAll(/href="(\/[^"]*)"/g)]
        .map(m => m[1].split('#')[0].split('?')[0])
        .filter(Boolean);
      for (const link of [...new Set(links)]) {
        const res = await get(link);
        if (res.status !== 200) throw new Error(`${page} links to ${link} -> ${res.status}`);
      }
    }
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

  // A second, unrelated nation. Needed to prove that one player cannot read
  // another player's battles — a check that passes vacuously with one account.
  const reg2 = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'frontend-test-2' },
    body: JSON.stringify({
      email: TEST_EMAIL_2, password: 'password123',
      nationName: 'Bystandia', leaderName: 'Onlooker', continent: 'asia',
    }),
  });
  const otherToken = (await reg2.json()).token;

  // A THIRD nation that fights nobody. The access-control checks need a genuine
  // outsider: nation 2 ends up as the defender in the war set up below, so using
  // its token would be testing that a participant can read its own war.
  const reg3 = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'frontend-test-3' },
    body: JSON.stringify({
      email: TEST_EMAIL_3, password: 'password123',
      nationName: 'Neutralia', leaderName: 'Nobody', continent: 'africa',
    }),
  });
  const outsiderToken = (await reg3.json()).token;

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

  console.log('\n-- Wiki (the SEO surface) --');

  const WIKI_PAGES = ['/wiki/', '/wiki/cities.html', '/wiki/economy.html',
                      '/wiki/population.html', '/wiki/war.html',
                      '/wiki/policies.html', '/wiki/projects.html'];

  await t('every wiki page is served', async () => {
    for (const p of WIKI_PAGES) {
      const r = await get(p);
      eq(r.status, 200, p);
      has(r.body, 'SOVRA', p);
      has(r.body, 'name="viewport"', p);
    }
  });

  await t('wiki pages carry their own title, description and canonical', async () => {
    // Duplicate titles across pages are one of the most common SEO own-goals.
    const titles = new Set();
    for (const p of WIKI_PAGES) {
      const r = await get(p);
      const m = String(r.body).match(/<title>([^<]+)<\/title>/);
      if (!m) throw new Error(`${p} has no <title>`);
      if (titles.has(m[1])) throw new Error(`${p} duplicates the title "${m[1]}"`);
      titles.add(m[1]);
      has(r.body, 'name="description"', p);
      has(r.body, 'rel="canonical"', p);
    }
  });

  await t('THE WIKI MATCHES THE ENGINE (run `npm run wiki` if this fails)', async () => {
    // The whole reason the wiki is generated instead of hand-written: if a
    // constant changes and nobody regenerates, the documentation is lying.
    // This regenerates in memory and diffs against what is actually served.
    const { pages } = require('../make-wiki');
    const built = pages();
    for (const [name, html] of Object.entries(built)) {
      const url = name === 'index.html' ? '/wiki/' : '/wiki/' + name;
      const r = await get(url);
      if (String(r.body) !== html) {
        throw new Error(`${url} is stale — the engine changed but the wiki was not rebuilt`);
      }
    }
  });

  await t('wiki quotes real engine values, not typed-in ones', async () => {
    // Spot-check a few figures against the constants they came from. If someone
    // hand-edits the generated HTML, this catches it.
    const C = require('../src/engine/constants');
    const r = await get('/wiki/war.html');
    has(r.body, String(C.COMBAT.ROLL_COUNT), 'war.html');
    has(r.body, String(C.COMBAT.MAP_MAX), 'war.html');
    has(r.body, String(C.COMBAT.RESISTANCE_START), 'war.html');

    const e = await get('/wiki/economy.html');
    has(e.body, String(C.ECONOMY.INCOME_PER_CAPITA_BASE), 'economy.html');
    has(e.body, String(C.IMPROVEMENTS.coal_power.infraCapacity), 'economy.html');
  });

  await t('sitemap.xml and robots.txt are served and agree', async () => {
    const sm = await get('/sitemap.xml');
    eq(sm.status, 200);
    has(sm.body, '<urlset', 'sitemap.xml');
    for (const p of WIKI_PAGES) {
      const loc = p === '/wiki/' ? '/wiki/' : p;
      if (!String(sm.body).includes(loc)) throw new Error(`sitemap is missing ${loc}`);
    }
    const rb = await get('/robots.txt');
    eq(rb.status, 200);
    has(rb.body, 'Sitemap:', 'robots.txt');
    has(rb.body, 'Disallow: /api/', 'robots.txt');
  });

  await t('every in-game page links to the wiki', async () => {
    for (const p of ['/dashboard.html','/cities.html','/economy.html','/policy.html',
                     '/market.html','/military.html','/projects.html','/history.html',
                     '/espionage.html']) {
      const r = await get(p);
      if (!r.body.includes('/wiki/')) throw new Error(`${p} has no wiki link`);
    }
  });

  console.log('\n-- War card: control states and fortify --');

  // A real war between the two test nations, so the checks below are not
  // vacuous. They registered with different user agents, so they are not
  // treated as linked accounts.
  let warId = null;
  try {
    const meSnap = await get('/api/nation', token);
    const themSnap = await get('/api/nation', otherToken);
    const myId = meSnap.body.nation.id, theirId = themSnap.body.nation.id;

    await db.query('UPDATE nations SET beige_until_turn = NULL WHERE id = ANY($1)', [[myId, theirId]]);
    await db.query('UPDATE cities SET infrastructure = 500 WHERE nation_id = ANY($1)', [[myId, theirId]]);

    const decl = await fetch(`${BASE}/api/war/declare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ targetId: theirId, warType: 'ordinary' }),
    });
    const body = await decl.json();
    if (decl.status === 201) warId = body.warId;

    // Accrue enough action points to actually fortify.
    for (let i = 0; i < 4; i++) await scheduler.runTurn();
  } catch {
    // If setup fails the tests below skip rather than reporting a false failure.
  }


  await t('reference ships the engine\'s OWN control-state wording', async () => {
    // The UI must not invent its own sentences for these. If the reference stops
    // carrying them, the war card silently falls back to a raw column name.
    const r = await get('/api/reference');
    const C = require('../src/engine/constants');
    for (const key of Object.keys(C.CONTROL_STATES)) {
      const cs = r.body.controlStates[key];
      if (!cs) throw new Error(`reference is missing control state ${key}`);
      for (const f of ['name', 'holding', 'suffering']) {
        if (!cs[f]) throw new Error(`${key} has no ${f} text`);
      }
    }
    if (r.body.mapCosts.fortify === undefined) throw new Error('mapCosts.fortify missing');
    if (typeof r.body.fortifyCasualtyIncrease !== 'number') throw new Error('fortifyCasualtyIncrease missing');
  });

  await t('/api/wars answers from the READER\'s point of view', async () => {
    // Raw attacker_/defender_ columns force every caller to work out which side
    // it is on. Getting that backwards tells a player they hold air superiority
    // while they are suffering under it.
    const r = await get('/api/wars', token);
    eq(r.status, 200);
    for (const w of r.body.wars) {
      for (const k of ['youDeclared', 'opponentName', 'myResistance', 'theirResistance',
                       'myControlState', 'theirControlState', 'iAmFortified', 'theyAreFortified']) {
        if (!(k in w)) throw new Error(`war is missing ${k}`);
      }
    }
  });

  await t('FORTIFY: costs MAP, sets the flag, refuses a repeat', async () => {
    if (!warId) throw new Error('war setup failed — cannot check fortify');
    const wars = await get('/api/wars', token);
    const war = wars.body.wars.find(w => w.id === warId);
    if (!war) throw new Error('declared war is missing from /api/wars');

    const before = await get('/api/nation', token);
    const res = await fetch(`${BASE}/api/war/${war.id}/fortify`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
    const body = await res.json();

    if (res.status !== 200) {
      // Only acceptable failure is genuinely not having the points.
      if (!/action points/.test(body.error || '')) throw new Error(body.error);
      return;
    }

    const C = require('../src/engine/constants');
    const after = await get('/api/nation', token);
    eq(after.body.nation.map, before.body.nation.map - C.COMBAT.MAP_COST.fortify, 'MAP spent');

    const wars2 = await get('/api/wars', token);
    const w2 = wars2.body.wars.find(x => x.id === war.id);
    if (!w2.iAmFortified) throw new Error('fortify did not set the flag');

    const again = await fetch(`${BASE}/api/war/${war.id}/fortify`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
    if (again.status === 200) throw new Error('fortifying twice was allowed');
  });

  await t('FORTIFY IS PARTICIPANTS ONLY', async () => {
    if (!warId) throw new Error('war setup failed — cannot check access control');
    const res = await fetch(`${BASE}/api/war/${warId}/fortify`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + outsiderToken },
    });
    if (res.status === 200) throw new Error('a non-participant fortified someone else\'s war');
  });

  await t('military page reads MAP costs from the server, not its own copy', async () => {
    // These were typed into military.js as literals, so tuning MAP_COST in the
    // engine left the buttons advertising the old price.
    const r = await get('/js/military.js');
    if (/map:\s*3\b/.test(r.body) || /map:\s*4\b/.test(r.body)) {
      throw new Error('military.js still hardcodes MAP costs');
    }
    has(r.body, 'ref.mapCosts', 'military.js');
    has(r.body, 'controlStates', 'military.js');
    has(r.body, 'data-fortify', 'military.js');
  });

  console.log('\n-- War card: peace --');

  await t('PEACE IS PARTICIPANTS ONLY', async () => {
    if (!warId) throw new Error('war setup failed — cannot check access control');
    const res = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + outsiderToken },
    });
    if (res.status === 200) throw new Error('an outsider offered peace in a war it is not in');
  });

  await t('AN OFFER IS NOT AN ARMISTICE — one side alone changes nothing', async () => {
    // The whole point of requiring both signatures is that a losing nation
    // cannot walk away by announcing it is done. Until the other side agrees
    // the war is still running and can still be attacked.
    if (!warId) throw new Error('war setup failed — cannot check peace');
    const res = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
    const body = await res.json();
    eq(res.status, 200, body.error);
    eq(body.peace, false, 'a single offer ended the war:');

    const mine = await get('/api/wars', token);
    const w = mine.body.wars.find(x => x.id === warId);
    if (!w) throw new Error('the war vanished on a one-sided offer');
    if (!w.iOfferedPeace) throw new Error('my own offer is not reported back to me');

    // And the opponent has to be able to SEE it, or there is nothing to accept.
    const theirs = await get('/api/wars', otherToken);
    const tw = theirs.body.wars.find(x => x.id === warId);
    if (!tw.theyOfferedPeace) throw new Error('the opponent cannot see the offer');
    if (tw.iOfferedPeace) throw new Error('the opponent was credited with an offer it never made');
  });

  await t('offering twice is refused, not silently repeated', async () => {
    if (!warId) throw new Error('war setup failed');
    const res = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
    if (res.status === 200) throw new Error('a second offer was accepted');
  });

  await t('ATTACKING WITHDRAWS YOUR OWN OFFER', async () => {
    // Suing for peace and then hitting them anyway is the one thing this
    // system must never let you do. The offer is a standing promise, so the
    // attack has to cancel it rather than leaving it on the table.
    if (!warId) throw new Error('war setup failed');
    const meSnap = await get('/api/nation', token);
    await db.query('UPDATE nations SET map_points = 12 WHERE id = $1', [meSnap.body.nation.id]);

    const res = await fetch(`${BASE}/api/war/${warId}/attack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ attackType: 'ground_battle' }),
    });
    if (res.status !== 200) {
      const b = await res.json();
      throw new Error('attack failed, cannot check: ' + (b.error || res.status));
    }

    const after = await get('/api/wars', token);
    const w = after.body.wars.find(x => x.id === warId);
    if (!w) throw new Error('the attack ended the war — cannot check the offer');
    if (w.iOfferedPeace) throw new Error('attacked while still offering peace');

    const theirs = await get('/api/wars', otherToken);
    const tw = theirs.body.wars.find(x => x.id === warId);
    if (tw.theyOfferedPeace) throw new Error('the opponent still sees a withdrawn offer');
  });

  await t('WITHDRAW takes the offer back, and only if there is one', async () => {
    if (!warId) throw new Error('war setup failed');
    const gone = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
    });
    if (gone.status === 200) throw new Error('withdrew an offer that does not exist');

    const made = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
    eq(made.status, 200, 'offer:');

    const pulled = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
    });
    eq(pulled.status, 200, 'withdraw:');

    const after = await get('/api/wars', token);
    const w = after.body.wars.find(x => x.id === warId);
    if (w.iOfferedPeace) throw new Error('withdraw did not clear the offer');
  });

  await t('BOTH OFFERS END THE WAR — no winner, no loot, no beige', async () => {
    // A white peace is a draw. Recording it as a defeat would hand the other
    // side a beige protection it never earned and stain a record that should
    // show neither side won.
    if (!warId) throw new Error('war setup failed');
    const meSnap = await get('/api/nation', token);
    const themSnap = await get('/api/nation', otherToken);
    const myId = meSnap.body.nation.id, theirId = themSnap.body.nation.id;

    await db.query('UPDATE nations SET beige_until_turn = NULL WHERE id = ANY($1)', [[myId, theirId]]);
    const moneyBefore = Number(meSnap.body.nation.money);

    const a = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
    eq(a.status, 200, 'first offer:');
    eq((await a.json()).peace, false, 'one offer is not peace:');

    const b = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + otherToken },
    });
    const bBody = await b.json();
    eq(b.status, 200, 'second offer:');
    eq(bBody.peace, true, 'both sides offered and the war did not end:');

    const { rows } = await db.query('SELECT * FROM wars WHERE id = $1', [warId]);
    if (rows[0].ended_turn === null) throw new Error('the war is still open in the database');
    if (rows[0].winner_id !== null) throw new Error('a white peace recorded a winner');

    const { rows: nations } = await db.query(
      'SELECT id, beige_until_turn, money FROM nations WHERE id = ANY($1)', [[myId, theirId]]
    );
    for (const n of nations) {
      if (n.beige_until_turn !== null) throw new Error(`nation ${n.id} was beiged by a white peace`);
    }
    const meAfter = nations.find(n => Number(n.id) === Number(myId));
    if (Math.abs(Number(meAfter.money) - moneyBefore) > 0.01) {
      throw new Error('money moved in a white peace — nothing should change hands');
    }

    const open = await get('/api/wars', token);
    if (open.body.wars.some(x => x.id === warId)) throw new Error('an ended war is still listed as active');
  });

  await t('a war that has already ended cannot be peaced again', async () => {
    if (!warId) throw new Error('war setup failed');
    const res = await fetch(`${BASE}/api/war/${warId}/peace`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
    });
    if (res.status === 200) throw new Error('offered peace in a war that is over');
  });

  await t('HISTORY SHOWS A WHITE PEACE AS A DRAW, NOT A DEFEAT', async () => {
    // history.js decides won/lost/drawn from the war row. If the peace-offer
    // columns stop being sent, every white peace silently reads as "ended, no
    // winner" — indistinguishable from a war an admin cancelled.
    const hist = await get('/api/war-history', token);
    const w = hist.body.wars.find(x => x.id === warId);
    if (!w) throw new Error('the peaced war is missing from history');
    if (w.winner_id !== null) throw new Error('history records a winner for a white peace');
    if (!w.attacker_peace_offer || !w.defender_peace_offer) {
      throw new Error('history does not carry the peace offers — the page cannot tell a draw from a cancellation');
    }
    const js = await get('/js/history.js');
    has(js.body, 'isWhitePeace', 'history.js');
    has(js.body, 'white peace', 'history.js');
  });

  await t('the war card offers peace, and says what it costs', async () => {
    const r = await get('/js/military.js');
    has(r.body, 'data-peace', 'military.js');
    has(r.body, 'data-unpeace', 'military.js');
    has(r.body, 'theyOfferedPeace', 'military.js');
    const api = await get('/js/api.js');
    has(api.body, 'offerPeace', 'api.js');
    has(api.body, 'withdrawPeace', 'api.js');
  });

  console.log('\n-- Missiles and nuclear weapons --');

  await t('A LAUNCH IS NOT REPLAYED — there are no rolls to reproduce', async () => {
    // Feeding a launch through rollBattle would manufacture a verdict out of
    // two zeroes and then report it as "verified", which is worse than saying
    // the question does not apply.
    const hist = await get('/api/war-history', token);
    if (hist.body.wars.length === 0) return;
    const battles = await get(`/api/war/${hist.body.wars[0].id}/battles`, token);
    const launch = battles.body.battles.find(b =>
      ['missile_launch', 'nuclear_attack'].includes(b.attack_type));
    if (!launch) return;                       // no launch fought in this run

    const r = await get(`/api/battle/${launch.id}`, token);
    eq(r.status, 200);
    if (r.body.verified !== null) throw new Error('a launch reported a replay verdict');
    if (r.body.replay !== null) throw new Error('a launch was re-rolled');
    if (!r.body.reason) throw new Error('no explanation given for skipping the replay');
  });

  await t('MISSILES AND NUKES CAN BE BUILT FROM THE PAGE', async () => {
    // They were absent from the recruit list, so the only way to build one was
    // to call the API by hand. The projects, the costs, the score and the whole
    // launch mechanic existed with no route to the weapon itself.
    const r = await get('/js/military.js');
    has(r.body, "'missiles'", 'military.js');
    has(r.body, "'nukes'", 'military.js');
    has(r.body, 'requiresProject', 'military.js');   // locked units name their project
  });

  await t('reference carries the build rate the page shows', async () => {
    const C = require('../src/engine/constants');
    const r = await get('/api/reference');
    for (const unit of ['missiles', 'nukes']) {
      if (r.body.units[unit].perDay === undefined) {
        throw new Error(`${unit} has no perDay in reference — the page cannot show the rate`);
      }
      eq(r.body.units[unit].perDay, C.UNITS[unit].perDay, `${unit} rate:`);
    }
  });

  await t('the war card offers launches, and never claims to know their intercept chance', async () => {
    // You do not know which defence projects they have bought. Showing a
    // number would be inventing information Gather Intelligence exists to sell.
    const r = await get('/js/military.js');
    has(r.body, 'data-launch', 'military.js');
    has(r.body, 'nuclear_attack', 'military.js');
    if (/interceptChance/.test(r.body)) {
      throw new Error('military.js displays an intercept chance it cannot know');
    }
  });

  await t('history labels a launch as landed or intercepted, not as a victory tier', async () => {
    const r = await get('/js/history.js');
    has(r.body, 'intercepted', 'history.js');
    has(r.body, 'battleResult', 'history.js');
  });

  console.log('\n-- Espionage --');

  await t('DANGEROUS PRODUCTION SETTINGS ARE SHOUTED ABOUT AT BOOT', async () => {
    // Every one of these is a legitimate LOCAL setting, which is exactly why
    // they get deployed by accident. 30-second turns run a month of economy in
    // three hours, and ALLOW_LINKED_WARS removes the only thing stopping a
    // player farming their own alt — both silent, both unrecoverable by then.
    const server = require('../server');
    if (typeof server.assertProductionSettings !== 'function') {
      throw new Error('the production-settings check is not exported');
    }

    const saved = {
      linked: process.env.ALLOW_LINKED_WARS,
      interval: process.env.TURN_INTERVAL_MS,
      cors: process.env.CORS_ORIGIN,
    };
    const lines = [];
    const realWarn = console.warn;
    console.warn = (...a) => lines.push(a.join(' '));
    try {
      process.env.ALLOW_LINKED_WARS = 'true';
      process.env.TURN_INTERVAL_MS = '30000';
      process.env.CORS_ORIGIN = 'http://example.com';
      server.assertProductionSettings();
    } finally {
      console.warn = realWarn;
      for (const [k, v] of [['ALLOW_LINKED_WARS', saved.linked],
                            ['TURN_INTERVAL_MS', saved.interval],
                            ['CORS_ORIGIN', saved.cors]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const text = lines.join('\n');
    for (const needle of ['ALLOW_LINKED_WARS', 'TURN_INTERVAL_MS', 'CORS_ORIGIN']) {
      has(text, needle, 'boot warning');
    }

    // And a correctly configured server says nothing at all, or the warning
    // becomes background noise that nobody reads.
    const quiet = [];
    console.warn = (...a) => quiet.push(a.join(' '));
    try {
      delete process.env.ALLOW_LINKED_WARS;
      delete process.env.TURN_INTERVAL_MS;
      delete process.env.CORS_ORIGIN;
      server.assertProductionSettings();
    } finally {
      console.warn = realWarn;
      for (const [k, v] of [['ALLOW_LINKED_WARS', saved.linked],
                            ['TURN_INTERVAL_MS', saved.interval],
                            ['CORS_ORIGIN', saved.cors]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    if (quiet.length) throw new Error('a correctly configured server printed a warning: ' + quiet[0]);
  });

  await t('SCHEMA.SQL IS SAFE TO RE-RUN ON A LIVE DATABASE', async () => {
    // It used to throw forty "already exists" errors on a populated database.
    // All of them harmless, all of them indistinguishable from a real failure
    // — which is how a migration ends up being one people are afraid to run.
    const sql = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8');

    const bad = sql.split('\n')
      .map((line, i) => [i + 1, line.trim()])
      .filter(([, l]) =>
        (/^CREATE TABLE /i.test(l) && !/^CREATE TABLE IF NOT EXISTS /i.test(l)) ||
        (/^CREATE INDEX /i.test(l) && !/^CREATE INDEX IF NOT EXISTS /i.test(l)));
    if (bad.length) {
      throw new Error('not re-runnable, needs IF NOT EXISTS: ' +
        bad.map(([n, l]) => `line ${n}: ${l.slice(0, 50)}`).join('; '));
    }

    // The seed row would violate the primary key on a second run.
    if (!/INSERT INTO game_state[\s\S]*?ON CONFLICT/i.test(sql)) {
      throw new Error('the game_state seed row has no ON CONFLICT clause');
    }

    // Views cannot use IF NOT EXISTS meaningfully — a stale one would survive
    // and quietly serve an old definition — so they are dropped and rebuilt.
    for (const view of ['linked_nations', 'suspected_links', 'nation_summary']) {
      if (!sql.includes(`DROP VIEW IF EXISTS ${view}`)) {
        throw new Error(`view ${view} is not dropped before it is recreated`);
      }
    }

    // And it actually runs, twice, against the live test database.
    await db.query(sql);
    await db.query(sql);

    const { rows } = await db.query('SELECT count(*)::int AS n FROM game_state');
    eq(rows[0].n, 1, 'game_state rows after two runs:');
  });

  await t('THE SERVER REFUSES TO BOOT ON AN OUT-OF-DATE DATABASE', async () => {
    // The migration for espionage_ops.result is IF NOT EXISTS, which makes it
    // safe to re-run and therefore very easy to forget entirely. The old
    // failure mode was the worst kind: everything loads, then one action
    // returns "Internal server error" and nobody knows why.
    const server = require('../server');
    if (typeof server.assertSchemaIsCurrent !== 'function') {
      throw new Error('startup schema check is not exported — it cannot be tested');
    }
    await server.assertSchemaIsCurrent();          // current DB: must not throw

    await db.query('ALTER TABLE espionage_ops DROP COLUMN IF EXISTS result');
    let threw = false;
    try { await server.assertSchemaIsCurrent(); } catch { threw = true; }
    await db.query(`ALTER TABLE espionage_ops ADD COLUMN IF NOT EXISTS result JSONB NOT NULL DEFAULT '{}'`);
    if (!threw) throw new Error('a missing migration did not stop startup');
  });



  await t('espionage page loads and api.js comes first', async () => {
    const r = await get('/espionage.html');
    eq(r.status, 200);
    const apiPos = r.body.indexOf('/js/api.js');
    const pagePos = r.body.indexOf('/js/espionage.js');
    if (apiPos === -1 || pagePos === -1) throw new Error('a script tag is missing');
    if (apiPos > pagePos) throw new Error('api.js loads AFTER espionage.js');
  });

  await t('reference carries every operation, its difficulty and its wording', async () => {
    const C = require('../src/engine/constants');
    const r = await get('/api/reference');
    for (const op of Object.keys(C.ESPIONAGE.OPERATION_MODIFIER)) {
      if (!r.body.espionage.operations[op]) throw new Error(`no wording for ${op}`);
      if (r.body.espionage.difficulty[op] === undefined) throw new Error(`no difficulty for ${op}`);
    }
    for (const level of Object.keys(C.ESPIONAGE.SAFETY_LEVELS)) {
      if (!r.body.espionage.safetyLevels[level]) throw new Error(`no wording for ${level}`);
    }
  });

  await t('roster reports both ceilings — they are different limits', async () => {
    const r = await get('/api/espionage', token);
    eq(r.status, 200);
    for (const k of ['spies','maxSpies','trainingPerDay','trainedToday',
                     'operationsPerDay','operationsToday','range']) {
      if (!(k in r.body)) throw new Error(`espionage state is missing ${k}`);
    }
  });

  await t('TRAINING RESPECTS THE DAILY CAP, NOT JUST THE ROSTER CAP', async () => {
    // Two different limits. Merging them would let a rich nation rebuild a wiped
    // intelligence service in an afternoon, which makes losing spies meaningless.
    const C = require('../src/engine/constants');
    const before = await get('/api/espionage', token);
    const perDay = before.body.trainingPerDay;

    const first = await fetch(`${BASE}/api/espionage/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ count: perDay }),
    });
    if (first.status !== 200) {
      const b = await first.json();
      if (!/costs|holds at most/.test(b.error || '')) throw new Error(b.error);
      return;                                   // too poor to train; nothing to assert
    }

    const second = await fetch(`${BASE}/api/espionage/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ count: 1 }),
    });
    if (second.status === 200) throw new Error('daily training cap was not enforced');

    const after = await get('/api/espionage', token);
    eq(after.body.spies, before.body.spies + perDay, 'spies trained');
    eq(after.body.trainedToday, perDay, 'training logged for the day');
  });

  await t('ODDS COME FROM THE ENGINE, NOT THE PAGE', async () => {
    // The preview must be produced by the same function that resolves the
    // attempt. A second implementation in the browser is a second answer.
    const others = await get('/api/rankings');
    const me = await get('/api/nation', token);
    const target = others.body.nations.find(n => n.id !== me.body.nation.id);
    if (!target) return;

    const r = await get(`/api/espionage?targetId=${target.id}`, token);
    eq(r.status, 200);
    if (!r.body.target) throw new Error('no target block returned');

    const C = require('../src/engine/constants');
    for (const op of Object.keys(C.ESPIONAGE.OPERATION_MODIFIER)) {
      for (const level of Object.keys(C.ESPIONAGE.SAFETY_LEVELS)) {
        const v = r.body.target.odds[op]?.[level];
        if (typeof v !== 'number' || v < 0 || v > 100) {
          throw new Error(`odds for ${op}/${level} are ${v}`);
        }
      }
    }
    // Harder operations must never beat easier ones at the same safety level.
    const lvl = 'normal_precautions';
    if (r.body.target.odds.sabotage_nuke[lvl] > r.body.target.odds.gather_intelligence[lvl]) {
      throw new Error('sabotaging a nuke came out easier than gathering intelligence');
    }
  });

  await t('THE TARGET\'S SPY COUNT IS NEVER REVEALED', async () => {
    // That is what gather_intelligence is for. Shipping it in the preview would
    // hand out for free the thing the operation exists to buy.
    const others = await get('/api/rankings');
    const me = await get('/api/nation', token);
    const target = others.body.nations.find(n => n.id !== me.body.nation.id);
    if (!target) return;

    const r = await get(`/api/espionage?targetId=${target.id}`, token);
    if ('spies' in r.body.target) throw new Error('target block exposes their spy count');
  });

  await t('operations refuse an unknown operation or safety level', async () => {
    const others = await get('/api/rankings');
    const me = await get('/api/nation', token);
    const target = others.body.nations.find(n => n.id !== me.body.nation.id);
    if (!target) return;

    for (const body of [
      { targetId: target.id, operation: 'mind_control', safetyLevel: 'normal_precautions' },
      { targetId: target.id, operation: 'sabotage_tanks', safetyLevel: 'invisible' },
      { targetId: me.body.nation.id, operation: 'sabotage_tanks', safetyLevel: 'normal_precautions' },
    ]) {
      const res = await fetch(`${BASE}/api/espionage/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body),
      });
      if (res.status === 200) throw new Error(`accepted ${JSON.stringify(body)}`);
    }
  });

  await t('the log never names an undetected attacker', async () => {
    const r = await get('/api/espionage/log', token);
    eq(r.status, 200);
    for (const o of r.body.operations) {
      if (!o.yoursToRun && !o.detected && o.other !== null) {
        throw new Error('an undetected attacker was named in the log');
      }
    }
  });

  console.log('\n-- Rankings (public) --');

  await t('rankings page and API work SIGNED OUT', async () => {
    // This is the one game page a stranger sees before deciding to sign up.
    // If it ever starts requiring a token, the landing page links into a wall.
    const page = await get('/rankings.html');
    eq(page.status, 200);
    has(page.body, '/js/rankings.js', 'rankings.html');

    const api = await get('/api/rankings');          // deliberately no token
    eq(api.status, 200, 'rankings API without a token');
    if (!Array.isArray(api.body.nations)) throw new Error('no nations array');
  });

  await t('RANKINGS NEVER LEAK MONEY OR STOCKPILES', async () => {
    // Public endpoint. A visible treasury turns raiding into a shopping list,
    // and nation_summary (which this used to select from) does carry money.
    const r = await get('/api/rankings');
    const serialised = JSON.stringify(r.body);
    for (const leak of ['"money"', '"stockpile"', '"credits"']) {
      if (serialised.includes(leak)) throw new Error(`rankings exposes ${leak}`);
    }
  });

  await t('rankings are ordered by SCORE, and ranked', async () => {
    const r = await get('/api/rankings');
    const ns = r.body.nations;
    for (let i = 1; i < ns.length; i++) {
      if (ns[i].score > ns[i - 1].score) throw new Error('not sorted by score');
    }
    ns.forEach((n, i) => {
      if (n.rank !== i + 1) throw new Error(`rank ${n.rank} at index ${i}`);
      if (typeof n.score !== 'number') throw new Error('score missing');
    });
  });

  console.log('\n-- Projects --');

  await t('projects page loads and api.js comes first', async () => {
    const r = await get('/projects.html');
    eq(r.status, 200);
    const apiPos = r.body.indexOf('/js/api.js');
    const pagePos = r.body.indexOf('/js/projects.js');
    if (apiPos === -1 || pagePos === -1) throw new Error('a script tag is missing');
    if (apiPos > pagePos) throw new Error('api.js loads AFTER projects.js');
  });

  await t('project catalogue returns everything the page renders', async () => {
    const r = await get('/api/projects', token);
    eq(r.status, 200);
    const C = require('../src/engine/constants');
    eq(r.body.projects.length, Object.keys(C.PROJECTS).length, 'project count');
    eq(r.body.scorePerProject, C.PROJECT_SCORE_VALUE, 'score per project');
    for (const p of r.body.projects) {
      if (!p.key || !p.name || !p.cost) throw new Error(`incomplete project ${p.key}`);
      if (typeof p.owned !== 'boolean') throw new Error(`${p.key} has no owned flag`);
      if (typeof p.affordable !== 'boolean') throw new Error(`${p.key} has no affordable flag`);
    }
  });

  await t('SHORTFALL: an unaffordable project says WHAT you are short of', async () => {
    // "Cannot afford" makes a player shrug. A named shortfall makes them place
    // a market order, which is a move rather than a dead end.
    const r = await get('/api/projects', token);
    const broke = r.body.projects.filter(p => !p.affordable && !p.owned);
    if (broke.length === 0) throw new Error('test nation can afford everything — pick a costlier one');
    for (const p of broke) {
      if (Object.keys(p.short || {}).length === 0) {
        throw new Error(`${p.key} is unaffordable but reports no shortfall`);
      }
    }
  });

  console.log('\n-- War history --');

  await t('history page loads', async () => {
    const r = await get('/history.html');
    eq(r.status, 200);
    has(r.body, '/js/history.js', 'history.html');
  });

  await t('war history includes ENDED wars, unlike /api/wars', async () => {
    const hist = await get('/api/war-history', token);
    eq(hist.status, 200);
    if (!Array.isArray(hist.body.wars)) throw new Error('no wars array');
    for (const w of hist.body.wars) {
      if (typeof w.youAttacked !== 'boolean') throw new Error('youAttacked missing');
      if (typeof w.battleCount !== 'number') throw new Error('battleCount missing');
    }
  });

  await t('BATTLES ARE PRIVATE TO THE TWO NATIONS THAT FOUGHT', async () => {
    // Without this check, guessing a war id gives you every battle in the game,
    // which is a straightforward intelligence advantage over everyone else.
    const hist = await get('/api/war-history', token);
    if (hist.body.wars.length === 0) return;      // nothing to check yet
    const warId = hist.body.wars[0].id;

    const mine = await get(`/api/war/${warId}/battles`, token);
    eq(mine.status, 200, 'participant can read');

    const theirs = await get(`/api/war/${warId}/battles`, outsiderToken);
    if (theirs.status === 200) throw new Error('a non-participant read the battles');
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
    // index.html (the landing page) is excluded on purpose — it ships its own
    // self-contained stylesheet and never loads the game CSS.
    for (const p of ['/login.html','/dashboard.html','/cities.html','/economy.html',
                     '/policy.html','/market.html','/military.html','/admin.html',
                     '/projects.html','/history.html','/rankings.html','/espionage.html']) {
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
    for (const p of ['/index.html','/login.html','/privacy.html','/terms.html',
                     '/dashboard.html','/cities.html','/economy.html',
                     '/policy.html','/market.html','/military.html','/admin.html',
                     '/projects.html','/history.html','/rankings.html','/espionage.html']) {
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
      ['/js/rankings.js', ['Nation', 'Score', 'Cities', 'Infrastructure']],
      ['/js/history.js', ['Turn', 'Attack', 'Result', 'Loot']],
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

  await t('THE BOOK NAMES WHO IS OFFERING', async () => {
    // The market is deliberately not anonymous — see the note in
    // src/market/service.js. If the join is ever dropped the page silently
    // renders "undefined" for every nation instead of erroring.
    const money = async (tok) => {
      const snap = await get('/api/nation', tok);
      return snap.body.nation;
    };
    const me = await money(token), them = await money(otherToken);
    await db.query(`INSERT INTO nation_resources (nation_id, resource, amount)
                    VALUES ($1,'coal',500), ($2,'coal',500)
                    ON CONFLICT (nation_id, resource) DO UPDATE SET amount = 500`,
                   [me.id, them.id]);

    // Two nations resting at the SAME price — the case the depth view hides.
    const place = (tok, side, price, quantity) => fetch(BASE + '/api/market/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
      body: JSON.stringify({ resource: 'coal', side, price, quantity }),
    }).then(r => r.json());

    await place(token, 'sell', 999, 40);
    await place(otherToken, 'sell', 999, 25);

    const r = await get('/api/market/coal', token);
    if (!Array.isArray(r.body.askOrders)) throw new Error('askOrders missing — the orders view has nothing to render');

    const at999 = r.body.askOrders.filter(o => o.price === 999);
    if (at999.length !== 2) throw new Error(`expected 2 orders at 999, got ${at999.length}`);
    for (const o of at999) {
      if (!o.nationName) throw new Error('an order has no nation name');
      if (!o.createdAt) throw new Error('an order has no placed time');
    }

    const mine = at999.filter(o => o.isMine);
    if (mine.length !== 1) throw new Error(`isMine marked ${mine.length} of my own orders, expected 1`);
    if (mine[0].nationName !== me.name) throw new Error('isMine is on the wrong order');
  });

  await t('DEPTH AND ORDERS NEVER DISAGREE', async () => {
    // Two views of the same rows. If they can drift, one of them is lying to
    // the player about how much is really available at a price.
    const r = await get('/api/market/coal', token);
    for (const [levels, orders, name] of [[r.body.asks, r.body.askOrders, 'ask'],
                                          [r.body.bids, r.body.bidOrders, 'bid']]) {
      for (const lvl of levels) {
        const sum = orders.filter(o => o.price === lvl.price)
                          .reduce((a, o) => a + o.quantity, 0);
        // The orders list is capped, so only check levels it fully covers.
        if (orders.length < 25 && Math.abs(sum - lvl.quantity) > 0.001) {
          throw new Error(`${name} at ${lvl.price}: depth says ${lvl.quantity}, orders sum to ${sum}`);
        }
      }
    }
  });

  await t('ORDERS ARE LISTED IN THE ORDER THEY WILL ACTUALLY FILL', async () => {
    // Price first, then oldest first — the matching engine's own priority. A
    // book sorted any other way teaches players the wrong thing about their
    // own place in the queue.
    const r = await get('/api/market/coal', token);
    const check = (orders, dir, name) => {
      for (let i = 1; i < orders.length; i++) {
        const a = orders[i - 1], b = orders[i];
        const better = (a.price - b.price) * dir;
        if (better > 0) throw new Error(`${name} out of price order at ${i}`);
        if (better === 0 && new Date(a.createdAt) > new Date(b.createdAt)) {
          throw new Error(`${name}: at equal price ${a.price} a newer order is ahead of an older one`);
        }
      }
    };
    check(r.body.askOrders, 1, 'asks');
    check(r.body.bidOrders, -1, 'bids');
  });

  await t('COMPLETED TRADES STAY ANONYMOUS', async () => {
    // The book names who is OFFERING; a finished trade does not name either
    // side. Naming both would turn the trade log into a permanent public record
    // of who supplies whom — something players should have to find out.
    const r = await get('/api/market/coal', token);
    for (const trade of r.body.recentTrades) {
      for (const leak of ['buyerId', 'sellerId', 'buyer_id', 'seller_id',
                          'buyerName', 'sellerName', 'nationName']) {
        if (trade[leak] !== undefined) throw new Error(`a trade leaks ${leak}`);
      }
    }
    const js = await get('/js/market.js');
    if (/renderTrades[\s\S]{0,900}nationName/.test(js.body)) {
      throw new Error('the trades table renders a nation name');
    }
  });

  await t('the book can be switched between depth and orders', async () => {
    const r = await get('/js/market.js');
    has(r.body, 'data-view', 'market.js');
    has(r.body, 'bookView', 'market.js');
    has(r.body, 'askOrders', 'market.js');
    const css = await get('/css/app.css');
    has(css.body, '.bookview', 'app.css');
    has(css.body, '.level.order', 'app.css');
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
