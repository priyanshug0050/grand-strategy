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
const policy = require('../engine/policy');
const population = require('../engine/population');
const economy = require('../engine/economy');
const C = require('../engine/constants');

/** Money must never be handed back with sub-cent precision. */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Resource quantities carry 4 decimals — production rates are fractional. */
function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
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
      // Slots, per-city limit AND materials are all checked here, inside the
      // lock. Checking affordability outside the transaction and spending
      // inside it is the read-modify-write race that lets two requests buy
      // with the same steel.
      const check = city.canBuildImprovement(target, improvementKey, count, {
        stockpile: nation.stockpile,
      });
      if (!check.ok) throw new GameError(check.reason, check.missing ? { missing: check.missing } : {});

      const cost = check.cost;
      if (nation.money < cost.money) {
        throw new GameError(`Costs $${cost.money.toLocaleString()}, you have $${nation.money.toLocaleString()}`);
      }

      nation.money -= cost.money;
      for (const [resource, amount] of Object.entries(cost.materials)) {
        nation.stockpile[resource] = Math.max((nation.stockpile[resource] || 0) - amount, 0);
      }

      target.improvements[improvementKey] = (target.improvements[improvementKey] || 0) + count;
      await repo.saveCity(tx, target);
      await repo.saveNation(tx, nation);

      return {
        built: count,
        cost: cost.money,          // kept for older callers
        materials: cost.materials,
        total: target.improvements[improvementKey],
        moneyRemaining: nation.money,
        stockpile: nation.stockpile,
      };
    }

    // Demolition returns HALF the materials and no money.
    //
    // No money refund, because build/demolish cycling would otherwise launder
    // value. But a full material loss makes a misclick catastrophic now that
    // buildings cost 300 steel, so half comes back as salvage — enough to
    // soften a mistake, not enough to make churning profitable.
    const demolish = Math.abs(count);
    const current = target.improvements[improvementKey] || 0;
    if (current < demolish) throw new GameError(`Only ${current} ${improvementKey} to demolish`);

    const fullCost = city.improvementCost(improvementKey, demolish);
    const salvage = {};
    for (const [resource, amount] of Object.entries(fullCost.materials)) {
      const returned = round2(amount * C.CITY.DEMOLITION_SALVAGE_RATE);
      if (returned > 0) {
        salvage[resource] = returned;
        nation.stockpile[resource] = round2((nation.stockpile[resource] || 0) + returned);
      }
    }

    target.improvements[improvementKey] = current - demolish;
    await repo.saveCity(tx, target);
    if (Object.keys(salvage).length) await repo.saveNation(tx, nation);

    return {
      demolished: demolish,
      total: target.improvements[improvementKey],
      refund: 0,
      salvage,
    };
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

/**
 * The whole policy catalogue, plus what this nation is running and when each
 * slot unlocks again.
 *
 * One call gives the page everything: every option, its gain, its cost, and
 * the cooldown state. The frontend never hardcodes a policy name or effect —
 * add a policy to the engine and it appears here automatically.
 */
async function getPolicies(nationId) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    if (!nation) throw new GameError('Nation not found');

    const projects = nation.projects || [];
    const amplification = modifiers.aggregateProjectEffects(projects).domesticPolicyBonus || 0;

    const active = {
      economic: nation.policies.economic,
      social: nation.policies.social,
      military: nation.policies.military,
    };

    const resolved = policy.policyEffects(active, { amplification });

    const slots = {};
    for (const slot of policy.SLOTS) {
      const lastChanged = nation.policyTurns?.[slot] ?? null;
      const cooldown = policy.canChangePolicy(slot, lastChanged, gs.turn);
      slots[slot] = {
        ...policy.SLOT_INFO[slot],
        active: active[slot],
        canChange: cooldown.ok,
        reason: cooldown.reason || null,
        turnsRemaining: cooldown.turnsRemaining || 0,
        daysRemaining: cooldown.daysRemaining || 0,
      };
    }

    return {
      turn: gs.turn,
      slots,
      catalogue: policy.catalogue(),
      active,
      effects: resolved.effects,
      // Amplification comes from projects like Government Support Agency and
      // strengthens the GAIN of whatever you are running, never the cost.
      amplification,
      // Only the levers that are actually doing something — a list of 23
      // untouched multipliers tells the player nothing.
      activeEffects: Object.entries(resolved.effects)
        .map(([key, value]) => {
          const def = policy.EFFECT_KEYS[key];
          const neutral = def.unit === 'multiplier' ? 1 : 0;
          if (Math.abs(value - neutral) < 1e-9) return null;
          return policy.describeEffect(key, value);
        })
        .filter(Boolean),
    };
  });
}

