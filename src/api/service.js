/**
 * ============================================================================
 *  service.js — Transactional game actions
 * ============================================================================
 *
 *  The layer between HTTP and the engine. Every function here follows the same
 *  shape, and that shape is the whole point:
 *
 *      1. BEGIN
 *      2. lock the nation row
 *      3. load state
 *      4. ask the ENGINE whether the action is legal   <- pure, in-memory
 *      5. apply the described changes
 *      6. COMMIT
 *
 *  Step 4 never touches the database and step 5 never makes a decision. If you
 *  find a game rule being decided in this file, it belongs in the engine; if
 *  you find a query inside the engine, it belongs here.
 *
 *  Validation happens INSIDE the lock, not before it. Checking affordability
 *  outside the transaction and spending inside it is exactly the read-modify-
 *  write race that lets two requests spend the same money twice.
 * ============================================================================
 */

'use strict';

const db = require('../data/db');
const repo = require('../data/repository');
const tick = require('../engine/tick');
const city = require('../engine/city');
const military = require('../engine/military');
const combat = require('../engine/combat');
const modifiers = require('../engine/modifiers');
const population = require('../engine/population');
const economy = require('../engine/economy');
const C = require('../engine/constants');

/** Money must never be handed back with sub-cent precision. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Thrown for player-facing rule violations — becomes a 400, not a 500. */
class GameError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GameError';
    this.isPlayerError = true;
    this.details = details;
  }
}

/** Load the nation and current turn together, with the nation row locked. */
async function loadLocked(tx, nationId) {
  const gs = await repo.loadGameState(tx);
  const nation = await repo.loadNation(tx, nationId, { lock: true, currentTurn: gs.turn });
  if (!nation) throw new GameError('Nation not found');
  return { nation, gameState: gs, state: { turn: gs.turn, nation, world: gs.world } };
}

// ============================================================================
// READ
// ============================================================================

/**
 * Everything a dashboard needs, computed fresh. No lock — this is a read.
 *
 * The UI and the tick engine call the SAME snapshot function, so what a player
 * sees is exactly what the engine will act on. They cannot disagree.
 */
async function getSnapshot(nationId) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    if (!nation) throw new GameError('Nation not found');

    const snap = tick.snapshot(nation, gs.turn, { radiation: gs.world.radiation });

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
        policies: nation.policies,
        allianceId: nation.allianceId,
        stockpile: nation.stockpile,
        units: nation.units,
        projects: nation.projects,
      },
      ...snap,
    };
  });
}

