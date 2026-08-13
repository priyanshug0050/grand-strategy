/**
 * ============================================================================
 *  repository.js — DB rows <-> engine state
 * ============================================================================
 *
 *  The engine knows nothing about SQL. The database knows nothing about game
 *  rules. This file is the only place the two meet, and it is deliberately
 *  boring: load, translate, save. No game logic lives here.
 *
 *  If you find yourself writing an `if` about game rules in this file, it
 *  belongs in the engine instead.
 *
 *  EVERY WRITE FUNCTION TAKES A `tx`.
 *  There is no non-transactional write path, on purpose. A write outside a
 *  transaction is a write that can interleave with another request, and that
 *  is the whole class of bug this layer exists to prevent.
 * ============================================================================
 */

'use strict';

const { num, toMap } = require('./db');
const C = require('../engine/constants');

// ============================================================================
// LOAD
// ============================================================================

/**
 * Load a nation in exactly the shape the engine expects.
 *
 * Note what is NOT loaded: population, score, commerce, disease. Those are
 * derived by the engine from the rows below. There is no column for them and
 * there should never be one.
 *
 * @param {Object} tx
 * @param {number} nationId
 * @param {Object} opts { lock: boolean, currentTurn: number }
 */
async function loadNation(tx, nationId, opts = {}) {
  const lockClause = opts.lock ? 'FOR UPDATE' : '';

  const { rows: nationRows } = await tx.query(
    `SELECT * FROM nations WHERE id = $1 AND is_deleted = FALSE ${lockClause}`,
    [nationId]
  );
  if (nationRows.length === 0) return null;
  const n = nationRows[0];

  // ⚠️ These MUST run sequentially, not via Promise.all.
  // A pg client is a single connection with one wire protocol stream — issuing
  // concurrent queries on it is deprecated and can interleave results. The
  // "parallel" version looks faster and is actually a correctness bug.
  const cities = await loadCities(tx, nationId);
  const resources = await tx.query(
    'SELECT resource, amount FROM nation_resources WHERE nation_id = $1', [nationId]);
  const units = await tx.query(
    'SELECT unit_key, count FROM nation_units WHERE nation_id = $1', [nationId]);
  const projects = await tx.query(
    'SELECT project_key FROM nation_projects WHERE nation_id = $1', [nationId]);

  const recruited = opts.currentTurn !== undefined
    ? await tx.query(
        'SELECT unit_key, count FROM recruitment_log WHERE nation_id = $1 AND game_day = $2',
        [nationId, Math.floor(opts.currentTurn / C.TICK.TURNS_PER_DAY)])
    : { rows: [] };

  const alliance = n.alliance_id
    ? await tx.query('SELECT color FROM alliances WHERE id = $1', [n.alliance_id])
    : { rows: [] };

  // Every resource present and zeroed, so the engine never sees undefined.
  const stockpile = {};
  for (const r of C.ALL_RESOURCES) stockpile[r] = 0;
  Object.assign(stockpile, toMap(resources.rows, 'resource', 'amount'));

  const unitBag = {};
  for (const u of Object.keys(C.UNITS)) unitBag[u] = 0;
  Object.assign(unitBag, toMap(units.rows, 'unit_key', 'count'));

  return {
    id: Number(n.id),
    userId: Number(n.user_id),
    name: n.name,
    leaderName: n.leader_name,
    continent: n.continent,

    money: num(n.money),
    map: Number(n.map_points),
    spies: Number(n.spies),

    color: n.color,
    // Three slots, each independently cooled down. The old domestic/war pair
    // is kept alongside so nothing that still reads it breaks mid-migration.
    policies: {
      economic: n.economic_policy || null,
      social: n.social_policy || null,
      military: n.military_policy || null,
      domestic: n.domestic_policy,
      war: n.war_policy,
    },
    policyTurns: {
      economic: n.economic_policy_turn !== null ? Number(n.economic_policy_turn) : null,
      social: n.social_policy_turn !== null ? Number(n.social_policy_turn) : null,
      military: n.military_policy_turn !== null ? Number(n.military_policy_turn) : null,
    },

    allianceId: n.alliance_id ? Number(n.alliance_id) : null,
    allianceColor: alliance.rows[0] ? alliance.rows[0].color : null,
    allianceRole: n.alliance_role,

    cities,
    stockpile,
    units: unitBag,
    projects: projects.rows.map(r => r.project_key),
    recruitedToday: toMap(recruited.rows, 'unit_key', 'count'),

    // ?? not || — turn 0 is a legitimate value, and treating it as unset is a
    // real bug that made inactive nations look permanently active.
    foundedTurn: n.founded_turn !== null ? Number(n.founded_turn) : 0,
    beigeUntilTurn: n.beige_until_turn !== null ? Number(n.beige_until_turn) : undefined,
    lastActiveTurn: n.last_active_turn !== null ? Number(n.last_active_turn) : 0,
    lastCityTurn: n.last_city_turn !== null ? Number(n.last_city_turn) : null,
    joinedAllianceTurn: n.joined_alliance_turn !== null ? Number(n.joined_alliance_turn) : null,
    domesticPolicyTurn: n.domestic_policy_turn !== null ? Number(n.domestic_policy_turn) : null,
    warPolicyTurn: n.war_policy_turn !== null ? Number(n.war_policy_turn) : null,
    colorChangedTurn: n.color_changed_turn !== null ? Number(n.color_changed_turn) : null,
  };
}