/**
 * Preview a swap before committing to it.
 *
 * Changing a policy moves several unrelated numbers at once and then locks for
 * days. Showing the full diff first is the same principle as the city purchase
 * preview and the battle odds — consequence before commitment.
 */
async function previewPolicy(nationId, slot, policyKey) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    if (!nation) throw new GameError('Nation not found');

    if (!policy.SLOTS.includes(slot)) throw new GameError(`Unknown policy slot: ${slot}`);
    if (policyKey && !policy.isValidPolicy(policyKey, slot)) {
      throw new GameError(`${policyKey} is not a ${slot} policy`);
    }

    const projects = nation.projects || [];
    const amplification = modifiers.aggregateProjectEffects(projects).domesticPolicyBonus || 0;

    const current = {
      economic: nation.policies.economic,
      social: nation.policies.social,
      military: nation.policies.military,
    };
    const proposed = { ...current, [slot]: policyKey || null };

    const cooldown = policy.canChangePolicy(slot, nation.policyTurns?.[slot] ?? null, gs.turn);
    const days = slot === 'military' ? C.POLICY_COOLDOWN.WAR_DAYS : C.POLICY_COOLDOWN.DOMESTIC_DAYS;

    return {
      slot,
      from: current[slot],
      to: policyKey || null,
      canChange: cooldown.ok,
      reason: cooldown.reason || null,
      daysRemaining: cooldown.daysRemaining || 0,
      changes: policy.comparePolicies(current, proposed, { amplification }),
      // Worth stating plainly: this decision is locked in for days.
      lockDays: days,
    };
  });
}