async function getEvents(nationId, limit = 50) {
  const { rows } = await db.query(
    `SELECT id, turn, type, payload, is_read, created_at
       FROM events WHERE nation_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [nationId, Math.min(limit, 200)]
  );
  return rows;
}

// ============================================================================
// CITY ACTIONS
// ============================================================================

async function buyInfrastructure(nationId, cityId, targetInfra) {
  return db.withTransaction(async (tx) => {
    const { nation, state } = await loadLocked(tx, nationId);

    const index = nation.cities.findIndex(c => c.id === Number(cityId));
    if (index === -1) throw new GameError('City not found');

    const result = tick.actions.buyInfrastructure(state, { cityIndex: index, targetInfra });
    if (!result.ok) throw new GameError(result.reason);

    const target = nation.cities[index];
    target.infrastructure = targetInfra;
    nation.money -= result.cost;

    await repo.saveCity(tx, target);
    await repo.saveNation(tx, nation);

    return {
      cost: result.cost,
      efficient: result.efficient,
      infrastructure: targetInfra,
      moneyRemaining: nation.money,
      // Not an error — the player is allowed to waste money. Just tell them.
      warning: result.efficient ? null
        : `Bracket-misaligned purchase. Buying to a multiple of ${C.CITY.INFRA_PURCHASE_BRACKET} is cheaper per unit.`,
    };
  });
}

async function buyLand(nationId, cityId, targetLand) {
  return db.withTransaction(async (tx) => {
    const { nation, state } = await loadLocked(tx, nationId);

    const index = nation.cities.findIndex(c => c.id === Number(cityId));
    if (index === -1) throw new GameError('City not found');

    const result = tick.actions.buyLand(state, { cityIndex: index, targetLand });
    if (!result.ok) throw new GameError(result.reason);

    const target = nation.cities[index];
    target.land = targetLand;
    nation.money -= result.cost;

    await repo.saveCity(tx, target);
    await repo.saveNation(tx, nation);

    return { cost: result.cost, efficient: result.efficient, land: targetLand, moneyRemaining: nation.money };
  });
}

async function foundCity(nationId, name, continent) {
  return db.withTransaction(async (tx) => {
    const { nation, state } = await loadLocked(tx, nationId);

    if (nation.cities.some(c => c.name === name)) {
      throw new GameError('You already have a city with that name');
    }

    const result = tick.actions.foundCity(state, { name, continent });
    if (!result.ok) throw new GameError(result.reason, { turnsRemaining: result.turnsRemaining });

    const newCity = result.changes.newCity;
    const cityId = await repo.createCity(tx, nationId, newCity);

    nation.money -= result.cost;
    nation.lastCityTurn = state.turn;
    await repo.saveNation(tx, nation);

    return { cityId, cost: result.cost, cityCount: nation.cities.length + 1, moneyRemaining: nation.money };
  });
}

/**
 * Build or demolish improvements.
 *
 * Slot capacity and per-city limits are checked by the engine, not here — this
 * function only knows how to pay for the answer it is given.
 */
async function buildImprovements(nationId, cityId, improvementKey, count) {
  return db.withTransaction(async (tx) => {
    const { nation } = await loadLocked(tx, nationId);

    const target = nation.cities.find(c => c.id === Number(cityId));
    if (!target) throw new GameError('City not found');

    const def = C.IMPROVEMENTS[improvementKey];
    if (!def) throw new GameError(`Unknown improvement: ${improvementKey}`);

    if (count > 0) {
      const check = city.canBuildImprovement(target, improvementKey, count);
      if (!check.ok) throw new GameError(check.reason);

      const cost = def.cost * count;
      if (nation.money < cost) {
        throw new GameError(`Costs $${cost.toLocaleString()}, you have $${nation.money.toLocaleString()}`);
      }

      nation.money -= cost;
      target.improvements[improvementKey] = (target.improvements[improvementKey] || 0) + count;
      await repo.saveCity(tx, target);
      await repo.saveNation(tx, nation);
      return { built: count, cost, total: target.improvements[improvementKey], moneyRemaining: nation.money };
    }

    // Demolition. No refund — otherwise build/demolish cycling launders value.
    const demolish = Math.abs(count);
    const current = target.improvements[improvementKey] || 0;
    if (current < demolish) throw new GameError(`Only ${current} ${improvementKey} to demolish`);

    target.improvements[improvementKey] = current - demolish;
    await repo.saveCity(tx, target);
    return { demolished: demolish, total: target.improvements[improvementKey], refund: 0 };
  });
}

// ============================================================================
// MILITARY ACTIONS
// ============================================================================

async function recruit(nationId, unitKey, count) {
  return db.withTransaction(async (tx) => {
    const { nation, state, gameState } = await loadLocked(tx, nationId);

    const check = tick.actions.recruit(state, { unitKey, count });
    if (!check.ok) throw new GameError(check.reason, { maxPossible: check.maxPossible });

    // Deduct cost across money and resources.
    const cost = check.cost;
    for (const [res, amount] of Object.entries(cost)) {
      if (res === 'money') {
        if (nation.money < amount) throw new GameError('Insufficient funds');
        nation.money -= amount;
      } else {
        if ((nation.stockpile[res] || 0) < amount) {
          throw new GameError(`Insufficient ${res}: need ${amount}, have ${nation.stockpile[res] || 0}`);
        }
        nation.stockpile[res] -= amount;
      }
    }

    nation.units[unitKey] = (nation.units[unitKey] || 0) + count;

    const gameDay = Math.floor(gameState.turn / C.TICK.TURNS_PER_DAY);
    await repo.logRecruitment(tx, nationId, gameDay, unitKey, count);
    await repo.saveNation(tx, nation);

    return { recruited: count, unitKey, cost, total: nation.units[unitKey] };
  });
}

async function buildProject(nationId, projectKey) {
  return db.withTransaction(async (tx) => {
    const { nation, gameState } = await loadLocked(tx, nationId);

    const stockpile = { ...nation.stockpile, money: nation.money };
    const check = modifiers.canBuildProject(nation, projectKey, stockpile);
    if (!check.ok) throw new GameError(check.reason, check.missing ? { missing: check.missing } : {});

    for (const [res, amount] of Object.entries(check.cost)) {
      if (res === 'money') nation.money -= amount;
      else nation.stockpile[res] -= amount;
    }

    await tx.query(
      'INSERT INTO nation_projects (nation_id, project_key, built_turn) VALUES ($1,$2,$3)',
      [nationId, projectKey, gameState.turn]
    );
    await repo.saveNation(tx, nation);

    return { project: projectKey, cost: check.cost, scoreAdded: C.PROJECT_SCORE_VALUE };
  });
}

async function setPolicy(nationId, type, policyKey) {
  return db.withTransaction(async (tx) => {
    const { nation, gameState } = await loadLocked(tx, nationId);

    const table = type === 'war' ? C.WAR_POLICIES : C.DOMESTIC_POLICIES;
    if (policyKey && !table[policyKey]) throw new GameError(`Unknown ${type} policy: ${policyKey}`);

    const lastChanged = type === 'war' ? nation.warPolicyTurn : nation.domesticPolicyTurn;
    const check = modifiers.canChangePolicy(type, lastChanged, gameState.turn);
    if (!check.ok) throw new GameError(check.reason, { turnsRemaining: check.turnsRemaining });

    const column = type === 'war' ? 'war_policy' : 'domestic_policy';
    const turnColumn = type === 'war' ? 'war_policy_turn' : 'domestic_policy_turn';
    await tx.query(
      `UPDATE nations SET ${column} = $2, ${turnColumn} = $3 WHERE id = $1`,
      [nationId, policyKey, gameState.turn]
    );

    return { type, policy: policyKey, effects: table[policyKey] || {} };
  });
}

// ============================================================================
// WAR
// ============================================================================

async function declareWar(nationId, targetNationId, warType) {
  if (Number(nationId) === Number(targetNationId)) {
    throw new GameError('You cannot declare war on yourself');
  }

  return db.withTransaction(async (tx) => {
    // Ordered locking — both nations, sorted, so concurrent declarations
    // between the same pair queue instead of deadlocking.
    await db.lockNations(tx, [nationId, targetNationId]);

    const gs = await repo.loadGameState(tx);
    const attacker = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    const defender = await repo.loadNation(tx, targetNationId, { currentTurn: gs.turn });
    if (!defender) throw new GameError('Target nation not found');

    const { rows: slots } = await tx.query(
      `SELECT
         (SELECT count(*) FROM wars WHERE attacker_id=$1 AND ended_turn IS NULL) AS offensive,
         (SELECT count(*) FROM wars WHERE defender_id=$2 AND ended_turn IS NULL) AS target_defensive,
         (SELECT count(*) FROM wars WHERE ((attacker_id=$1 AND defender_id=$2)
                                        OR (attacker_id=$2 AND defender_id=$1))
                                    AND ended_turn IS NULL) AS existing`,
      [nationId, targetNationId]
    );
    if (Number(slots[0].existing) > 0) throw new GameError('You are already at war with this nation');

    const check = military.canDeclareWar(attacker, defender, {
      warType,
      currentOffensiveWars: Number(slots[0].offensive),
      targetDefensiveWars: Number(slots[0].target_defensive),
      targetOnBeige: modifiers.resolveColorState(defender, gs.turn).color === 'beige',
    });
    if (!check.ok) throw new GameError(check.reason);

    // Multi-accounting guard. Row locks defend against MECHANICAL duping;
    // nothing in the engine stops a player farming their own alt.
    //
    // Checked LAST so players see the actionable game reason first (out of
    // range, target on beige) rather than a linkage message that suggests
    // a different problem.
    //
    // ⚠️ KNOWN FALSE POSITIVE: this also blocks two legitimate players behind
    // the same NAT — a household, a campus, an office. P&W handles this with a
    // manual appeals process. Until there is one, ALLOW_LINKED_WARS=true is an
    // escape hatch for local testing and shared connections.
    if (process.env.ALLOW_LINKED_WARS !== 'true'
        && await repo.areNationsLinked(tx, nationId, targetNationId)) {
      throw new GameError(
        'You cannot declare war on a linked account. If you share an internet ' +
        'connection with another player, contact an administrator.'
      );
    }

    const { rows } = await tx.query(
      `INSERT INTO wars (attacker_id, defender_id, war_type, started_turn)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [nationId, targetNationId, warType || 'ordinary', gs.turn]
    );

    await repo.recordEvents(tx, targetNationId, [{
      turn: gs.turn, type: 'war_declared',
      message: `${attacker.name} has declared ${warType || 'ordinary'} war on you.`,
      attackerId: nationId,
    }]);

    return { warId: Number(rows[0].id), warType: warType || 'ordinary', target: defender.name };
  });
}

