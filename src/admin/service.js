/**
 * ============================================================================
 *  src/admin/service.js — administrative actions
 * ============================================================================
 *
 *  Every function here follows the same shape as the game's own service layer:
 *  lock, read, decide, write, commit. Plus one extra rule that applies only to
 *  this folder —
 *
 *      EVERY MUTATION WRITES AN AUDIT ENTRY IN THE SAME TRANSACTION.
 *
 *  Not after. Not best-effort. In the same transaction, so the log and the
 *  change cannot disagree. An admin action nobody can reconstruct afterwards
 *  is indistinguishable from a duping bug, and "the admin panel did it" is not
 *  an answer you can give a player without evidence.
 *
 *  A `reason` is required on anything destructive. Six months from now the
 *  difference between "gave 500 steel" and "gave 500 steel — refund for the
 *  failed build in war #412" is the difference between a record and a rumour.
 * ============================================================================
 */

'use strict';

const db = require('../data/db');
const repo = require('../data/repository');
const tick = require('../engine/tick');
const C = require('../engine/constants');
const { logAction, hashIp } = require('./guard');

/** Player-facing rule violation — becomes a 400, not a 500. */
class AdminError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AdminError';
    this.isPlayerError = true;
    this.details = details;
  }
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ============================================================================
// READ
// ============================================================================

/** Every nation, with enough detail to spot something wrong. */
async function listNations(opts = {}) {
  const search = opts.search ? `%${opts.search}%` : null;

  const { rows } = await db.query(
    `SELECT n.id, n.name, n.leader_name, n.continent, n.color, n.money,
            n.is_deleted, n.beige_until_turn, n.last_active_turn,
            n.alliance_id, u.email, u.is_banned, u.is_admin,
            COUNT(DISTINCT c.id) AS city_count,
            COALESCE(SUM(c.infrastructure),0) AS total_infra
       FROM nations n
       JOIN users u ON u.id = n.user_id
       LEFT JOIN cities c ON c.nation_id = n.id
      WHERE ($1::text IS NULL OR n.name ILIKE $1 OR u.email ILIKE $1)
      GROUP BY n.id, u.email, u.is_banned, u.is_admin
      ORDER BY n.id`,
    [search]
  );

  return rows.map(r => ({
    id: Number(r.id),
    name: r.name,
    leaderName: r.leader_name,
    email: r.email,
    continent: r.continent,
    color: r.color,
    money: db.num(r.money),
    cities: Number(r.city_count),
    infrastructure: db.num(r.total_infra),
    allianceId: r.alliance_id ? Number(r.alliance_id) : null,
    isDeleted: r.is_deleted,
    isBanned: r.is_banned,
    isAdmin: r.is_admin,
    onBeige: r.beige_until_turn !== null,
    lastActiveTurn: r.last_active_turn !== null ? Number(r.last_active_turn) : 0,
  }));
}

/** Everything about one nation, including what the player themselves sees. */
async function inspectNation(nationId) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    if (!nation) throw new AdminError('Nation not found');

    const snap = tick.snapshot(nation, gs.turn, { radiation: gs.world.radiation });

    const [wars, orders, recentLog] = [
      await tx.query(
        `SELECT w.*, a.name AS attacker_name, d.name AS defender_name
           FROM wars w
           JOIN nations a ON a.id = w.attacker_id
           JOIN nations d ON d.id = w.defender_id
          WHERE (w.attacker_id=$1 OR w.defender_id=$1) AND w.ended_turn IS NULL`,
        [nationId]),
      await tx.query(
        `SELECT id, resource, side, price, quantity, filled
           FROM market_orders WHERE nation_id=$1 AND is_open=TRUE`,
        [nationId]),
      await tx.query(
        `SELECT action, admin_email, reason, created_at
           FROM admin_log WHERE target_type='nation' AND target_id=$1
          ORDER BY created_at DESC LIMIT 20`,
        [nationId]),
    ];

    return {
      turn: gs.turn,
      nation: {
        id: nation.id,
        name: nation.name,
        leaderName: nation.leaderName,
        continent: nation.continent,
        color: nation.color,
        money: nation.money,
        map: nation.map,
        stockpile: nation.stockpile,
        units: nation.units,
        projects: nation.projects,
        policies: nation.policies,
        allianceId: nation.allianceId,
        beigeUntilTurn: nation.beigeUntilTurn ?? null,
      },
      cities: nation.cities,
      score: snap.score,
      population: snap.totalPopulation,
      revenue: snap.revenue,
      wars: wars.rows,
      openOrders: orders.rows,
      // Anything ever done to this nation by an admin, shown up front.
      adminHistory: recentLog.rows,
    };
  });
}

/**
 * Accounts that share an IP but not a device.
 *
 * Never blocks anything on its own — see the schema comment. A household or a
 * campus looks exactly like alt-farming from the outside, and auto-punishing
 * the wrong one is worse than letting a human look.
 */
