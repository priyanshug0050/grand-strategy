/**
 * ============================================================================
 *  server.js — HTTP API
 * ============================================================================
 *
 *  Routes are deliberately THIN. Each one does three things: validate input
 *  shape, call a service function, return the result. No game logic, no SQL.
 *
 *  If a route grows an `if` about game rules, that rule belongs in the engine.
 *  If it grows a query, that belongs in the repository.
 *
 *  THE ACTING NATION ALWAYS COMES FROM THE TOKEN, NEVER THE REQUEST BODY.
 *  A route that accepted `nationId` as "who is acting" would let any player
 *  act as anyone. req.nationId is set by middleware from the JWT and nothing
 *  else.
 * ============================================================================
 */

'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const db = require('./src/data/db');
const repo = require('./src/data/repository');
const auth = require('./src/api/auth');
const service = require('./src/api/service');
const scheduler = require('./src/scheduler');
const tick = require('./src/engine/tick');
const C = require('./src/engine/constants');

const app = express();

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.set('trust proxy', 1);

// helmet's default CSP blocks the Google Fonts stylesheet the frontend uses.
// Rather than disabling CSP entirely, allow exactly those two hosts.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(express.json({ limit: '100kb' }));

/**
 * Serve the frontend from this same server.
 *
 * This is deliberate, and it removes an entire category of pain: because the
 * page and the API share an origin, there is NO cross-origin request, so CORS
 * never applies. No localhost-vs-127.0.0.1 mismatch, no preflight failures, no
 * "works in curl but not the browser".
 *
 * Open http://localhost:3000 directly. Do NOT open the HTML files with a
 * separate static server (Live Server on :5500) — that reintroduces the
 * cross-origin problem for no benefit.
 */
const path = require('path');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

/**
 * CORS.
 *
 * CORS_ORIGIN must match the browser's address bar EXACTLY — protocol, host,
 * AND port. `localhost` and `127.0.0.1` are different origins to the browser
 * even though they resolve to the same machine, and this mismatch is one of
 * the most common ways a working backend appears broken from the frontend.
 *
 * The server must be restarted after changing it; .env is read once at boot.
 */
// CORS is only relevant if you serve the frontend from a DIFFERENT origin.
// With express.static above you do not need it — leave CORS_ORIGIN unset.
const corsOrigin = process.env.CORS_ORIGIN;
if (corsOrigin) {
  app.use(cors({ origin: corsOrigin, credentials: false }));
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Try again in 15 minutes.' },
});

const actionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Slow down.' },
});

/** Wrap async handlers so a rejected promise becomes a 500 instead of a hang. */
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.post('/api/auth/register', authLimiter, wrap(async (req, res) => {
  const { email, password, nationName, leaderName, continent } = req.body || {};

  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!nationName || !continent) return res.status(400).json({ error: 'Nation name and continent required' });
  if (!C.CONTINENTS[continent]) {
    return res.status(400).json({ error: 'Invalid continent', valid: Object.keys(C.CONTINENTS) });
  }

  const passwordHash = await auth.hashPassword(password);

  const result = await db.withTransaction(async (tx) => {
    const existing = await tx.query('SELECT 1 FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) throw new service.GameError('Email already registered');

    const { rows } = await tx.query(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email',
      [email.toLowerCase(), passwordHash]
    );
    const user = rows[0];

    const gs = await repo.loadGameState(tx);
    const nation = tick.createNation(nationName, continent, gs.turn, {
      capitalName: `${nationName} City`,
    });
    nation.leaderName = leaderName || nationName;

    const nationId = await repo.createNation(tx, Number(user.id), nation);

    await repo.recordAccountLink(
      tx, nationId,
      auth.hashIdentifier(req.ip),
      auth.hashIdentifier(req.get('user-agent'))
    );

    return { user, nationId };
  });

  res.status(201).json({
    token: auth.issueToken(result.user),
    nationId: result.nationId,
    message: `Welcome. You have ${C.COLORS.BEIGE.newNationDays} days of beige protection.`,
  });
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { rows } = await db.query(
    'SELECT id, email, password_hash, is_banned FROM users WHERE email = $1',
    [email.toLowerCase()]
  );

  // Same message for unknown email and wrong password — otherwise the endpoint
  // becomes a way to enumerate which emails are registered.
  const invalid = () => res.status(401).json({ error: 'Invalid credentials' });
  if (rows.length === 0) return invalid();

  const user = rows[0];
  if (user.is_banned) return res.status(403).json({ error: 'Account suspended' });
  if (!await auth.verifyPassword(password, user.password_hash)) return invalid();

  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

  res.json({ token: auth.issueToken(user) });
}));