async function loadCities(tx, nationId) {
  const { rows } = await tx.query(
    `SELECT c.id, c.name, c.continent, c.infrastructure, c.land, c.founded_turn, c.powered,
            COALESCE(
              json_object_agg(ci.improvement_key, ci.count)
                FILTER (WHERE ci.improvement_key IS NOT NULL),
              '{}'
            ) AS improvements
       FROM cities c
       LEFT JOIN city_improvements ci ON ci.city_id = c.id AND ci.count > 0
      WHERE c.nation_id = $1
      GROUP BY c.id
      ORDER BY c.id`,
    [nationId]
  );

  return rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    continent: r.continent,
    infrastructure: num(r.infrastructure),
    land: num(r.land),
    foundedTurn: Number(r.founded_turn),
    powered: r.powered,
    improvements: r.improvements || {},
  }));
}

async function loadGameState(tx) {
  const { rows } = await tx.query('SELECT * FROM game_state WHERE id = 1');
  const g = rows[0];
  return {
    turn: Number(g.current_turn),
    world: { radiation: num(g.world_radiation) },
    lastTickAt: g.last_tick_at,
    tickInProgress: g.tick_in_progress,
  };
}

// ============================================================================
// SAVE
// ============================================================================

/**
 * Persist a nation. Writes only what changed shape-wise; derived values are
 * never written because they are never stored.
 */
async function saveNation(tx, nation) {
  if (!nation.id) throw new Error('saveNation requires nation.id');

  await tx.query(
    `UPDATE nations SET
       money = $2, map_points = $3, spies = $4, color = $5,
       domestic_policy = $6, war_policy = $7,
       beige_until_turn = $8, last_active_turn = $9, last_city_turn = $10,
       alliance_id = $11, joined_alliance_turn = $12
     WHERE id = $1`,
    [
      nation.id,
      nation.money,
      nation.map,
      nation.spies || 0,
      nation.color,
      nation.policies?.domestic || null,
      nation.policies?.war || null,
      nation.beigeUntilTurn ?? null,
      nation.lastActiveTurn ?? 0,
      nation.lastCityTurn ?? null,
      nation.allianceId ?? null,
      nation.joinedAllianceTurn ?? null,
    ]
  );

  await saveResources(tx, nation.id, nation.stockpile);
  await saveUnits(tx, nation.id, nation.units);
}

/**
 * Upsert the whole stockpile in one round-trip.
 *
 * The CHECK (amount >= 0) constraint on the table is the backstop here: if the
 * engine ever hands us a negative amount, this INSERT aborts the transaction
 * rather than persisting an impossible balance.
 */
async function saveResources(tx, nationId, stockpile) {
  const entries = Object.entries(stockpile).filter(([k]) => k !== 'money' && k !== 'credits' || k === 'credits');
  if (entries.length === 0) return;

  const keys = entries.map(([k]) => k);
  const values = entries.map(([, v]) => Math.max(num(v), 0));

  await tx.query(
    `INSERT INTO nation_resources (nation_id, resource, amount)
     SELECT $1, k, v FROM unnest($2::text[], $3::numeric[]) AS t(k, v)
     ON CONFLICT (nation_id, resource) DO UPDATE SET amount = EXCLUDED.amount`,
    [nationId, keys, values]
  );
}

async function saveUnits(tx, nationId, units) {
  const entries = Object.entries(units || {});
  if (entries.length === 0) return;

  await tx.query(
    `INSERT INTO nation_units (nation_id, unit_key, count)
     SELECT $1, k, v FROM unnest($2::text[], $3::bigint[]) AS t(k, v)
     ON CONFLICT (nation_id, unit_key) DO UPDATE SET count = EXCLUDED.count`,
    [nationId, entries.map(([k]) => k), entries.map(([, v]) => Math.max(Math.floor(v), 0))]
  );
}

