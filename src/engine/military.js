/**
 * ============================================================================
 *  PART 5 of 7 — military.js
 * ============================================================================
 *  Score, war range, unit costs, recruitment capacity, army value, and supply.
 *
 *  Pure functions. No database, no side effects.
 *
 *  ---------------------------------------------------------------------------
 *  TWO IDEAS DO ALL THE WORK IN THIS FILE
 *  ---------------------------------------------------------------------------
 *
 *  1. SCORE IS A POWER RATING *AND* A MATCHMAKING WEIGHT.
 *     Every unit you build makes you stronger AND drags you toward bigger
 *     opponents. That dual role is why ships are a trap in P&W: 1.0 score each
 *     is the worst power-to-score ratio in the game. Players actively manage
 *     score downward. Any coefficient you change here is simultaneously a
 *     balance lever and a matchmaking lever — never treat it as just one.
 *
 *  2. UNSUPPLIED UNITS CONTRIBUTE ZERO ARMY VALUE BUT STILL TAKE CASUALTIES.
 *     One clause makes logistics mandatory without a separate logistics
 *     system. It punishes exactly the failure mode it needs to (mass units,
 *     ignore supply) with no extra UI, no extra tables, no explanation needed.
 *     This is the single best rule in P&W. It is enforced in computeSupply()
 *     and honoured by armyValue(). Do not let a caller bypass it.
 * ============================================================================
 */

'use strict';

const C = require('./constants');

// ============================================================================
// HELPERS
// ============================================================================

function assertFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got: ${value}`);
  }
}

function assertNonNegative(value, name) {
  assertFiniteNumber(value, name);
  if (value < 0) throw new RangeError(`${name} must be >= 0, got: ${value}`);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function countImprovement(city, key) {
  if (!city.improvements) return 0;
  return city.improvements[key] || 0;
}

/** Normalise a unit bag so every unit type is present and numeric. */
function normaliseUnits(units = {}) {
  const out = {};
  for (const key of Object.keys(C.UNITS)) {
    const v = units[key] || 0;
    assertNonNegative(v, `units.${key}`);
    out[key] = v;
  }
  return out;
}

// ============================================================================
// SCORE
// ============================================================================

/**
 * Military contribution to score.
 *
 * Missiles and nukes are capped at 50 score each in total — without the cap, a
 * nuclear stockpile would push a nation permanently out of everyone's war
 * range, making it untouchable. The cap is an anti-turtling measure, not a
 * balance tweak.
 */
function militaryScore(units = {}) {
  const u = normaliseUnits(units);
  const S = C.SCORE.MILITARY;

  const missileScore = Math.min(u.missiles * S.missiles, C.SCORE.MISSILE_SCORE_CAP);
  const nukeScore = Math.min(u.nukes * S.nukes, C.SCORE.NUKE_SCORE_CAP);

  return u.soldiers * S.soldiers
       + u.tanks    * S.tanks
       + u.aircraft * S.aircraft
       + u.ships    * S.ships
       + missileScore
       + nukeScore;
}

/**
 * Full nation score.
 *   (cityCount - 1) * 100 + totalInfra/40 + projects*20 + military + 10
 *
 * @param {Object} nation { cities: [], projects: [], units: {} }
 */
function nationScore(nation) {
  const cities = nation.cities || [];
  const projects = nation.projects || [];
  const units = nation.units || {};

  const cityCount = cities.length;
  if (cityCount < 1) {
    throw new RangeError('A nation must have at least one city');
  }

  const totalInfra = cities.reduce((sum, c) => {
    assertNonNegative(c.infrastructure, 'city.infrastructure');
    return sum + c.infrastructure;
  }, 0);

  return C.SCORE.BASE
       + (cityCount - 1) * C.SCORE.PER_CITY
       + totalInfra / C.SCORE.INFRA_DIVISOR
       + projects.length * C.SCORE.PER_PROJECT
       + militaryScore(units);
}

/**
 * Score with every component itemised.
 *
 * Worth surfacing in the UI. In P&W players reverse-engineer this from wikis
 * to manage their war range; showing it directly removes a whole category of
 * "why did that huge nation attack me" confusion.
 */
function scoreBreakdown(nation) {
  const cities = nation.cities || [];
  const projects = nation.projects || [];
  const u = normaliseUnits(nation.units || {});
  const S = C.SCORE.MILITARY;

  const totalInfra = cities.reduce((s, c) => s + c.infrastructure, 0);

  const missileRaw = u.missiles * S.missiles;
  const nukeRaw = u.nukes * S.nukes;

  const components = {
    base: C.SCORE.BASE,
    cities: (cities.length - 1) * C.SCORE.PER_CITY,
    infrastructure: totalInfra / C.SCORE.INFRA_DIVISOR,
    projects: projects.length * C.SCORE.PER_PROJECT,
    soldiers: u.soldiers * S.soldiers,
    tanks: u.tanks * S.tanks,
    aircraft: u.aircraft * S.aircraft,
    ships: u.ships * S.ships,
    missiles: Math.min(missileRaw, C.SCORE.MISSILE_SCORE_CAP),
    nukes: Math.min(nukeRaw, C.SCORE.NUKE_SCORE_CAP),
  };

  const total = Object.values(components).reduce((a, b) => a + b, 0);

  return {
    total: round2(total),
    components,
    capped: {
      missiles: missileRaw > C.SCORE.MISSILE_SCORE_CAP,
      nukes: nukeRaw > C.SCORE.NUKE_SCORE_CAP,
    },
  };
}

/**
 * Score cost per point of army value — the number that reveals trap units.
 * Lower is better. Ships score badly here, which is exactly why experienced
 * players avoid them.
 */
function scoreEfficiency(unitKey) {
  const scorePer = C.SCORE.MILITARY[unitKey];
  if (scorePer === undefined) throw new Error(`Unknown unit: ${unitKey}`);

  const AV = C.COMBAT.ARMY_VALUE;
  const valuePer =
    unitKey === 'soldiers' ? AV.ARMED_SOLDIER :
    unitKey === 'tanks' ? AV.TANK :
    null;

  if (valuePer === null) return null;   // aircraft/ships/missiles use separate scales
  return { scorePerUnit: scorePer, armyValuePerUnit: valuePer, scorePerArmyValue: scorePer / valuePer };
}

// ============================================================================
// WAR RANGE
// ============================================================================

/**
 * The range of scores this nation may DECLARE ON.
 *
 * Asymmetric on purpose: 25% below to 75% above. You can always be attacked by
 * someone meaningfully bigger, never by someone overwhelmingly bigger. This is
 * the anti-griefing backbone of the whole game.
 */
function warRange(score) {
  assertNonNegative(score, 'score');
  return {
    min: score * C.WAR_RANGE.MIN_MULTIPLIER,
    max: score * C.WAR_RANGE.MAX_MULTIPLIER,
  };
}

/**
 * The range of scores that may DECLARE ON this nation — the inverse.
 *
 * Attacker A can hit defender D when D is in [0.75A, 1.75A].
 * Solving for A:  A in [D/1.75, D/0.75].
 *
 * Players need this far more than warRange(): "who can hit me?" is the
 * question that drives score management.
 */
function vulnerableToRange(score) {
  assertNonNegative(score, 'score');
  return {
    min: score / C.WAR_RANGE.MAX_MULTIPLIER,
    max: score / C.WAR_RANGE.MIN_MULTIPLIER,
  };
}

function isInWarRange(attackerScore, defenderScore) {
  const r = warRange(attackerScore);
  return defenderScore >= r.min && defenderScore <= r.max;
}

function espionageRange(score) {
  assertNonNegative(score, 'score');
  return {
    min: score * C.ESPIONAGE_RANGE.MIN_MULTIPLIER,
    max: score * C.ESPIONAGE_RANGE.MAX_MULTIPLIER,
  };
}

function isInEspionageRange(attackerScore, defenderScore) {
  const r = espionageRange(attackerScore);
  return defenderScore >= r.min && defenderScore <= r.max;
}

// ============================================================================
// UNIT COSTS
// ============================================================================

/** Total build cost for `count` units, as a resource ledger. */
function buildCost(unitKey, count = 1) {
  const def = C.UNITS[unitKey];
  if (!def) throw new Error(`Unknown unit: ${unitKey}`);
  assertNonNegative(count, 'count');

  const cost = {};
  for (const [res, amount] of Object.entries(def.cost)) {
    cost[res] = amount * count;
  }
  return cost;
}

/**
 * Can this nation afford `count` units?
 * @returns {{ok: boolean, missing?: Object}}
 */
function canAfford(stockpile, unitKey, count = 1) {
  const cost = buildCost(unitKey, count);
  const missing = {};
  let ok = true;

  for (const [res, needed] of Object.entries(cost)) {
    const have = stockpile[res] || 0;
    if (have < needed) {
      missing[res] = needed - have;
      ok = false;
    }
  }
  return ok ? { ok: true } : { ok: false, missing };
}

// ============================================================================
// RECRUITMENT CAPACITY
// ============================================================================

/**
 * Maximum standing army of this unit type, from military buildings.
 * Capacity is a hard ceiling — you cannot exceed it regardless of money.
 */
function unitCapacity(cities, unitKey) {
  const def = C.UNITS[unitKey];
  if (!def) throw new Error(`Unknown unit: ${unitKey}`);
  if (!def.building) return Infinity;   // missiles/nukes are project-gated, not building-gated

  const buildingDef = C.IMPROVEMENTS[def.building];
  return (cities || []).reduce(
    (sum, city) => sum + countImprovement(city, def.building) * buildingDef.capacity,
    0
  );
}

/**
 * How many can be recruited per day. Separate from capacity: capacity is the
 * ceiling, this is the fill rate. The gap between them is what makes rebuilding
 * after a lost war take real time.
 */
function dailyRecruitmentCap(cities, unitKey, opts = {}) {
  const def = C.UNITS[unitKey];
  if (!def) throw new Error(`Unknown unit: ${unitKey}`);

  // Project-gated units (missiles, nukes) have no recruitment building. P&W
  // builds them at a fixed rate from their enabling project, but that rate is
  // unsourced — so for now they are unthrottled once the project is owned.
  // PLACEHOLDER: give these a real per-day rate once sourced, or they become
  // the cheapest thing in the game to spam.
  if (!def.building) return Infinity;

  const buildingDef = C.IMPROVEMENTS[def.building];
  let perDay = (cities || []).reduce(
    (sum, city) => sum + countImprovement(city, def.building) * buildingDef.perDay,
    0
  );

  const projects = opts.projects || [];
  if (projects.includes('propaganda_bureau')) {
    perDay *= 1 + C.PROJECTS.propaganda_bureau.effect.militaryRecruitmentBonus;
  }

  return Math.floor(perDay);
}

/**
 * Full recruitment check: buildings exist, capacity available, daily rate not
 * exceeded, resources affordable, project prerequisites met.
 *
 * @returns {{ok: boolean, reason?: string, maxPossible?: number}}
 */
function canRecruit(nation, unitKey, count, opts = {}) {
  const def = C.UNITS[unitKey];
  if (!def) return { ok: false, reason: `Unknown unit: ${unitKey}` };
  assertNonNegative(count, 'count');
  if (count === 0) return { ok: false, reason: 'Count must be at least 1' };

  const cities = nation.cities || [];
  const current = (nation.units && nation.units[unitKey]) || 0;
  const projects = nation.projects || [];

  // Project prerequisite (missiles, nukes).
  if (def.requiresProject && !projects.includes(def.requiresProject)) {
    return { ok: false, reason: `Requires the ${def.requiresProject} project` };
  }

  // Standing capacity.
  const capacity = unitCapacity(cities, unitKey);
  if (current + count > capacity) {
    const room = Math.max(capacity - current, 0);
    return {
      ok: false,
      reason: `Capacity is ${capacity} ${unitKey} (have ${current}). Build more ${def.building}s.`,
      maxPossible: room,
    };
  }

  // Daily rate.
  const dailyCap = dailyRecruitmentCap(cities, unitKey, { projects });
  const alreadyToday = opts.recruitedToday || 0;
  if (alreadyToday + count > dailyCap) {
    const room = Math.max(dailyCap - alreadyToday, 0);
    return {
      ok: false,
      reason: `Daily limit is ${dailyCap} ${unitKey} (${alreadyToday} already recruited today)`,
      maxPossible: room,
    };
  }

  // Resources.
  if (opts.stockpile) {
    const afford = canAfford(opts.stockpile, unitKey, count);
    if (!afford.ok) {
      const shortfall = Object.entries(afford.missing)
        .map(([r, n]) => `${round2(n)} ${r}`).join(', ');
      return { ok: false, reason: `Insufficient resources: short ${shortfall}` };
    }
  }

  return { ok: true };
}

// ============================================================================
// SUPPLY — THE RULE THAT MATTERS
// ============================================================================

/**
 * Work out which units are actually supplied for a battle.
 *
 * ALLOCATION PRIORITY (a design decision, documented so it can be argued with):
 *   1. Units that need supply to FUNCTION AT ALL — tanks, aircraft, ships.
 *      Unsupplied, they contribute nothing while still dying.
 *   2. Soldiers, who fight either way but hit far harder armed (1.75 vs 1.0).
 *
 * Feeding a tank before arming a soldier is correct because a tank is worth 40
 * army value and a soldier's munitions only buy an extra 0.75. Spending scarce
 * munitions on soldiers first would be strictly worse for the player, and an
 * engine that silently made that choice for them would feel broken.
 *
 * @returns supply state plus the exact consumption to deduct
 */
function computeSupply(units, stockpile = {}, opts = {}) {
  const u = normaliseUnits(units);
  let munitions = stockpile.munitions || 0;
  let gasoline = stockpile.gasoline || 0;

  const result = {
    armedSoldiers: 0,
    unarmedSoldiers: u.soldiers,
    suppliedTanks: 0,
    unsuppliedTanks: u.tanks,
    suppliedAircraft: 0,
    unsuppliedAircraft: u.aircraft,
    suppliedShips: 0,
    unsuppliedShips: u.ships,
    consumption: { munitions: 0, gasoline: 0 },
    shortfalls: [],
  };

  /** Supply a vehicle class that needs both munitions and gasoline. */
  function supplyVehicles(key, count, perUnit) {
    if (count === 0) return 0;
    const mNeed = perUnit.munitions || 0;
    const gNeed = perUnit.gasoline || 0;

    let possible = count;
    if (mNeed > 0) possible = Math.min(possible, Math.floor(munitions / mNeed));
    if (gNeed > 0) possible = Math.min(possible, Math.floor(gasoline / gNeed));
    possible = Math.max(possible, 0);

    const mUsed = possible * mNeed;
    const gUsed = possible * gNeed;
    munitions -= mUsed;
    gasoline -= gUsed;
    result.consumption.munitions += mUsed;
    result.consumption.gasoline += gUsed;

    if (possible < count) {
      result.shortfalls.push(
        `${count - possible} of ${count} ${key} unsupplied — they contribute no combat value but will still take casualties.`
      );
    }
    return possible;
  }

  // --- Priority 1: vehicles ---
  result.suppliedTanks = supplyVehicles('tanks', u.tanks, C.UNITS.tanks.battleConsumption);
  result.unsuppliedTanks = u.tanks - result.suppliedTanks;

  result.suppliedAircraft = supplyVehicles('aircraft', u.aircraft, C.UNITS.aircraft.battleConsumption);
  result.unsuppliedAircraft = u.aircraft - result.suppliedAircraft;

  result.suppliedShips = supplyVehicles('ships', u.ships, C.UNITS.ships.battleConsumption);
  result.unsuppliedShips = u.ships - result.suppliedShips;

  // --- Priority 2: arming soldiers with whatever is left ---
  const perSoldier = C.UNITS.soldiers.battleConsumption.munitions || 0;
  if (u.soldiers > 0 && perSoldier > 0) {
    const canArm = Math.min(u.soldiers, Math.floor(munitions / perSoldier));
    const used = canArm * perSoldier;
    munitions -= used;
    result.consumption.munitions += used;
    result.armedSoldiers = canArm;
    result.unarmedSoldiers = u.soldiers - canArm;
    if (canArm < u.soldiers) {
      result.shortfalls.push(
        `${u.soldiers - canArm} of ${u.soldiers} soldiers unarmed — they fight at reduced strength.`
      );
    }
  }

  result.fullySupplied = result.shortfalls.length === 0;
  return result;
}

/**
 * Army value gained per unit of munitions spent on this unit class.
 *
 * This is what JUSTIFIES the allocation priority in computeSupply(). It is
 * exposed rather than hardcoded because the margin is thin:
 *
 *     tanks    ~4000 army value per munition
 *     soldiers ~3750 army value per munition
 *
 * Tanks win by roughly 7%. That is narrow enough that changing the soldier
 * munitions rate — currently a PLACEHOLDER — could flip the correct ordering.
 * If that constant is ever sourced, re-check this before trusting the priority.
 */
function armyValuePerMunition(unitKey) {
  const AV = C.COMBAT.ARMY_VALUE;
  const def = C.UNITS[unitKey];
  if (!def) throw new Error(`Unknown unit: ${unitKey}`);

  const perUnit = (def.battleConsumption && def.battleConsumption.munitions) || 0;
  if (perUnit <= 0) return Infinity;   // fights free

  if (unitKey === 'soldiers') {
    // Munitions only buy the ARMED premium, not the base value.
    return (AV.ARMED_SOLDIER - AV.UNARMED_SOLDIER) / perUnit;
  }
  if (unitKey === 'tanks') {
    // Munitions buy the tank's entire contribution — unsupplied it is worth 0.
    return AV.TANK / perUnit;
  }
  return null;   // aircraft/ships use separate value scales
}

// ============================================================================
// ARMY VALUE
// ============================================================================

/**
 * Ground combat strength.
 *   armyValue = unarmedSoldiers * 1 + armedSoldiers * 1.75 + tanks * 40
 *
 * Only SUPPLIED tanks count. Unsupplied ones are ghosts: visible on the roster,
 * worth nothing in the roll, and still eligible to die.
 *
 * @param {Object} supply  output of computeSupply()
 * @param {Object} opts    { defenderPopulation, airSuperiorityAgainst }
 */
function armyValue(supply, opts = {}) {
  const AV = C.COMBAT.ARMY_VALUE;

  let tankValue = supply.suppliedTanks * AV.TANK;

  // Enemy air superiority halves tank effectiveness.
  if (opts.airSuperiorityAgainst) {
    tankValue *= C.CONTROL_STATES.air_superiority.modifier;
  }

  let value = supply.unarmedSoldiers * AV.UNARMED_SOLDIER
            + supply.armedSoldiers * AV.ARMED_SOLDIER
            + tankValue;

  // Defenders get a civilian militia contribution.
  // ⚠️ SOURCES CONFLICT on the divisor: the wiki says population/400, the
  // in-game FAQ says 0.025% (population/4000) — a 10x difference that
  // materially changes how defensible a large civilian population is.
  // Verify against the live game before shipping.
  if (opts.defenderPopulation) {
    assertNonNegative(opts.defenderPopulation, 'defenderPopulation');
    value += opts.defenderPopulation / C.COMBAT.DEFENDER_MILITIA_DIVISOR;
  }

  return value;
}

/** Air combat strength. Only supplied aircraft count. */
function airforceValue(supply) {
  return supply.suppliedAircraft;   // PLACEHOLDER — P&W's exact air value scale unsourced
}

/** Naval combat strength. Only supplied ships count. */
function navalValue(supply) {
  return supply.suppliedShips;      // PLACEHOLDER — P&W's exact naval value scale unsourced
}

/**
 * Convenience: army value straight from a unit bag and stockpile.
 * Prefer this at call sites so supply can never be accidentally skipped.
 */
function effectiveArmyValue(units, stockpile, opts = {}) {
  const supply = computeSupply(units, stockpile, opts);
  return { value: armyValue(supply, opts), supply };
}

// ============================================================================
// MAP (MILITARY ACTION POINTS)
// ============================================================================

function mapRegenPerTurn() {
  return C.COMBAT.MAP_PER_TURN;
}

function accrueMap(currentMap, turns = 1) {
  assertNonNegative(currentMap, 'currentMap');
  assertNonNegative(turns, 'turns');
  return Math.min(currentMap + turns * C.COMBAT.MAP_PER_TURN, C.COMBAT.MAP_MAX);
}

function canPerformAction(currentMap, actionType) {
  const cost = C.COMBAT.MAP_COST[actionType];
  if (cost === undefined) throw new Error(`Unknown action type: ${actionType}`);
  return {
    ok: currentMap >= cost,
    cost,
    shortfall: Math.max(cost - currentMap, 0),
  };
}

// ============================================================================
// WAR SLOTS
// ============================================================================

function offensiveWarSlots(projects = []) {
  return projects.includes('pirate_economy')
    ? C.COMBAT.OFFENSIVE_WAR_SLOTS_PIRATE
    : C.COMBAT.OFFENSIVE_WAR_SLOTS;
}

function canDeclareWar(nation, target, opts = {}) {
  const projects = nation.projects || [];

  const offensive = opts.currentOffensiveWars || 0;
  const slots = offensiveWarSlots(projects);
  if (offensive >= slots) {
    return { ok: false, reason: `All ${slots} offensive war slots in use` };
  }

  const targetDefensive = opts.targetDefensiveWars || 0;
  if (targetDefensive >= C.COMBAT.DEFENSIVE_WAR_SLOTS) {
    return { ok: false, reason: `Target already has ${C.COMBAT.DEFENSIVE_WAR_SLOTS} defensive wars` };
  }

  if (opts.targetOnBeige) {
    return { ok: false, reason: 'Target is on beige and cannot be declared on' };
  }

  const aScore = nationScore(nation);
  const dScore = target.score !== undefined ? target.score : nationScore(target);
  if (!isInWarRange(aScore, dScore)) {
    const r = warRange(aScore);
    return {
      ok: false,
      reason: `Target score ${round2(dScore)} is outside your war range (${round2(r.min)}–${round2(r.max)})`,
    };
  }

  if (opts.warType && !C.WAR_TYPES[opts.warType]) {
    return { ok: false, reason: `Unknown war type: ${opts.warType}` };
  }

  return { ok: true };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // score
  militaryScore,
  nationScore,
  scoreBreakdown,
  scoreEfficiency,

  // ranges
  warRange,
  vulnerableToRange,
  isInWarRange,
  espionageRange,
  isInEspionageRange,

  // costs & recruitment
  buildCost,
  canAfford,
  unitCapacity,
  dailyRecruitmentCap,
  canRecruit,

  // supply & strength
  computeSupply,
  armyValue,
  airforceValue,
  navalValue,
  effectiveArmyValue,
  armyValuePerMunition,

  // MAP
  mapRegenPerTurn,
  accrueMap,
  canPerformAction,

  // war slots
  offensiveWarSlots,
  canDeclareWar,

  // testing
  _normaliseUnits: normaliseUnits,
};