// ============================================================================
// PROTECTED
// ============================================================================

const protect = [auth.requireAuth, auth.requireNation(repo, db), actionLimiter];

/** Mark the player active — this is what keeps them out of inactive gray. */
const touchActivity = wrap(async (req, res, next) => {
  const gs = await db.query('SELECT current_turn FROM game_state WHERE id = 1');
  await db.query('UPDATE nations SET last_active_turn = $2 WHERE id = $1',
    [req.nationId, Number(gs.rows[0].current_turn)]);
  next();
});

// ---- Admin (a separable module — see src/admin/) ----------------------------
//
// Every route inside is gated on the DATABASE saying you are an admin, checked
// per request, and returns 404 rather than 403 to anyone who is not. There is
// no endpoint that grants admin — that happens only via direct SQL.
//
// Comment these two lines out and the admin surface disappears entirely.
const adminRoutes = require('./src/admin/routes');
app.use(adminRoutes.mount({ verifyToken: auth.verifyToken, wrap, db }));

// ---- Market (a separable module — see src/market/) --------------------------
//
// Two lines mount the entire exchange. Comment them out and the market is
// gone; nothing else in the game references src/market/, so the rest keeps
// working exactly as before.
//
// Middleware is passed IN rather than imported by the market, so the
// dependency only points one way: this file knows about the market, the
// market does not know about this file.
const marketRoutes = require('./src/market/routes');
app.use(marketRoutes.mount({ protect, touchActivity, wrap }));

// ---- Read ----

app.get('/api/nation', protect, touchActivity, wrap(async (req, res) => {
  res.json(await service.getSnapshot(req.nationId));
}));

/** The full economic ledger — every number traced to the building that made it. */
app.get('/api/economy', protect, wrap(async (req, res) => {
  res.json(await service.getEconomy(req.nationId));
}));

app.get('/api/nation/events', protect, wrap(async (req, res) => {
  res.json({ events: await service.getEvents(req.nationId, Number(req.query.limit) || 50) });
}));

/** Static reference data — lets the frontend render costs without duplicating them. */
app.get('/api/reference', wrap(async (req, res) => {
  res.json({
    improvements: C.IMPROVEMENTS,
    recipes: C.RECIPES,
    units: C.UNITS,
    projects: C.PROJECTS,
    resources: C.ALL_RESOURCES,
    continents: Object.keys(C.CONTINENTS),
    warTypes: C.WAR_TYPES,
    // The UI must not invent its own wording for these. Shipping the engine's
    // own descriptions means the war card, the wiki and the tooltip cannot
    // drift into describing the same mechanic three different ways.
    controlStates: C.CONTROL_STATES,
    mapCosts: C.COMBAT.MAP_COST,
    espionage: {
      operations: C.ESPIONAGE.OPERATION_INFO,
      difficulty: C.ESPIONAGE.OPERATION_MODIFIER,
      safetyLevels: C.ESPIONAGE.SAFETY_INFO,
      safetyValues: C.ESPIONAGE.SAFETY_LEVELS,
      operationsPerDay: C.ESPIONAGE.DAILY_OPERATIONS,
      spyCost: C.ESPIONAGE.SPY_COST,
    },
    mapMax: C.COMBAT.MAP_MAX,
    fortifyCasualtyIncrease: C.COMBAT.FORTIFY_CASUALTY_INCREASE,
    domesticPolicies: C.DOMESTIC_POLICIES,
    warPolicies: C.WAR_POLICIES,
    colors: C.COLORS.SELECTABLE,
    turnsPerDay: C.TICK.TURNS_PER_DAY,
    turnIntervalMs: Number(process.env.TURN_INTERVAL_MS) || C.TICK.TURN_INTERVAL_MS,
  });
}));

/**
 * Public — no login. Ordered by score, because score is what decides who can
 * attack whom. Never includes money: this endpoint is readable by anyone, and
 * a public treasury list turns raiding into shopping.
 */
app.get('/api/rankings', wrap(async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json(await service.getRankings({ limit }));
}));

// ---- City actions ----