async function suspectedLinks() {
  const { rows } = await db.query(
    `SELECT s.nation_a, s.nation_b, a.name AS name_a, b.name AS name_b
       FROM suspected_links s
       JOIN nations a ON a.id = s.nation_a
       JOIN nations b ON b.id = s.nation_b
      WHERE s.nation_a < s.nation_b
      LIMIT 200`
  );
  return rows.map(r => ({
    a: { id: Number(r.nation_a), name: r.name_a },
    b: { id: Number(r.nation_b), name: r.name_b },
  }));
}

/** Trades flagged as far from the going rate — possible wash trading. */
async function flaggedTrades(limit = 50) {
  const { rows } = await db.query(
    `SELECT t.id, t.resource, t.price, t.quantity, t.turn, t.executed_at,
            b.name AS buyer, s.name AS seller
       FROM trades t
       LEFT JOIN nations b ON b.id = t.buyer_id
       LEFT JOIN nations s ON s.id = t.seller_id
      WHERE t.flagged = TRUE
      ORDER BY t.executed_at DESC LIMIT $1`,
    [Math.min(limit, 200)]
  );
  return rows;
}

/** The audit trail. Read-only — nothing in the app can edit or delete it. */
async function auditLog(limit = 100) {
  const { rows } = await db.query(
    `SELECT id, admin_email, action, target_type, target_id, target_name,
            before_value, after_value, reason, turn, created_at
       FROM admin_log ORDER BY created_at DESC LIMIT $1`,
    [Math.min(limit, 500)]
  );
  return rows;
}

// ============================================================================
// MUTATIONS — all logged, all in one transaction
// ============================================================================

/**
 * Set a nation's money to an exact figure.
 *
 * Absolute, not relative. "Set to 5,000,000" is reproducible from the log;
 * "add 2,000,000" depends on what the balance happened to be at the time, and
 * six months later nobody can reconstruct it.
 */
async function setMoney(admin, nationId, amount, reason, req) {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AdminError('Amount must be a non-negative number');
  }
  if (!reason || reason.trim().length < 3) {
    throw new AdminError('A reason is required — the log is useless without it');
  }

  return db.withTransaction(async (tx) => {
    const [nation] = await db.lockNations(tx, [nationId]);
    const gs = await repo.loadGameState(tx);
    const before = db.num(nation.money);

    await tx.query('UPDATE nations SET money = $2 WHERE id = $1', [nationId, amount]);

    await logAction(tx, admin, {
      action: 'set_money',
      targetType: 'nation', targetId: nationId, targetName: nation.name,
      before: { money: before }, after: { money: amount },
      reason, turn: gs.turn, ipHash: hashIp(req?.ip),
    });

    return { nation: nation.name, before, after: amount };
  });
}

/** Set one resource to an exact amount. */
async function setResource(admin, nationId, resource, amount, reason, req) {
  if (!C.ALL_RESOURCES.includes(resource)) {
    throw new AdminError(`Unknown resource: ${resource}`);
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AdminError('Amount must be a non-negative number');
  }
  if (!reason || reason.trim().length < 3) {
    throw new AdminError('A reason is required');
  }

  return db.withTransaction(async (tx) => {
    const [nation] = await db.lockNations(tx, [nationId]);
    const gs = await repo.loadGameState(tx);

    const { rows } = await tx.query(
      'SELECT amount FROM nation_resources WHERE nation_id=$1 AND resource=$2',
      [nationId, resource]);
    const before = rows.length ? db.num(rows[0].amount) : 0;

    await tx.query(
      `INSERT INTO nation_resources (nation_id, resource, amount) VALUES ($1,$2,$3)
       ON CONFLICT (nation_id, resource) DO UPDATE SET amount = EXCLUDED.amount`,
      [nationId, resource, amount]);

    await logAction(tx, admin, {
      action: 'set_resource',
      targetType: 'nation', targetId: nationId, targetName: nation.name,
      before: { [resource]: before }, after: { [resource]: amount },
      reason, turn: gs.turn, ipHash: hashIp(req?.ip),
    });

    return { nation: nation.name, resource, before, after: amount };
  });
}

/** Lift or extend beige protection. */
async function setBeige(admin, nationId, turns, reason, req) {
  if (!reason || reason.trim().length < 3) throw new AdminError('A reason is required');

  return db.withTransaction(async (tx) => {
    const [nation] = await db.lockNations(tx, [nationId]);
    const gs = await repo.loadGameState(tx);
    const before = nation.beige_until_turn !== null ? Number(nation.beige_until_turn) : null;
    const after = turns > 0 ? gs.turn + turns : null;

    // Leaving beige also means leaving the beige COLOUR — otherwise the nation
    // keeps beige's per-turn bonus and tax exemption forever. This is the same
    // bug the tick engine had.
    await tx.query(
      `UPDATE nations SET beige_until_turn = $2,
              color = CASE WHEN $2 IS NULL AND color = 'beige' THEN 'gray' ELSE color END
       WHERE id = $1`,
      [nationId, after]);

    await logAction(tx, admin, {
      action: turns > 0 ? 'grant_beige' : 'lift_beige',
      targetType: 'nation', targetId: nationId, targetName: nation.name,
      before: { beigeUntilTurn: before }, after: { beigeUntilTurn: after },
      reason, turn: gs.turn, ipHash: hashIp(req?.ip),
    });

    return { nation: nation.name, beigeUntilTurn: after };
  });
}