async function setPolicy(nationId, slot, policyKey) {
  return db.withTransaction(async (tx) => {
    const { nation, gameState } = await loadLocked(tx, nationId);

    if (!policy.SLOTS.includes(slot)) throw new GameError(`Unknown policy slot: ${slot}`);
    if (policyKey && !policy.isValidPolicy(policyKey, slot)) {
      throw new GameError(`${policyKey} is not a ${slot} policy`);
    }

    const lastChanged = nation.policyTurns?.[slot] ?? null;
    const check = policy.canChangePolicy(slot, lastChanged, gameState.turn);
    if (!check.ok) {
      throw new GameError(check.reason, {
        turnsRemaining: check.turnsRemaining,
        daysRemaining: check.daysRemaining,
      });
    }

    // Column names are built from a validated slot, never from raw input —
    // `slot` has already been checked against the SLOTS whitelist above.
    const column = `${slot}_policy`;
    const turnColumn = `${slot}_policy_turn`;
    await tx.query(
      `UPDATE nations SET ${column} = $2, ${turnColumn} = $3 WHERE id = $1`,
      [nationId, policyKey || null, gameState.turn]
    );

    const projects = nation.projects || [];
    const amplification = modifiers.aggregateProjectEffects(projects).domesticPolicyBonus || 0;
    const active = {
      economic: nation.policies.economic,
      social: nation.policies.social,
      military: nation.policies.military,
      [slot]: policyKey || null,
    };

    return {
      slot,
      policy: policyKey,
      description: policyKey ? policy.describePolicy(policyKey) : null,
      effects: policy.policyEffects(active, { amplification }).effects,
      lockedForDays: slot === 'military' ? C.POLICY_COOLDOWN.WAR_DAYS : C.POLICY_COOLDOWN.DOMESTIC_DAYS,
    };
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
 * What does this building actually DO, in its own terms?
 *
 * Resource producers are only one kind. Expressing a bank as "produces: —"
 * is technically true and completely useless; it produces commerce, which is
 * what raises income per citizen.
 */
function describeEffect(key, def) {
  const e = { kind: def.category, parts: [] };

  if (def.infraCapacity) {
    e.parts.push({ label: 'powers', value: `${def.infraCapacity.toLocaleString()} infra` });
    e.parts.push({ label: 'fuel', value: def.fuel || 'none' });
  }
  if (def.commerce) e.parts.push({ label: 'commerce', value: `+${def.commerce}` });
  if (def.diseaseReduction) e.parts.push({ label: 'disease', value: `−${def.diseaseReduction}%` });
  if (def.crimeReduction) e.parts.push({ label: 'crime', value: `−${def.crimeReduction}%` });
  if (def.pollutionReduction) e.parts.push({ label: 'pollution', value: `−${def.pollutionReduction}` });
  if (def.capacity) {
    e.parts.push({ label: 'holds', value: `${def.capacity.toLocaleString()} ${def.unit}` });
    e.parts.push({ label: 'trains', value: `${def.perDay.toLocaleString()}/day` });
  }
  if (def.pollution) e.parts.push({ label: 'pollution', value: `+${def.pollution}`, bad: true });

  return e;
}

/**
 * The full economic ledger — every number, traced to its source.
 *
 * P&W's Revenue page tells you the totals and nothing else. When income drops
 * you are left guessing which of forty buildings caused it, and the community
 * answer is "build a spreadsheet". This returns the working instead: which
 * improvement produces what, which consumes what, what each building costs to
 * run, and — the part no summary can show — WHY a factory is idle.
 *
 * Everything here is computed by the same engine functions the tick uses, so
 * the ledger and the game can never disagree.
 */
async function getEconomy(nationId) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    if (!nation) throw new GameError('Nation not found');

    const projects = nation.projects || [];
    const opts = { projects, policies: nation.policies, units: nation.units,
                   atWar: (nation.activeWars || 0) > 0, stockpile: nation.stockpile };

    const snap = tick.snapshot(nation, gs.turn, { radiation: gs.world.radiation });

    // ---- Per-improvement attribution --------------------------------------
    // The heart of the page. Every building that produces, consumes or costs
    // anything gets a line, so a change in the totals is always traceable.
    const byImprovement = {};
    const addLine = (key, field, amount, cityName) => {
      if (!amount) return;
      const line = byImprovement[key] || (byImprovement[key] = {
        key, category: C.IMPROVEMENTS[key]?.category || 'other',
        count: 0, produces: {}, consumes: {}, upkeepPerDay: 0,
        pollution: 0, commerce: 0, cities: [],
      });
      if (field === 'upkeep') line.upkeepPerDay = round2(line.upkeepPerDay + amount);
      else if (field === 'pollution') line.pollution += amount;
      else if (field === 'commerce') line.commerce += amount;
      if (cityName && !line.cities.includes(cityName)) line.cities.push(cityName);
    };

    const perCity = [];

    for (const c of nation.cities) {
      const production = economy.cityProductionPerTurn(c, opts);
      const commerce = economy.commerceRate(c, opts);
      const pollution = economy.pollutionIndex(c, opts);
      // Pass the stockpile so "powered" means FUELLED, not merely wired.
      const powerOpts = { ...opts, stockpile: nation.stockpile };
      const power = economy.powerStatus(c, { ...powerOpts, producedThisTurn: production.gross });
      const powered = power.powered;
      const capacity = economy.powerCapacity(c);
      const snapCity = snap.perCity.find(x => x.id === c.id) || {};

      // Which improvements are IDLE, and why. A player staring at zero steel
      // needs to know it is a power problem, not a market problem.
      const idle = [];
      for (const [key, count] of Object.entries(c.improvements || {})) {
        const def = C.IMPROVEMENTS[key];
        if (!def || !count) continue;
        if (def.power && !powered) {
          idle.push({ key, count,
            reason: power.reason === 'fuel'
              ? `no power — plants out of ${power.resource}`
              : 'no power — not enough plant capacity' });
        }
      }
      for (const [resource, run] of Object.entries(production.manufacturing)) {
        if (run.throttled && run.limitedBy && run.limitedBy !== 'power') {
          const def = C.RECIPES[resource];
          idle.push({ key: def.improvement, count: c.improvements?.[def.improvement] || 0,
                      reason: `out of ${run.limitedBy}`, partial: true });
        }
      }

      for (const [key, count] of Object.entries(c.improvements || {})) {
        const def = C.IMPROVEMENTS[key];
        if (!def || !count) continue;
        const line = byImprovement[key] || (byImprovement[key] = {
          key, category: def.category, count: 0, produces: {}, consumes: {},
          upkeepPerDay: 0, pollution: 0, commerce: 0, cities: [],
          // Not every building produces a RESOURCE. A bank produces commerce,
          // a hospital produces reduced disease, a barracks produces capacity.
          // Sending the same two columns for all of them left most of the
          // table empty and hid what these buildings actually do.
          effect: describeEffect(key, def),
        });
        line.count += count;
        if (!line.cities.includes(c.name)) line.cities.push(c.name);
        if (def.upkeep) line.upkeepPerDay = round2(line.upkeepPerDay + def.upkeep * count);
        if (def.pollution) line.pollution += def.pollution * count;
        if (def.commerce) line.commerce += def.commerce * count;
      }

      // Attribute production to the improvement that made it.
      for (const [key, count] of Object.entries(c.improvements || {})) {
        const def = C.IMPROVEMENTS[key];
        if (!def || !count || def.category !== 'raw') continue;
        const out = economy.rawProductionPerTurn(c, key, opts);
        if (out > 0) {
          const line = byImprovement[key];
          line.produces[def.produces] = round4((line.produces[def.produces] || 0) + out);
        }
      }
      for (const [resource, run] of Object.entries(production.manufacturing)) {
        if (!run.outputs[resource]) continue;
        const key = C.RECIPES[resource].improvement;
        const line = byImprovement[key];
        if (!line) continue;
        line.produces[resource] = round4((line.produces[resource] || 0) + run.outputs[resource]);
        for (const [res, amt] of Object.entries(run.inputs)) {
          line.consumes[res] = round4((line.consumes[res] || 0) + amt);
        }
      }
      const fuel = economy.fuelConsumptionPerTurn(c);
      for (const [key, count] of Object.entries(c.improvements || {})) {
        const def = C.IMPROVEMENTS[key];
        if (!def || def.category !== 'power' || !count || !def.fuel) continue;
        const line = byImprovement[key];
        if (line && fuel[def.fuel]) {
          line.consumes[def.fuel] = round4((line.consumes[def.fuel] || 0) + fuel[def.fuel]);
        }
      }

      perCity.push({
        id: c.id,
        name: c.name,
        infrastructure: c.infrastructure,
        land: c.land,
        population: snapCity.population || 0,
        commerce,
        pollution,
        powered,
        power,
        powerCapacity: capacity,
        powerDeficit: Math.max(c.infrastructure - capacity, 0),
        incomePerDay: round2(economy.cityIncomePerDay(c, snapCity.population || 0, { ...opts, commerce })),
        upkeepPerDay: economy.improvementUpkeepPerDay(c, opts),
        grossResourcesPerTurn: production.gross,
        consumedResourcesPerTurn: production.consumed,
        netResourcesPerTurn: production.net,
        idle,
        warnings: snapCity.warnings || [],
      });
    }

    // ---- Resource flow: where every unit comes from and goes --------------
    const flow = {};
    for (const r of C.ALL_RESOURCES) {
      if (r === 'money' || r === 'credits') continue;
      const gross = perCity.reduce((s, c) => s + (c.grossResourcesPerTurn[r] || 0), 0);
      const consumed = perCity.reduce((s, c) => s + (c.consumedResourcesPerTurn[r] || 0), 0);
      const stock = nation.stockpile[r] || 0;
      const net = gross - consumed - (r === 'food' ? snap.revenue.foodConsumptionPerTurn : 0);

      flow[r] = {
        stockpile: round4(stock),
        producedPerTurn: round4(gross),
        consumedPerTurn: round4(consumed + (r === 'food' ? snap.revenue.foodConsumptionPerTurn : 0)),
        netPerTurn: round4(net),
        // The number that actually matters: how long until this runs out.
        turnsRemaining: net < 0 && stock > 0 ? Math.floor(stock / -net) : null,
        daysRemaining: net < 0 && stock > 0
          ? round2(stock / -net / C.TICK.TURNS_PER_DAY) : null,
      };
    }

    // Food is consumed by people and soldiers, not by a building — split it
    // out so the ledger accounts for every unit.
    const soldiers = nation.units.soldiers || 0;
    const atWar = (nation.activeWars || 0) > 0;
    const civilianFood = snap.totalPopulation * C.ECONOMY.FOOD_PER_POPULATION_PER_TURN;
    const militaryFood = snap.revenue.foodConsumptionPerTurn - civilianFood;

    // ---- Cash: gross to net, every deduction named ------------------------
    const rev = snap.revenue;
    const cash = {
      grossIncomePerDay: rev.grossIncomePerDay,
      baseIncomePerDay: rev.baseIncomePerDay,
      improvementUpkeepPerDay: rev.improvementUpkeepPerDay,
      unitUpkeepPerDay: rev.unitUpkeepPerDay,
      netIncomePerDay: rev.netIncomePerDay,
      netIncomePerTurn: rev.netIncomePerTurn,
      outOfFood: rev.outOfFood,
      // What the -33% food penalty is costing, in money, right now.
      foodPenaltyCost: rev.outOfFood
        ? round2(rev.grossIncomePerDay / C.ECONOMY.OUT_OF_FOOD_PENALTY - rev.grossIncomePerDay)
        : 0,
    };

    return {
      turn: gs.turn,
      money: nation.money,
      totalPopulation: snap.totalPopulation,
      cash,
      food: {
        civilianPerTurn: round4(civilianFood),
        militaryPerTurn: round4(militaryFood),
        soldiers,
        atWar,
        totalPerTurn: round4(snap.revenue.foodConsumptionPerTurn),
      },
      flow,
      byImprovement: Object.values(byImprovement).sort((a, b) =>
        a.category.localeCompare(b.category) || a.key.localeCompare(b.key)),
      perCity,
      projectEffects: modifiers.aggregateProjectEffects(projects),
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

// ============================================================================
// MARKET
// ============================================================================


// ============================================================================
// RANKINGS — public, no authentication
// ============================================================================

/**
 * The world table, ordered by score.
 *
 * Ordered by SCORE rather than infrastructure, because score is what decides
 * who can attack whom. A table sorted by infrastructure looks like a ranking
 * but answers a question nobody is asking.
 *
 * Deliberately EXCLUDES money and stockpiles. This endpoint needs no login, and
 * publishing everyone's treasury turns raiding from a judgement call into a
 * shopping list. Name, size and score are public in this genre; cash is not.
 */
async function getRankings({ limit = 100 } = {}) {
  const gs = await db.query('SELECT current_turn FROM game_state WHERE id = 1');
  const turn = gs.rows.length ? Number(gs.rows[0].current_turn) : 0;

  // Two queries, not one per nation. findTargets does an N+1 over units, which
  // is fine for a war-range slice and would be 100 round trips here.
  const { rows } = await db.query(
    `SELECT n.id, n.name, n.color, n.alliance_id, n.beige_until_turn,
            COUNT(DISTINCT c.id)              AS city_count,
            COALESCE(SUM(c.infrastructure),0) AS total_infrastructure,
            COALESCE(SUM(c.land),0)           AS total_land,
            (SELECT COUNT(*) FROM nation_projects p WHERE p.nation_id = n.id) AS project_count
       FROM nations n
       LEFT JOIN cities c ON c.nation_id = n.id
      WHERE n.is_deleted = FALSE
      GROUP BY n.id`
  );

  const unitRows = await db.query(
    `SELECT nation_id, unit_key, count FROM nation_units
      WHERE nation_id = ANY($1::bigint[])`,
    [rows.map(r => Number(r.id))]
  );
  const unitsByNation = new Map();
  for (const u of unitRows.rows) {
    const id = Number(u.nation_id);
    if (!unitsByNation.has(id)) unitsByNation.set(id, {});
    unitsByNation.get(id)[u.unit_key] = db.num(u.count);
  }

  const nations = rows.map(r => {
    const id = Number(r.id);
    const cityCount = Math.max(Number(r.city_count), 1);
    const infra = db.num(r.total_infrastructure);

    // nationScore only reads total infrastructure across cities, so putting it
    // all in the first city gives the same answer without loading every row.
    const score = military.nationScore({
      cities: Array(cityCount).fill(null).map((_, i) => ({
        infrastructure: i === 0 ? infra : 0,
      })),
      projects: Array(Number(r.project_count)).fill('x'),
      units: unitsByNation.get(id) || {},
    });

    const onBeige = r.beige_until_turn !== null && turn < Number(r.beige_until_turn);

    return {
      id,
      name: r.name,
      color: r.color,
      allianceId: r.alliance_id ? Number(r.alliance_id) : null,
      cities: Number(r.city_count),
      infrastructure: infra,
      land: db.num(r.total_land),
      projects: Number(r.project_count),
      score: round2(score),
      onBeige,
    };
  });

  nations.sort((a, b) => b.score - a.score);
  nations.forEach((n, i) => { n.rank = i + 1; });

  return {
    turn,
    total: nations.length,
    // Beige and gray nations are excluded from the total score in the engine;
    // say so here rather than letting the number look wrong.
    nations: nations.slice(0, Math.min(limit, 250)),
  };
}

// ============================================================================
// PROJECTS
// ============================================================================

/**
 * The project catalogue with everything the page needs to decide, in one call:
 * what it does, what it costs, whether you own it, and whether you can pay.
 *
 * Affordability is computed here for DISPLAY only. buildProject re-checks it
 * inside the transaction — this is a hint, not an authorisation.
 */
async function getProjectCatalogue(nationId) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { currentTurn: gs.turn });
    if (!nation) throw new GameError('Nation not found');

    const owned = new Set(nation.projects || []);
    const stockpile = nation.stockpile || {};
    const money = db.num(nation.money);

    const projects = Object.entries(C.PROJECTS).map(([key, def]) => {
      const cost = def.cost || {};
      const short = {};
      for (const [res, amount] of Object.entries(cost)) {
        const held = res === 'money' ? money : db.num(stockpile[res] || 0);
        if (held < amount) short[res] = round4(amount - held);
      }
      return {
        key,
        name: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        cost,
        effect: def.effect,
        owned: owned.has(key),
        affordable: Object.keys(short).length === 0,
        short,
      };
    });

    return {
      turn: gs.turn,
      money,
      stockpile,
      ownedCount: owned.size,
      // Every project adds score, which widens the range of nations that can
      // declare on you. The page says this out loud rather than surprising you.
      scorePerProject: C.PROJECT_SCORE_VALUE,
      currentScore: round2(military.nationScore(nation)),
      projects,
    };
  });
}