app.post('/api/city/:cityId/infrastructure', protect, touchActivity, wrap(async (req, res) => {
  const target = Number(req.body?.target);
  if (!Number.isFinite(target) || target < 0) {
    return res.status(400).json({ error: 'target must be a non-negative number' });
  }
  res.json(await service.buyInfrastructure(req.nationId, req.params.cityId, target));
}));

app.post('/api/city/:cityId/land', protect, touchActivity, wrap(async (req, res) => {
  const target = Number(req.body?.target);
  if (!Number.isFinite(target) || target < 0) {
    return res.status(400).json({ error: 'target must be a non-negative number' });
  }
  res.json(await service.buyLand(req.nationId, req.params.cityId, target));
}));

app.post('/api/city/:cityId/improvements', protect, touchActivity, wrap(async (req, res) => {
  const { improvement, count } = req.body || {};
  if (!improvement || !Number.isInteger(count) || count === 0) {
    return res.status(400).json({ error: 'improvement and a non-zero integer count required' });
  }
  res.json(await service.buildImprovements(req.nationId, req.params.cityId, improvement, count));
}));

/** Preview a purchase before committing to it — cost AND consequence. */
app.post('/api/city/:cityId/preview', protect, wrap(async (req, res) => {
  const { infrastructure, land } = req.body || {};
  res.json(await service.previewCityChange(req.nationId, req.params.cityId, { infrastructure, land }));
}));

app.post('/api/city', protect, touchActivity, wrap(async (req, res) => {
  const { name, continent } = req.body || {};
  if (!name || !continent) return res.status(400).json({ error: 'name and continent required' });
  res.status(201).json(await service.foundCity(req.nationId, name, continent));
}));

// ---- Military ----

app.post('/api/military/recruit', protect, touchActivity, wrap(async (req, res) => {
  const { unit, count } = req.body || {};
  if (!unit || !Number.isInteger(count) || count <= 0) {
    return res.status(400).json({ error: 'unit and a positive integer count required' });
  }
  res.json(await service.recruit(req.nationId, unit, count));
}));

app.post('/api/war/declare', protect, touchActivity, wrap(async (req, res) => {
  const { targetId, warType } = req.body || {};
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  res.status(201).json(await service.declareWar(req.nationId, Number(targetId), warType));
}));

app.post('/api/war/:warId/attack', protect, touchActivity, wrap(async (req, res) => {
  const { attackType, target } = req.body || {};
  if (!attackType) return res.status(400).json({ error: 'attackType required' });

  // Validate the id is actually numeric BEFORE it reaches a bigint parameter.
  // Without this, a non-numeric warId becomes NaN and Postgres rejects it with
  // a 22P02 — surfacing to the player as an opaque 500 instead of a clear 400.
  const warId = Number(req.params.warId);
  if (!Number.isInteger(warId) || warId <= 0) {
    return res.status(400).json({ error: 'Invalid war id' });
  }

  res.json(await service.attack(req.nationId, warId, attackType, { target }));
}));

app.get('/api/targets', protect, wrap(async (req, res) => {
  res.json(await service.findTargets(req.nationId, Number(req.query.limit) || 40));
}));

/** Odds, army values and supply state before spending MAP. */
app.post('/api/war/:warId/preview', protect, wrap(async (req, res) => {
  const warId = Number(req.params.warId);
  if (!Number.isInteger(warId) || warId <= 0) {
    return res.status(400).json({ error: 'Invalid war id' });
  }
  const { attackType } = req.body || {};
  if (!attackType) return res.status(400).json({ error: 'attackType required' });
  res.json(await service.previewAttack(req.nationId, warId, attackType));
}));

/** Active wars, already resolved to the reader's point of view. */
app.get('/api/wars', protect, wrap(async (req, res) => {
  res.json(await service.getWars(req.nationId));
}));

/** Dig in: costs MAP, raises attacker casualties, ends when you attack. */
app.post('/api/war/:warId/fortify', protect, touchActivity, wrap(async (req, res) => {
  res.json(await service.fortify(req.nationId, req.params.warId));
}));

/**
 * Offer peace, or withdraw the offer.
 *
 * There is no separate "accept" — accepting IS offering. When both sides have
 * an offer standing the war ends, which removes a pending state that could get
 * stuck when the other player stops logging in.
 */
app.post('/api/war/:warId/peace', protect, touchActivity, wrap(async (req, res) => {
  res.json(await service.offerPeace(req.nationId, req.params.warId, false));
}));