/** End a war early. */
async function endWar(admin, warId, reason, req) {
  if (!reason || reason.trim().length < 3) throw new AdminError('A reason is required');

  return db.withTransaction(async (tx) => {
    const { rows } = await tx.query(
      'SELECT * FROM wars WHERE id=$1 AND ended_turn IS NULL FOR UPDATE', [warId]);
    if (!rows.length) throw new AdminError('War not found or already ended');
    const war = rows[0];

    const gs = await repo.loadGameState(tx);
    await tx.query('UPDATE wars SET ended_turn = $2 WHERE id = $1', [warId, gs.turn]);

    await logAction(tx, admin, {
      action: 'end_war',
      targetType: 'war', targetId: warId,
      targetName: `${war.attacker_id} vs ${war.defender_id}`,
      before: { ended: false }, after: { ended: true, endedTurn: gs.turn },
      reason, turn: gs.turn, ipHash: hashIp(req?.ip),
    });

    return { warId, endedTurn: gs.turn };
  });
}

/**
 * Ban or unban a player.
 *
 * Refuses to ban an admin. Not a security boundary — an attacker who is
 * already admin can do worse — but it stops a tired administrator locking
 * themselves out with one click.
 */
async function setBanned(admin, userId, banned, reason, req) {
  if (!reason || reason.trim().length < 3) throw new AdminError('A reason is required');

  return db.withTransaction(async (tx) => {
    const { rows } = await tx.query(
      'SELECT id, email, is_banned, is_admin FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (!rows.length) throw new AdminError('User not found');
    const user = rows[0];

    if (user.is_admin && banned) {
      throw new AdminError('Refusing to ban an admin account. Remove the admin flag in SQL first.');
    }

    const gs = await repo.loadGameState(tx);
    await tx.query('UPDATE users SET is_banned = $2 WHERE id = $1', [userId, banned]);

    await logAction(tx, admin, {
      action: banned ? 'ban_user' : 'unban_user',
      targetType: 'user', targetId: userId, targetName: user.email,
      before: { banned: user.is_banned }, after: { banned },
      reason, turn: gs.turn, ipHash: hashIp(req?.ip),
    });

    return { email: user.email, banned };
  });
}

/**
 * Give a nation a package of starting materials.
 *
 * The one convenience function, because refunding a failed build means setting
 * three resources and nobody wants to do that three times through the log.
 * Still absolute, still logged as one entry.
 */
async function grantPackage(admin, nationId, pkg, reason, req) {
  if (!reason || reason.trim().length < 3) throw new AdminError('A reason is required');

  const entries = Object.entries(pkg || {});
  if (!entries.length) throw new AdminError('Nothing to grant');
  for (const [resource, amount] of entries) {
    if (resource !== 'money' && !C.ALL_RESOURCES.includes(resource)) {
      throw new AdminError(`Unknown resource: ${resource}`);
    }
    if (!Number.isFinite(amount) || amount < 0) {
      throw new AdminError(`Bad amount for ${resource}`);
    }
  }

  return db.withTransaction(async (tx) => {
    const [nation] = await db.lockNations(tx, [nationId]);
    const gs = await repo.loadGameState(tx);

    const before = {};
    const after = {};

    for (const [resource, amount] of entries) {
      if (resource === 'money') {
        before.money = db.num(nation.money);
        after.money = round2(before.money + amount);
        await tx.query('UPDATE nations SET money = money + $2 WHERE id = $1', [nationId, amount]);
      } else {
        const { rows } = await tx.query(
          'SELECT amount FROM nation_resources WHERE nation_id=$1 AND resource=$2',
          [nationId, resource]);
        before[resource] = rows.length ? db.num(rows[0].amount) : 0;
        after[resource] = round2(before[resource] + amount);
        await tx.query(
          `INSERT INTO nation_resources (nation_id, resource, amount) VALUES ($1,$2,$3)
           ON CONFLICT (nation_id, resource)
           DO UPDATE SET amount = nation_resources.amount + EXCLUDED.amount`,
          [nationId, resource, amount]);
      }
    }

    await logAction(tx, admin, {
      action: 'grant_package',
      targetType: 'nation', targetId: nationId, targetName: nation.name,
      before, after, reason, turn: gs.turn, ipHash: hashIp(req?.ip),
    });

    return { nation: nation.name, granted: pkg };
  });
}

module.exports = {
  AdminError,
  listNations,
  inspectNation,
  suspectedLinks,
  flaggedTrades,
  auditLog,
  setMoney,
  setResource,
  setBeige,
  endWar,
  setBanned,
  grantPackage,
};