// ============================================================================
// WAR HISTORY
// ============================================================================

/**
 * Every war this nation has fought, finished ones included.
 *
 * /api/wars deliberately returns only ACTIVE wars because the military page
 * acts on them. History is a separate question and a separate query — merging
 * them would put ended wars in the attack UI.
 */
async function getWarHistory(nationId, limit = 50) {
  const { rows } = await db.query(
    `SELECT w.*, a.name AS attacker_name, d.name AS defender_name,
            (SELECT COUNT(*) FROM battles b WHERE b.war_id = w.id) AS battle_count
       FROM wars w
       JOIN nations a ON a.id = w.attacker_id
       JOIN nations d ON d.id = w.defender_id
      WHERE w.attacker_id = $1 OR w.defender_id = $1
      ORDER BY w.started_turn DESC
      LIMIT $2`,
    [nationId, Math.min(limit, 200)]
  );

  return {
    wars: rows.map(w => ({
      ...w,
      id: Number(w.id),
      attackerId: Number(w.attacker_id),
      defenderId: Number(w.defender_id),
      battleCount: Number(w.battle_count),
      youAttacked: Number(w.attacker_id) === Number(nationId),
      active: w.ended_turn === null,
    })),
  };
}

/**
 * The battles in one war — only for the two nations that fought it.
 *
 * Without the participant check this leaks every battle in the game to anyone
 * who can guess a war id, which is a straightforward intelligence advantage.
 */