app.delete('/api/war/:warId/peace', protect, touchActivity, wrap(async (req, res) => {
  res.json(await service.offerPeace(req.nationId, req.params.warId, true));
}));

/**
 * Replay a battle from its stored seed.
 *
 * This is why rng_seed is a column. A player who thinks the game cheated can
 * be shown the exact rolls that produced their result, reproduced from scratch.
 */
app.get('/api/battle/:battleId', protect, wrap(async (req, res) => {
  const { rows } = await db.query('SELECT * FROM battles WHERE id = $1', [req.params.battleId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Battle not found' });

  const b = rows[0];

  // Missiles and nuclear strikes do not roll, so there is nothing to re-roll.
  // Feeding them through rollBattle would manufacture a verdict out of two
  // zeroes and then report it as "verified", which is worse than saying the
  // question does not apply.
  if (b.attack_type === 'missile_launch' || b.attack_type === 'nuclear_attack') {
    return res.json({
      battle: b,
      replay: null,
      verified: null,
      reason: 'A launch is not a contest — it either arrives or is intercepted, so there are no rolls to reproduce.',
    });
  }

  const combat = require('./src/engine/combat');
  const replay = combat.rollBattle(
    db.num(b.attacker_value), db.num(b.defender_value), combat.makeRng(Number(b.rng_seed))
  );

  res.json({
    battle: b,
    replay,
    verified: replay.victoryType === b.victory_type,
  });
}));

/** Every war this nation has fought, ended ones included. */
app.get('/api/war-history', protect, wrap(async (req, res) => {
  res.json(await service.getWarHistory(req.nationId, Number(req.query.limit) || 50));
}));

/** The battles of one war — participants only. */
app.get('/api/war/:warId/battles', protect, wrap(async (req, res) => {
  res.json(await service.getWarBattles(req.nationId, req.params.warId));
}));

// ---- Espionage ----

/** Roster, both caps, and — with ?targetId= — live odds for every operation. */
app.get('/api/espionage', protect, wrap(async (req, res) => {
  res.json(await service.getEspionage(req.nationId, req.query.targetId || null));
}));

app.post('/api/espionage/train', protect, touchActivity, wrap(async (req, res) => {
  const count = Number(req.body?.count);
  if (!Number.isInteger(count) || count <= 0) {
    return res.status(400).json({ error: 'count must be a positive whole number' });
  }
  res.json(await service.trainSpies(req.nationId, count));
}));

app.post('/api/espionage/run', protect, touchActivity, wrap(async (req, res) => {
  const { targetId, operation, safetyLevel } = req.body || {};
  if (!targetId || !operation || !safetyLevel) {
    return res.status(400).json({ error: 'targetId, operation and safetyLevel are required' });
  }
  if (!/^\d+$/.test(String(targetId))) {
    return res.status(400).json({ error: 'targetId must be numeric' });
  }
  res.json(await service.runEspionage(req.nationId, Number(targetId), operation, safetyLevel));
}));

app.get('/api/espionage/log', protect, wrap(async (req, res) => {
  res.json(await service.getEspionageLog(req.nationId, Number(req.query.limit) || 40));
}));

// ---- Projects & policies ----

/** Catalogue, ownership and affordability in one call. */
app.get('/api/projects', protect, wrap(async (req, res) => {
  res.json(await service.getProjectCatalogue(req.nationId));
}));

app.post('/api/project', protect, touchActivity, wrap(async (req, res) => {
  const { project } = req.body || {};
  if (!project) return res.status(400).json({ error: 'project required' });
  res.status(201).json(await service.buildProject(req.nationId, project));
}));

/** Catalogue, current selection, cooldowns and live effects in one call. */
app.get('/api/policy', protect, wrap(async (req, res) => {
  res.json(await service.getPolicies(req.nationId));
}));

/** What a swap would change, before it locks for days. */
app.post('/api/policy/preview', protect, wrap(async (req, res) => {
  const { slot, policy } = req.body || {};
  if (!slot) return res.status(400).json({ error: 'slot required' });
  res.json(await service.previewPolicy(req.nationId, slot, policy));
}));

app.post('/api/policy', protect, touchActivity, wrap(async (req, res) => {
  const { slot, policy } = req.body || {};
  if (!slot) return res.status(400).json({ error: 'slot required' });
  res.json(await service.setPolicy(req.nationId, slot, policy));
}));

// ---- Ops ----

app.get('/api/health', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT current_turn, last_tick_at FROM game_state WHERE id = 1');
  res.json({
    ok: true,
    turn: Number(rows[0].current_turn),
    lastTick: rows[0].last_tick_at,
    turnIntervalMs: Number(process.env.TURN_INTERVAL_MS) || C.TICK.TURN_INTERVAL_MS,
    schedulerRunning: scheduler.isRunning(),
  });
}));

