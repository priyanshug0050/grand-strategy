/**
 * ==========================================================================
 *  test-admin.js — the security tests
 * ==========================================================================
 *
 *  These are not feature tests. Every one of them exists to prove that a
 *  NON-admin cannot do something, or that an admin action leaves a trace.
 *
 *  If any of these ever fail, stop and fix it before shipping — a broken gate
 *  here is worth more than every other bug in the project combined.
 * ==========================================================================
 */

require('dotenv').config({ quiet: true });
process.env.PORT = process.env.TEST_PORT || '3130';

const { start } = require('../server');
const db = require('../src/data/db');
const scheduler = require('../src/scheduler');

let pass = 0, fail = 0;
async function t(n, f) {
  try { await f(); console.log('  PASS ' + n); pass++; }
  catch (e) { console.log('  FAIL ' + n + ' -> ' + e.message); fail++; }
}
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ''} expected ${b}, got ${a}`); }

const BASE = 'http://127.0.0.1:' + process.env.PORT;
const EMAILS = ['theadmin@test.com', 'normal@test.com', 'attacker@test.com'];

async function api(path, { method = 'GET', body, token, ua } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': ua || 'admin-test',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

async function register(email, nation, ua) {
  const r = await api('/api/auth/register', {
    method: 'POST', ua,
    body: { email, password: 'password123', nationName: nation, leaderName: 'L', continent: 'europe' },
  });
  return r.body.token;
}

async function cleanup() {
  await db.query('DELETE FROM admin_log WHERE admin_email = ANY($1::text[])', [EMAILS]);
  await db.query('DELETE FROM users WHERE email = ANY($1::text[])', [EMAILS]);
}

(async () => {
  const server = await start();
  await cleanup();
  await new Promise(r => setTimeout(r, 300));

  const adminToken = await register('theadmin@test.com', 'AdminLand', 'ua-admin');
  const normalToken = await register('normal@test.com', 'NormalLand', 'ua-normal');
  const attackerToken = await register('attacker@test.com', 'AttackerLand', 'ua-attacker');

  const { rows: adminRows } = await db.query('SELECT id FROM users WHERE email=$1', ['theadmin@test.com']);
  const adminUserId = Number(adminRows[0].id);
  const { rows: normalRows } = await db.query('SELECT id FROM users WHERE email=$1', ['normal@test.com']);
  const normalUserId = Number(normalRows[0].id);
  const { rows: nationRows } = await db.query('SELECT id FROM nations WHERE name=$1', ['NormalLand']);
  const normalNationId = Number(nationRows[0].id);

  const ADMIN_ROUTES = [
    ['GET', '/api/admin/whoami'],
    ['GET', '/api/admin/nations'],
    ['GET', `/api/admin/nation/${normalNationId}`],
    ['GET', '/api/admin/suspected-links'],
    ['GET', '/api/admin/flagged-trades'],
    ['GET', '/api/admin/log'],
    ['POST', `/api/admin/nation/${normalNationId}/money`],
    ['POST', `/api/admin/nation/${normalNationId}/resource`],
    ['POST', `/api/admin/nation/${normalNationId}/grant`],
    ['POST', `/api/admin/nation/${normalNationId}/beige`],
    ['POST', `/api/admin/user/${normalUserId}/ban`],
  ];

  console.log('\n-- BEFORE anyone is an admin, nothing works --');

  await t('a normal signed-in player gets 404 on EVERY admin route', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      // Only POST carries a body — fetch rejects a GET with one.
      const r = await api(path, {
        method, token: normalToken,
        body: method === 'POST' ? { amount: 1e12, reason: 'hack attempt' } : undefined,
      });
      if (r.status !== 404) throw new Error(`${method} ${path} returned ${r.status}, expected 404`);
    }
  });

  await t('an anonymous caller gets 404 too', async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      const r = await api(path, {
        method,
        body: method === 'POST' ? { amount: 1e12, reason: 'hack attempt' } : undefined,
      });
      if (r.status !== 404) throw new Error(`${method} ${path} returned ${r.status}`);
    }
  });

  await t('404 NOT 403 — the panel must be invisible, not merely locked', async () => {
    // A 403 confirms the endpoint exists and is worth attacking. A 404 says
    // nothing at all.
    const r = await api('/api/admin/nations', { token: normalToken });
    eq(r.status, 404);
    if (JSON.stringify(r.body).toLowerCase().includes('admin')) {
      throw new Error('the response mentions admin — that is a hint');
    }
  });

  await t('a garbage token is refused', async () => {
    const r = await api('/api/admin/nations', { token: 'not.a.real.token' });
    if (r.status === 200) throw new Error('garbage token accepted');
  });

  console.log('\n-- THERE IS NO ROUTE THAT GRANTS ADMIN --');

  await t('no endpoint anywhere can make you an admin', async () => {
    // Every plausible shape an attacker would try.
    const attempts = [
      ['POST', '/api/admin/promote', { userId: normalUserId }],
      ['POST', '/api/admin/user/' + normalUserId + '/admin', { isAdmin: true }],
      ['POST', '/api/admin/grant-admin', { email: 'normal@test.com' }],
      ['POST', '/api/user/admin', { isAdmin: true }],
      ['POST', '/api/admin/setup', {}],
    ];
    for (const [method, path, body] of attempts) {
      const r = await api(path, { method, body, token: normalToken });
      if (r.status === 200) throw new Error(`${path} succeeded — a promotion endpoint exists`);
    }
    // And confirm nothing actually changed.
    const { rows } = await db.query('SELECT is_admin FROM users WHERE id=$1', [normalUserId]);
    eq(rows[0].is_admin, false, 'normal user became admin:');
  });

  await t('registering does not make you an admin', async () => {
    const { rows } = await db.query(
      'SELECT is_admin FROM users WHERE email = ANY($1::text[])', [EMAILS]);
    for (const r of rows) {
      if (r.is_admin) throw new Error('a freshly registered user is an admin');
    }
  });

  console.log('\n-- Promotion happens ONLY in SQL --');

  await db.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [adminUserId]);

  await t('the promoted account can now read', async () => {
    const r = await api('/api/admin/whoami', { token: adminToken });
    eq(r.status, 200);
    eq(r.body.email, 'theadmin@test.com');
  });

  await t('everyone else is still shut out', async () => {
    eq((await api('/api/admin/nations', { token: normalToken })).status, 404);
    eq((await api('/api/admin/nations', { token: attackerToken })).status, 404);
  });

  await t('the SAME token stops working the moment the flag is removed', async () => {
    // This is why admin status is read from the database, not baked into the
    // JWT: a token claim would keep working for days after revocation.
    await db.query('UPDATE users SET is_admin = FALSE WHERE id = $1', [adminUserId]);
    const denied = await api('/api/admin/nations', { token: adminToken });
    eq(denied.status, 404, 'revocation did not take effect immediately:');

    await db.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [adminUserId]);
    eq((await api('/api/admin/nations', { token: adminToken })).status, 200);
  });

  await t('a BANNED admin is refused', async () => {
    await db.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [adminUserId]);
    eq((await api('/api/admin/nations', { token: adminToken })).status, 404);
    await db.query('UPDATE users SET is_banned = FALSE WHERE id = $1', [adminUserId]);
  });

  console.log('\n-- Actions require a reason, and are logged --');

  await t('an action with NO reason is refused', async () => {
    const r = await api(`/api/admin/nation/${normalNationId}/money`, {
      method: 'POST', token: adminToken, body: { amount: 500000 },
    });
    eq(r.status, 400);
    if (!r.body.error.toLowerCase().includes('reason')) throw new Error(r.body.error);
  });

  await t('an action with a token reason is refused', async () => {
    const r = await api(`/api/admin/nation/${normalNationId}/money`, {
      method: 'POST', token: adminToken, body: { amount: 500000, reason: 'x' },
    });
    eq(r.status, 400);
  });

  await t('a legitimate action succeeds AND is logged', async () => {
    const before = await db.query('SELECT COUNT(*) AS n FROM admin_log');

    const r = await api(`/api/admin/nation/${normalNationId}/money`, {
      method: 'POST', token: adminToken,
      body: { amount: 5000000, reason: 'Refund for the failed build in war 412' },
    });
    eq(r.status, 200);
    eq(r.body.after, 5000000);

    const after = await db.query('SELECT COUNT(*) AS n FROM admin_log');
    if (Number(after.rows[0].n) !== Number(before.rows[0].n) + 1) {
      throw new Error('no audit entry was written');
    }
  });

  await t('the log records who, what, before, after and why', async () => {
    const { rows } = await db.query(
      `SELECT * FROM admin_log WHERE action='set_money' ORDER BY id DESC LIMIT 1`);
    const e = rows[0];
    eq(e.admin_email, 'theadmin@test.com');
    eq(e.target_type, 'nation');
    if (!e.before_value) throw new Error('no before value');
    if (!e.after_value) throw new Error('no after value');
    if (!e.reason) throw new Error('no reason');
    if (!e.ip_hash) throw new Error('no ip recorded');
  });

  await t('the change actually applied to the game', async () => {
    const { rows } = await db.query('SELECT money FROM nations WHERE id=$1', [normalNationId]);
    eq(db.num(rows[0].money), 5000000);
  });

  await t('resource changes are logged the same way', async () => {
    const r = await api(`/api/admin/nation/${normalNationId}/resource`, {
      method: 'POST', token: adminToken,
      body: { resource: 'steel', amount: 250, reason: 'Compensation for the market bug' },
    });
    eq(r.status, 200);
    const { rows } = await db.query(
      `SELECT * FROM admin_log WHERE action='set_resource' ORDER BY id DESC LIMIT 1`);
    if (!rows.length) throw new Error('resource change not logged');
  });

  await t('an unknown resource is refused', async () => {
    const r = await api(`/api/admin/nation/${normalNationId}/resource`, {
      method: 'POST', token: adminToken,
      body: { resource: 'unobtanium', amount: 100, reason: 'testing the guard' },
    });
    eq(r.status, 400);
  });

  await t('a negative amount is refused', async () => {
    const r = await api(`/api/admin/nation/${normalNationId}/money`, {
      method: 'POST', token: adminToken,
      body: { amount: -100, reason: 'testing the guard' },
    });
    eq(r.status, 400);
  });

  console.log('\n-- Self-protection --');

  await t('an admin cannot ban another admin by accident', async () => {
    const r = await api(`/api/admin/user/${adminUserId}/ban`, {
      method: 'POST', token: adminToken,
      body: { banned: true, reason: 'trying to lock myself out' },
    });
    eq(r.status, 400);
    if (!r.body.error.toLowerCase().includes('admin')) throw new Error(r.body.error);
  });

  await t('the admin panel HTML is public, and that is fine', async () => {
    // The page contains no data. Every call it makes 404s for non-admins, so
    // hiding the file would be theatre.
    const r = await api('/admin.html');
    eq(r.status, 200);
    if (typeof r.body !== 'string' || !r.body.includes('Admin')) {
      throw new Error('admin.html did not serve');
    }
  });

  await t('but the DATA behind it is not', async () => {
    eq((await api('/api/admin/nations', { token: normalToken })).status, 404);
  });

  console.log('\n-- The log is append-only from inside the app --');

  await t('no route exists to delete or edit the audit log', async () => {
    const attempts = [
      ['DELETE', '/api/admin/log'],
      ['DELETE', '/api/admin/log/1'],
      ['POST', '/api/admin/log/clear'],
      ['PUT', '/api/admin/log/1'],
    ];
    for (const [method, path] of attempts) {
      const r = await api(path, { method, token: adminToken });
      if (r.status === 200) throw new Error(`${method} ${path} succeeded — the log is editable`);
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