/**
 * Execute an attack.
 *
 * The rng seed is generated here and STORED with the battle. Any disputed
 * result can then be replayed byte-for-byte through combat.js — without it,
 * "the game cheated me" is unanswerable.
 */
async function attack(nationId, warId, attackType, opts = {}) {
  return db.withTransaction(async (tx) => {
    const { rows: warRows } = await tx.query(
      'SELECT * FROM wars WHERE id = $1 AND ended_turn IS NULL', [warId]
    );
    if (warRows.length === 0) throw new GameError('War not found or already ended');
    const war = warRows[0];

    const isAttacker = Number(war.attacker_id) === Number(nationId);
    const isDefender = Number(war.defender_id) === Number(nationId);
    if (!isAttacker && !isDefender) throw new GameError('You are not a participant in this war');

    const opponentId = isAttacker ? Number(war.defender_id) : Number(war.attacker_id);

    await db.lockNations(tx, [nationId, opponentId]);

    const gs = await repo.loadGameState(tx);
    const me = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    const them = await repo.loadNation(tx, opponentId, { currentTurn: gs.turn });

    const themPop = tick.snapshot(them, gs.turn, { radiation: gs.world.radiation }).totalPopulation;

    const seed = Math.floor(Math.random() * 2147483647);

    const params = {
      attacker: {
        units: me.units, stockpile: me.stockpile,
        policy: me.policies.war,
        controlState: isAttacker ? war.attacker_control_state : war.defender_control_state,
      },
      defender: {
        units: them.units, stockpile: them.stockpile,
        policy: them.policies.war,
        controlState: isAttacker ? war.defender_control_state : war.attacker_control_state,
        cities: them.cities, money: them.money, population: themPop,
        fortified: isAttacker ? war.defender_fortified : war.attacker_fortified,
      },
      opts: {
        warType: war.war_type,
        currentMap: me.map,
        rng: combat.makeRng(seed),
        target: opts.target,
      },
    };

    let result;
    switch (attackType) {
      case 'ground_battle': result = combat.groundBattle(params); break;
      case 'airstrike': result = combat.airStrike(params); break;
      case 'naval_battle': result = combat.navalBattle(params); break;
      default: throw new GameError(`Unknown attack type: ${attackType}`);
    }
    if (!result.ok) throw new GameError(result.reason);

    // ---- Apply. The engine decided; this only writes. ----
    me.map -= result.mapCost;

    for (const [res, amount] of Object.entries(result.consumption?.attacker || {})) {
      me.stockpile[res] = Math.max((me.stockpile[res] || 0) - amount, 0);
    }
    for (const [unit, lost] of Object.entries(result.attackerCasualties || {})) {
      me.units[unit] = Math.max((me.units[unit] || 0) - lost, 0);
    }
    for (const [unit, lost] of Object.entries(result.defenderCasualties || {})) {
      them.units[unit] = Math.max((them.units[unit] || 0) - lost, 0);
    }
    for (const [unit, lost] of Object.entries(result.unitsDestroyed || {})) {
      them.units[unit] = Math.max((them.units[unit] || 0) - lost, 0);
    }

    if (result.loot > 0) {
      const looted = Math.min(result.loot, them.money);
      them.money -= looted;
      me.money += looted;
      result.loot = looted;
    }

    let targetCity = null;
    if (result.infraDestroyed > 0 && result.targetCity) {
      targetCity = them.cities.find(c => c.name === result.targetCity);
      if (targetCity) {
        targetCity.infrastructure = Math.max(targetCity.infrastructure - result.infraDestroyed, 0);
        if (result.improvementDestroyed && targetCity.improvements[result.improvementDestroyed] > 0) {
          targetCity.improvements[result.improvementDestroyed] -= 1;
        }
        await repo.saveCity(tx, targetCity);
      }
    }

    // ---- Resistance and control state ----
    const resistColumn = isAttacker ? 'defender_resistance' : 'attacker_resistance';
    const currentResist = Number(isAttacker ? war.defender_resistance : war.attacker_resistance);
    const applied = combat.applyResistance(currentResist, result.resistanceLoss);

    const myControlCol = isAttacker ? 'attacker_control_state' : 'defender_control_state';
    const theirControlCol = isAttacker ? 'defender_control_state' : 'attacker_control_state';

    const updates = [`${resistColumn} = $2`];
    const values = [warId, applied.resistance];
    if (result.control.gained) { updates.push(`${myControlCol} = $${values.length + 1}`); values.push(result.control.gained); }
    if (result.control.nullified) { updates.push(`${theirControlCol} = NULL`); }
    // Fortification ends the moment you attack.
    updates.push(`${isAttacker ? 'attacker_fortified' : 'defender_fortified'} = FALSE`);

    await tx.query(`UPDATE wars SET ${updates.join(', ')} WHERE id = $1`, values);

    // ---- Record the battle, seed included ----
    await tx.query(
      `INSERT INTO battles
        (war_id, attacker_id, attack_type, victory_type, rng_seed,
         attacker_value, defender_value, infra_destroyed, loot, resistance_loss,
         target_city_id, attacker_casualties, defender_casualties, turn)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [warId, nationId, attackType, result.victoryType, seed,
       result.attackerValue, result.defenderValue, result.infraDestroyed, result.loot,
       result.resistanceLoss, targetCity?.id || null,
       JSON.stringify(result.attackerCasualties), JSON.stringify(result.defenderCasualties), gs.turn]
    );

    // ---- Victory ----
    let defeat = null;
    if (applied.defeated) {
      defeat = combat.applyDefeat(
        { money: them.money, stockpile: them.stockpile, cities: them.cities },
        { warType: war.war_type }
      );

      them.money = Math.max(them.money - defeat.moneyLost, 0);
      for (const [res, amount] of Object.entries(defeat.resourcesLost)) {
        them.stockpile[res] = Math.max((them.stockpile[res] || 0) - amount, 0);
      }
      for (const loss of defeat.infraLost) {
        const c = them.cities.find(x => x.name === loss.name);
        if (c) { c.infrastructure = Math.max(c.infrastructure - loss.lost, 0); await repo.saveCity(tx, c); }
      }

      const { rows: lossCount } = await tx.query(
        'SELECT count(*) AS n FROM wars WHERE (attacker_id=$1 OR defender_id=$1) AND winner_id IS NOT NULL AND winner_id <> $1',
        [opponentId]
      );
      them.beigeUntilTurn = modifiers.beigeUntilTurn(gs.turn, Number(lossCount[0].n) + 1);

      await tx.query('UPDATE wars SET ended_turn = $2, winner_id = $3 WHERE id = $1',
        [warId, gs.turn, nationId]);

      await repo.recordEvents(tx, opponentId, [{
        turn: gs.turn, type: 'war_lost',
        message: `You have been defeated by ${me.name}. Beige protection for ${defeat.beigeDays} days.`,
        losses: defeat,
      }]);
    }

    await repo.saveNation(tx, me);
    await repo.saveNation(tx, them);

    await repo.recordEvents(tx, opponentId, [{
      turn: gs.turn, type: 'attacked',
      message: `${me.name} attacked: ${result.victoryName}`,
      attackType, victoryType: result.victoryType, infraLost: result.infraDestroyed,
    }]);

    return {
      ...result,
      seed,
      resistanceRemaining: applied.resistance,
      warEnded: applied.defeated,
      defeat,
    };
  });
}

/**
 * What would this purchase cost, and what would it DO?
 *
 * The cost curves and the disease formula live in the engine. The frontend
 * must never reimplement them — a second copy drifts, and then the price the
 * player is shown is not the price they are charged.
 *
 * So the UI asks the server, and the server answers using the same functions
 * the tick engine uses. One source of truth, no drift possible.
 */
async function previewCityChange(nationId, cityId, changes = {}) {
  return db.withTransaction(async (tx) => {
    const { nation, state } = await loadLocked(tx, nationId);

    const target = nation.cities.find(c => c.id === Number(cityId));
    if (!target) throw new GameError('City not found');

    const infra = changes.infrastructure !== undefined
      ? Number(changes.infrastructure) : target.infrastructure;
    const land = changes.land !== undefined
      ? Number(changes.land) : target.land;

    if (!Number.isFinite(infra) || infra < 0) throw new GameError('Invalid infrastructure target');
    if (!Number.isFinite(land) || land < 0) throw new GameError('Invalid land target');

    const opts = { projects: nation.projects, policies: nation.policies };

    const infraCost = city.infraPurchaseCost(target.infrastructure, infra, opts);
    const landCost = city.landPurchaseCost(target.land, land, opts);
    const totalCost = round2(infraCost + landCost);

    // Model the city AFTER the change, using the real engine.
    const after = { ...target, infrastructure: infra, land };
    const ageDays = tick.cityAgeDays(target, state.turn);
    const pollution = economy.pollutionIndex(after, opts);

    const before = population.populationBreakdown(target, {
      cityAgeDays: ageDays, pollution: economy.pollutionIndex(target, opts), projects: nation.projects,
    });
    const projected = population.populationBreakdown(after, {
      cityAgeDays: ageDays, pollution, projects: nation.projects,
    });

    return {
      infraCost, landCost, totalCost,
      affordable: nation.money >= totalCost,
      shortfall: Math.max(round2(totalCost - nation.money), 0),
      infraEfficient: city.isInfraPurchaseEfficient(target.infrastructure, infra),
      landEfficient: city.isLandPurchaseEfficient(target.land, land),
      slotsAfter: city.improvementSlots(infra),
      slotsUsed: city.usedImprovementSlots(target.improvements),
      poweredAfter: economy.isPowered(after),
      before: {
        population: before.population,
        diseaseRatePercent: before.diseaseRatePercent,
        density: before.density,
      },
      after: {
        population: projected.population,
        diseaseRatePercent: projected.diseaseRatePercent,
        density: projected.density,
      },
      populationChange: projected.population - before.population,
      // If land alone cannot fix the disease, say what would.
      landForZeroDisease: population.landNeededForDisease(after, 0, { pollution }),
      diseaseFloor: population.minimumAchievableDiseasePercent(after, { pollution }),
    };
  });
}

/**
 * Who can this nation legally declare on right now?
 *
 * Score range is the anti-griefing backbone, but P&W makes players compute it
 * themselves and then hunt the rankings by hand. Doing it server-side means
 * the list is always correct and always matches what canDeclareWar() will
 * accept — no "why can't I attack this one" confusion.
 */
async function findTargets(nationId, limit = 40) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const me = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    if (!me) throw new GameError('Nation not found');

    const myScore = military.nationScore(me);
    const range = military.warRange(myScore);

    const { rows } = await tx.query(
      `SELECT n.id, n.name, n.color, n.alliance_id, n.beige_until_turn,
              COUNT(DISTINCT c.id) AS city_count,
              COALESCE(SUM(c.infrastructure),0) AS total_infra,
              (SELECT COUNT(*) FROM nation_projects p WHERE p.nation_id = n.id) AS projects,
              (SELECT COUNT(*) FROM wars w WHERE w.defender_id = n.id AND w.ended_turn IS NULL) AS defensive_wars
         FROM nations n
         LEFT JOIN cities c ON c.nation_id = n.id
        WHERE n.is_deleted = FALSE AND n.id <> $1
        GROUP BY n.id`,
      [nationId]
    );

    const targets = [];
    for (const r of rows) {
      const units = await tx.query(
        'SELECT unit_key, count FROM nation_units WHERE nation_id = $1', [r.id]);

      const score = military.nationScore({
        cities: Array(Math.max(Number(r.city_count), 1)).fill(null).map((_, i) => ({
          infrastructure: i === 0 ? db.num(r.total_infra) : 0,
        })),
        projects: Array(Number(r.projects)).fill('x'),
        units: db.toMap(units.rows, 'unit_key', 'count'),
      });

      if (score < range.min || score > range.max) continue;

      const onBeige = r.beige_until_turn !== null && gs.turn < Number(r.beige_until_turn);

      targets.push({
        id: Number(r.id),
        name: r.name,
        color: r.color,
        allianceId: r.alliance_id ? Number(r.alliance_id) : null,
        score: round2(score),
        cities: Number(r.city_count),
        infrastructure: db.num(r.total_infra),
        defensiveWars: Number(r.defensive_wars),
        onBeige,
        // Say WHY a listed nation cannot be hit, instead of hiding it and
        // leaving the player to wonder where it went.
        attackable: !onBeige && Number(r.defensive_wars) < C.COMBAT.DEFENSIVE_WAR_SLOTS,
        blockedReason: onBeige ? 'On beige — protected from new declarations'
          : Number(r.defensive_wars) >= C.COMBAT.DEFENSIVE_WAR_SLOTS ? 'Already has 3 defensive wars'
          : null,
      });
    }

    targets.sort((a, b) => b.score - a.score);

    return {
      myScore: round2(myScore),
      range: { min: round2(range.min), max: round2(range.max) },
      targets: targets.slice(0, limit),
    };
  });
}

/**
 * What are my odds, before I spend MAP and munitions?
 *
 * P&W hides this entirely and players resort to external spreadsheets. The
 * odds come from Monte-Carloing the real roll function, so they cannot drift
 * from what the battle will actually do.
 */
async function previewAttack(nationId, warId, attackType) {
  return db.withTransaction(async (tx) => {
    const { rows: warRows } = await tx.query(
      'SELECT * FROM wars WHERE id = $1 AND ended_turn IS NULL', [warId]);
    if (warRows.length === 0) throw new GameError('War not found or already ended');
    const war = warRows[0];

    const isAttacker = Number(war.attacker_id) === Number(nationId);
    if (!isAttacker && Number(war.defender_id) !== Number(nationId)) {
      throw new GameError('You are not a participant in this war');
    }
    const opponentId = isAttacker ? Number(war.defender_id) : Number(war.attacker_id);

    const gs = await repo.loadGameState(tx);
    const me = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    const them = await repo.loadNation(tx, opponentId, { currentTurn: gs.turn });

    const mySupply = military.computeSupply(me.units, me.stockpile);
    const theirSupply = military.computeSupply(them.units, them.stockpile);

    let myValue, theirValue;
    if (attackType === 'airstrike') {
      myValue = military.airforceValue(mySupply);
      theirValue = military.airforceValue(theirSupply);
    } else if (attackType === 'naval_battle') {
      myValue = military.navalValue(mySupply);
      theirValue = military.navalValue(theirSupply);
    } else {
      const theirPop = tick.snapshot(them, gs.turn, {}).totalPopulation;
      myValue = military.armyValue(mySupply, {
        airSuperiorityAgainst: (isAttacker ? war.defender_control_state : war.attacker_control_state) === 'air_superiority',
      });
      theirValue = military.armyValue(theirSupply, { defenderPopulation: theirPop });
    }

    const odds = combat.battleOdds(myValue, theirValue, 4000);
    const mapCheck = military.canPerformAction(me.map, attackType);

    return {
      attackType,
      myValue: round2(myValue),
      theirValue: round2(theirValue),
      ratio: theirValue > 0 ? round2(myValue / theirValue) : null,
      odds,
      map: { have: me.map, cost: mapCheck.cost, ok: mapCheck.ok },
      // The rule that decides most battles before they start.
      supply: {
        fullySupplied: mySupply.fullySupplied,
        shortfalls: mySupply.shortfalls,
        consumption: mySupply.consumption,
      },
      resistanceRemaining: db.num(isAttacker ? war.defender_resistance : war.attacker_resistance),
      resistancePerWin: C.COMBAT.RESISTANCE_LOSS[attackType],
    };
  });
}

module.exports = {
  GameError,
  getSnapshot,
  getEvents,
  findTargets,
  previewAttack,
  previewCityChange,
  buyInfrastructure,
  buyLand,
  foundCity,
  buildImprovements,
  recruit,
  buildProject,
  setPolicy,
  declareWar,
  attack,
};