// ============================================================================
// ERROR HANDLING
// ============================================================================

// API 404s return JSON; anything else falls through to the frontend's index.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Rule violations are the player's business and safe to show.
  if (err.isPlayerError || err.name === 'GameError') {
    return res.status(400).json({ error: err.message, ...err.details });
  }

  // Database CHECK constraint — the backstop fired. That means application
  // code tried to write an impossible value, which is a bug worth logging
  // loudly, but the player only needs to know the action failed.
  if (err.code === '23514') {
    console.error('[server] CHECK constraint violated — engine allowed an invalid state:', err.detail);
    return res.status(400).json({ error: 'Action would create an invalid state' });
  }
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Already exists' });
  }

  console.error('[server] unhandled:', err);
  // Never leak stack traces or SQL to the client.
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// BOOT
// ============================================================================

/**
 * Refuse to boot against a database the code has outgrown.
 *
 * Every migration so far has been appended to db/schema.sql as an
 * ALTER ... IF NOT EXISTS, which is safe to re-run — and therefore very easy to
 * forget to run at all. The failure mode is the worst kind: the server starts
 * fine, every page loads, and then one specific action returns a 500 with
 * "Internal server error" and the player has no idea why.
 *
 * That happened with espionage_ops.result. This turns it into a startup error
 * that names the file to run.
 *
 * Add a row here whenever a migration adds a column the code depends on.
 */
const REQUIRED_COLUMNS = [
  ['nations', 'economic_policy'],
  ['nations', 'social_policy'],
  ['nations', 'military_policy'],
  ['nations', 'spies'],
  ['users', 'is_admin'],
  ['espionage_ops', 'result'],
  ['wars', 'attacker_fortified'],
  ['wars', 'attacker_peace_offer'],
];

async function assertSchemaIsCurrent() {
  const { rows } = await db.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'`
  );
  const present = new Set(rows.map(r => `${r.table_name}.${r.column_name}`));
  const missing = REQUIRED_COLUMNS
    .map(([t, c]) => `${t}.${c}`)
    .filter(key => !present.has(key));

  if (missing.length) {
    console.error('=========================================================');
    console.error(' DATABASE IS OUT OF DATE — refusing to start.');
    console.error('');
    console.error(' Missing: ' + missing.join(', '));
    console.error('');
    console.error(' Run the migrations:');
    console.error('   psql "$DATABASE_URL" -f db/schema.sql');
    console.error('');
    console.error(' Everything in that file is IF NOT EXISTS, so it is safe');
    console.error(' to run against a database that is already up to date.');
    console.error(' On Render: run it in the Neon SQL Editor BEFORE deploying.');
    console.error('=========================================================');
    throw new Error('Database schema is out of date: missing ' + missing.join(', '));
  }
}

async function start() {
  auth.getSecret();   // fail fast if JWT_SECRET is missing

  db.createPool();

  await db.query('SELECT 1');
  console.log('[server] database connected');

  await assertSchemaIsCurrent();

  if (process.env.RESET_DB === 'true') {
    console.warn('=========================================================');
    console.warn(' RESET_DB=true — this WIPES ALL DATA on every restart.');
    console.warn(' Set it to false in .env immediately after first boot.');
    console.warn('=========================================================');
  }

  await scheduler.catchUp();
  scheduler.start();

  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => {
    console.log(`[server] listening on http://localhost:${port}`);
    console.log(`[server] open that address in your browser to play`);
    if (corsOrigin) console.log(`[server] CORS also allowed from: ${corsOrigin}`);
  });

  const shutdown = async () => {
    console.log('\n[server] shutting down...');
    scheduler.stop();
    server.close();
    await db.closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) {
  start().catch(err => { console.error('[server] failed to start:', err.message); process.exit(1); });
}

module.exports = { app, start, assertSchemaIsCurrent };