async function getWarBattles(nationId, warId) {
  const war = await db.query(
    'SELECT id, attacker_id, defender_id FROM wars WHERE id = $1', [warId]);
  if (war.rows.length === 0) throw new GameError('War not found');

  const w = war.rows[0];
  if (Number(w.attacker_id) !== Number(nationId) &&
      Number(w.defender_id) !== Number(nationId)) {
    throw new GameError('You were not in that war');
  }

  const { rows } = await db.query(
    `SELECT * FROM battles WHERE war_id = $1 ORDER BY turn ASC, id ASC`, [warId]);

  return {
    warId: Number(warId),
    battles: rows.map(b => ({
      ...b,
      id: Number(b.id),
      turn: Number(b.turn),
      victoryType: Number(b.victory_type),
      // rng_seed is what makes a battle auditable — surfacing it is the point.
      rngSeed: b.rng_seed === null ? null : String(b.rng_seed),
      replayable: b.rng_seed !== null,
    })),
  };
}

/**
 * Dig in. Raises the casualties an attacker takes against you for the rest of
 * this cycle, and ends the moment you attack.
 *
 * WHY THIS EXISTS. The engine has read `fortified` since combat.js was written,
 * the wars table has carried the column since the first schema, and nothing has
 * ever been able to set it to TRUE. A defender's only option was to hit back —
 * which is not a defensive game, it is the same offensive game played from
 * behind.
 *
 * It costs the same MAP as a ground battle on purpose. A free action taken
 * every single turn is not a decision.
 */