async function saveCity(tx, cityObj) {
  if (!cityObj.id) throw new Error('saveCity requires city.id');

  await tx.query(
    `UPDATE cities SET infrastructure = $2, land = $3, powered = $4 WHERE id = $1`,
    [cityObj.id, cityObj.infrastructure, cityObj.land, cityObj.powered || false]
  );

  const entries = Object.entries(cityObj.improvements || {});
  if (entries.length > 0) {
    await tx.query(
      `INSERT INTO city_improvements (city_id, improvement_key, count)
       SELECT $1, k, v FROM unnest($2::text[], $3::smallint[]) AS t(k, v)
       ON CONFLICT (city_id, improvement_key) DO UPDATE SET count = EXCLUDED.count`,
      [cityObj.id, entries.map(([k]) => k), entries.map(([, v]) => Math.max(Math.floor(v), 0))]
    );
  }
}

async function saveCities(tx, cities) {
  for (const c of cities) await saveCity(tx, c);
}

async function saveGameState(tx, state) {
  await tx.query(
    `UPDATE game_state SET current_turn = $1, world_radiation = $2, last_tick_at = now()
     WHERE id = 1`,
    [state.turn, state.world?.radiation ?? 0]
  );
}

// ============================================================================
// EVENTS
// ============================================================================

/** Bulk-insert the events a tick produced. One round-trip regardless of count. */
async function recordEvents(tx, nationId, events) {
  if (!events || events.length === 0) return;

  await tx.query(
    `INSERT INTO events (nation_id, turn, type, payload)
     SELECT $1, t.turn, t.type, t.payload
       FROM unnest($2::bigint[], $3::text[], $4::jsonb[]) AS t(turn, type, payload)`,
    [
      nationId,
      events.map(e => e.turn ?? 0),
      events.map(e => e.type),
      events.map(e => JSON.stringify(e)),
    ]
  );
}

// ============================================================================
// CREATE
// ============================================================================

/**
 * Create a nation from the engine's factory output.
 * Returns the nation id.
 */
async function createNation(tx, userId, nation) {
  const { rows } = await tx.query(
    `INSERT INTO nations
       (user_id, name, leader_name, continent, money, color,
        founded_turn, beige_until_turn, last_active_turn)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      userId, nation.name, nation.leaderName || nation.name, nation.continent,
      nation.money, nation.color,
      nation.foundedTurn, nation.beigeUntilTurn ?? null, nation.lastActiveTurn ?? 0,
    ]
  );
  const nationId = Number(rows[0].id);

  for (const c of nation.cities) {
    await createCity(tx, nationId, c);
  }

  await saveResources(tx, nationId, nation.stockpile);
  await saveUnits(tx, nationId, nation.units);

  return nationId;
}

async function createCity(tx, nationId, cityObj) {
  const { rows } = await tx.query(
    `INSERT INTO cities (nation_id, name, continent, infrastructure, land, founded_turn)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [nationId, cityObj.name, cityObj.continent, cityObj.infrastructure, cityObj.land, cityObj.foundedTurn]
  );
  const cityId = Number(rows[0].id);

  const entries = Object.entries(cityObj.improvements || {});
  if (entries.length > 0) {
    await tx.query(
      `INSERT INTO city_improvements (city_id, improvement_key, count)
       SELECT $1, k, v FROM unnest($2::text[], $3::smallint[]) AS t(k, v)`,
      [cityId, entries.map(([k]) => k), entries.map(([, v]) => v)]
    );
  }
  return cityId;
}

// ============================================================================
// RECRUITMENT LOG
// ============================================================================

async function logRecruitment(tx, nationId, gameDay, unitKey, count) {
  await tx.query(
    `INSERT INTO recruitment_log (nation_id, game_day, unit_key, count)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (nation_id, game_day, unit_key)
     DO UPDATE SET count = recruitment_log.count + EXCLUDED.count`,
    [nationId, gameDay, unitKey, count]
  );
}

// ============================================================================
// ANTI-ABUSE
// ============================================================================

async function recordAccountLink(tx, nationId, ipHash, deviceHash) {
  await tx.query(
    `INSERT INTO account_links (nation_id, ip_hash, device_hash)
     VALUES ($1,$2,$3)
     ON CONFLICT (nation_id, ip_hash, device_hash) DO UPDATE SET last_seen = now()`,
    [nationId, ipHash || null, deviceHash || null]
  );
}

/**
 * Are these two nations linked by IP or device?
 *
 * Linked nations may coexist, but must not trade with each other, war the same
 * target, or route funds between themselves. Row locks do nothing against this
 * class of abuse — it is social, not mechanical.
 */
async function areNationsLinked(tx, nationA, nationB) {
  const { rows } = await tx.query(
    `SELECT 1 FROM linked_nations WHERE nation_a = $1 AND nation_b = $2 LIMIT 1`,
    [nationA, nationB]
  );
  return rows.length > 0;
}

module.exports = {
  loadNation,
  loadCities,
  loadGameState,
  saveNation,
  saveCity,
  saveCities,
  saveResources,
  saveUnits,
  saveGameState,
  recordEvents,
  createNation,
  createCity,
  logRecruitment,
  recordAccountLink,
  areNationsLinked,
};