async function fortify(nationId, warId) {
  return db.withTransaction(async (tx) => {
    const { rows: warRows } = await tx.query(
      'SELECT * FROM wars WHERE id = $1 AND ended_turn IS NULL', [warId]
    );
    if (warRows.length === 0) throw new GameError('War not found or already ended');
    const war = warRows[0];

    const isAttacker = Number(war.attacker_id) === Number(nationId);
    const isDefender = Number(war.defender_id) === Number(nationId);
    if (!isAttacker && !isDefender) throw new GameError('You are not a participant in this war');

    await db.lockNations(tx, [nationId]);

    const gs = await repo.loadGameState(tx);
    const me = await repo.loadNation(tx, nationId, { lock: true, currentTurn: gs.turn });
    if (!me) throw new GameError('Nation not found');

    const column = isAttacker ? 'attacker_fortified' : 'defender_fortified';
    if (war[column]) throw new GameError('You are already fortified in this war');

    // Validated inside the transaction, after the lock — checking MAP outside it
    // is the read-modify-write race that lets two requests spend the same points.
    const check = military.canPerformAction(me.map, 'fortify');
    if (!check.ok) {
      throw new GameError(
        `Fortifying costs ${check.cost} action points and you have ${me.map}.`,
        { cost: check.cost, have: me.map, shortfall: check.shortfall }
      );
    }

    me.map -= check.cost;
    await tx.query(`UPDATE wars SET ${column} = TRUE WHERE id = $1`, [warId]);
    await repo.saveNation(tx, me);

    const opponentId = isAttacker ? Number(war.defender_id) : Number(war.attacker_id);
    await repo.recordEvents(tx, opponentId, [{
      turn: gs.turn, type: 'enemy_fortified',
      message: `${me.name} has fortified against you. Attacking them now costs you ` +
               `${Math.round(C.COMBAT.FORTIFY_CASUALTY_INCREASE * 100)}% more casualties.`,
    }]);

    return {
      ok: true,
      warId: Number(warId),
      fortified: true,
      mapSpent: check.cost,
      mapRemaining: me.map,
      attackerCasualtyIncrease: C.COMBAT.FORTIFY_CASUALTY_INCREASE,
    };
  });
}

/**
 * Active wars, shaped from the READER's point of view.
 *
 * The raw columns are attacker_/defender_ prefixed, so every consumer has to
 * work out which side it is on before it can read anything. Doing that once
 * here means the page cannot get it backwards — and getting it backwards means
 * telling a player they hold air superiority when they are suffering under it.
 */
async function getWars(nationId) {
  const { rows } = await db.query(
    `SELECT w.*, a.name AS attacker_name, d.name AS defender_name
       FROM wars w
       JOIN nations a ON a.id = w.attacker_id
       JOIN nations d ON d.id = w.defender_id
      WHERE (w.attacker_id = $1 OR w.defender_id = $1) AND w.ended_turn IS NULL
      ORDER BY w.started_turn DESC`,
    [nationId]
  );

  return {
    wars: rows.map(w => {
      const isAttacker = Number(w.attacker_id) === Number(nationId);
      return {
        ...w,
        id: Number(w.id),
        youDeclared: isAttacker,
        opponentId: isAttacker ? Number(w.defender_id) : Number(w.attacker_id),
        opponentName: isAttacker ? w.defender_name : w.attacker_name,

        myResistance: db.num(isAttacker ? w.attacker_resistance : w.defender_resistance),
        theirResistance: db.num(isAttacker ? w.defender_resistance : w.attacker_resistance),

        // What YOU hold, and what is being held OVER you.
        myControlState: isAttacker ? w.attacker_control_state : w.defender_control_state,
        theirControlState: isAttacker ? w.defender_control_state : w.attacker_control_state,

        iAmFortified: isAttacker ? w.attacker_fortified : w.defender_fortified,
        theyAreFortified: isAttacker ? w.defender_fortified : w.attacker_fortified,
      };
    }),
  };
}

module.exports = {
  GameError,
  getSnapshot,
  getEvents,
  getRankings,
  getProjectCatalogue,
  getWarHistory,
  getWarBattles,
  getEconomy,
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
  getPolicies,
  previewPolicy,
  declareWar,
  attack,
  fortify,
  getWars,
};
