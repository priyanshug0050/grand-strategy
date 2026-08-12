/**
 * ============================================================================
 *  PART 6 of 7 — combat.js
 * ============================================================================
 *  The 3-roll system, damage, casualties, loot, control states, resistance,
 *  and victory/beige.
 *
 *  Pure functions. No database, no side effects. Every battle function returns
 *  a RESULT OBJECT describing what should change — it never mutates its inputs.
 *  The tick engine in Part 7 applies those changes inside a transaction.
 *
 *  ---------------------------------------------------------------------------
 *  DETERMINISM
 *  ---------------------------------------------------------------------------
 *  Every function that uses randomness takes an injectable `rng`. Default is
 *  Math.random, but pass makeRng(seed) to replay a battle exactly.
 *
 *  This matters more than it looks on a game server: when a player disputes a
 *  battle result, you want to store the seed and reproduce it byte-for-byte.
 *  It also makes the balance simulator below meaningful, and the tests
 *  deterministic instead of flaky.
 *
 *  ---------------------------------------------------------------------------
 *  THE 40-100% BAND IS THE MASTER TUNING KNOB
 *  ---------------------------------------------------------------------------
 *  Widen it and combat becomes coin-flippy. Narrow it and combat becomes pure
 *  arithmetic, with no reason to ever fight an even match. At 40-100%:
 *
 *      ratio 1.0x -> ~50% sweep-or-lose, genuinely uncertain
 *      ratio 2.5x -> near-guaranteed sweep
 *
 *  That uncertainty band is what makes alliance warfare interesting rather
 *  than solved. Change ROLL_MIN_FRACTION and you change how war FEELS more
 *  than any other single number in the game.
 * ============================================================================
 */

'use strict';

const C = require('./constants');
const military = require('./military');

// ============================================================================
// RNG
// ============================================================================

/**
 * mulberry32 — small, fast, seedable. Good enough for game randomness; not
 * cryptographic, and it must never be used for anything security-relevant.
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randBetween(rng, min, max) {
  return min + rng() * (max - min);
}

function assertNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got: ${value}`);
  }
  if (value < 0) throw new RangeError(`${name} must be >= 0, got: ${value}`);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ============================================================================
// THE 3-ROLL SYSTEM
// ============================================================================

/**
 * Three independent contests. Each side rolls a uniform fraction of its army
 * value between 40% and 100%; higher roll wins that contest.
 *
 * @returns {{rollsWon: number, victoryType: number, rolls: Array}}
 */
function rollBattle(attackerValue, defenderValue, rng = Math.random) {
  assertNonNegative(attackerValue, 'attackerValue');
  assertNonNegative(defenderValue, 'defenderValue');

  const { ROLL_COUNT, ROLL_MIN_FRACTION, ROLL_MAX_FRACTION } = C.COMBAT;
  const rolls = [];
  let rollsWon = 0;

  for (let i = 0; i < ROLL_COUNT; i++) {
    const a = attackerValue * randBetween(rng, ROLL_MIN_FRACTION, ROLL_MAX_FRACTION);
    const d = defenderValue * randBetween(rng, ROLL_MIN_FRACTION, ROLL_MAX_FRACTION);
    const won = a > d;
    if (won) rollsWon++;
    rolls.push({ attacker: a, defender: d, won });
  }

  return { rollsWon, victoryType: rollsWon, rolls };
}

const VICTORY_NAMES = {
  0: 'Utter Failure',
  1: 'Pyrrhic Victory',
  2: 'Moderate Success',
  3: 'Immense Triumph',
};

function victoryName(victoryType) {
  return VICTORY_NAMES[victoryType] || 'Unknown';
}

/** Damage and resistance both scale linearly with the tier. One variable, two jobs. */
function victoryScale(victoryType) {
  return victoryType / C.COMBAT.VICTORY_TYPE_DIVISOR;
}

// ============================================================================
// MODIFIER RESOLUTION
// ============================================================================

/**
 * Collapse war type + both sides' war policies into damage/loot multipliers.
 *
 * Every war policy is a STRICT TRADEOFF, never a pure buff — that discipline
 * is what stops the meta collapsing onto one dominant choice. If you add a
 * policy here and cannot name what it costs the player, it is not finished.
 */
function resolveModifiers(opts = {}) {
  const warType = C.WAR_TYPES[opts.warType || 'ordinary'];
  if (!warType) throw new Error(`Unknown war type: ${opts.warType}`);

  let infraDamage = warType.infraDamage;
  let loot = warType.loot;
  let casualtiesDealt = 1;
  let casualtiesTaken = 1;

  const atkPolicy = C.WAR_POLICIES[opts.attackerPolicy];
  if (atkPolicy) {
    if (atkPolicy.infraDamageDealt) infraDamage *= atkPolicy.infraDamageDealt;
    if (atkPolicy.lootReceived) loot *= atkPolicy.lootReceived;
    if (atkPolicy.casualtiesDealt) casualtiesDealt *= atkPolicy.casualtiesDealt;
  }

  const defPolicy = C.WAR_POLICIES[opts.defenderPolicy];
  if (defPolicy) {
    if (defPolicy.infraDamageTaken) infraDamage *= defPolicy.infraDamageTaken;
    if (defPolicy.lootLost) loot *= defPolicy.lootLost;
    if (defPolicy.casualtiesTaken) casualtiesTaken *= defPolicy.casualtiesTaken;
  }

  // Fortifying costs the attacker casualties but ends the moment you attack.
  if (opts.defenderFortified) {
    casualtiesTaken *= 1 + C.COMBAT.FORTIFY_CASUALTY_INCREASE;
  }

  return { infraDamage, loot, casualtiesDealt, casualtiesTaken };
}

// ============================================================================
// DAMAGE
// ============================================================================

/**
 * The per-city infrastructure damage cap:  infra * 0.5 + 100
 *
 * ESSENTIAL. It guarantees no city dies in a single hit, which is what makes
 * wars multi-day affairs instead of instant knockouts. Removing it — or
 * "optimising" it away because it looks like a magic number — turns the whole
 * war system into a first-strike race.
 */
function infraDamageCap(cityInfra) {
  return cityInfra * C.COMBAT.INFRA_DAMAGE_CAP_FRACTION + C.COMBAT.INFRA_DAMAGE_CAP_CONSTANT;
}

/**
 * Shared damage shape for every battle type:
 *
 *     (attackerForce - defenderForce * 0.5) * coefficient
 *         * jitter(0.85-1.05) * (victoryType / 3)
 *     clamped to [0, cap]
 */
function applyDamageShape(rawForce, coefficient, victoryType, cityInfra, rng, modifier = 1) {
  const jitter = randBetween(rng, C.COMBAT.DAMAGE_JITTER_MIN, C.COMBAT.DAMAGE_JITTER_MAX);
  const raw = rawForce * coefficient * jitter * victoryScale(victoryType) * modifier;
  return Math.max(Math.min(raw, infraDamageCap(cityInfra)), 0);
}

function groundInfraDamage(attack, defend, victoryType, cityInfra, rng, modifier = 1) {
  const off = C.COMBAT.DEFENDER_DAMAGE_OFFSET;
  const soldierTerm = (attack.soldiers - defend.soldiers * off) * C.COMBAT.GROUND_SOLDIER_INFRA_COEFF;
  const tankTerm = (attack.tanks - defend.tanks * off) * C.COMBAT.GROUND_TANK_INFRA_COEFF;
  return applyDamageShape(soldierTerm + tankTerm, 1, victoryType, cityInfra, rng, modifier);
}

function airInfraDamage(attackAircraft, defendAircraft, victoryType, cityInfra, rng, modifier = 1, targetsInfra = true) {
  const off = C.COMBAT.DEFENDER_DAMAGE_OFFSET;
  const force = attackAircraft - defendAircraft * off;
  let dmg = applyDamageShape(force, C.COMBAT.AIR_INFRA_COEFF, victoryType, cityInfra, rng, modifier);
  // Airstrikes aimed at units rather than infrastructure do 1/3 collateral.
  if (!targetsInfra) dmg *= C.COMBAT.AIRSTRIKE_NON_INFRA_MULTIPLIER;
  return dmg;
}

function navalInfraDamage(attackShips, defendShips, victoryType, cityInfra, rng, modifier = 1) {
  const off = C.COMBAT.DEFENDER_DAMAGE_OFFSET;
  const force = attackShips - defendShips * off;
  return applyDamageShape(force, C.COMBAT.NAVAL_INFRA_COEFF, victoryType, cityInfra, rng, modifier);
}

// ============================================================================
// CASUALTIES
// ============================================================================

/**
 * ⚠️ PLACEHOLDER MODEL — P&W's real casualty formulas are not sourced.
 *
 * Shape used here: each side's losses scale with the OPPONENT's share of the
 * total force on the field, reduced by how many rolls you won. This is
 * self-balancing (a hopeless attack loses almost everything; a sweep is cheap)
 * and produces sane numbers, but the coefficients are invented.
 *
 * ⚠️ THE RULE THAT MATTERS: unsupplied units are included in the casualty pool
 * at full rate, even though they contributed zero army value. Mass units and
 * skip logistics, and you feed an army that cannot fight into a meat grinder.
 * Do not "fix" this.
 */
function computeCasualties(ownUnits, ownValue, enemyValue, victoryType, rng, modifier = 1) {
  const total = ownValue + enemyValue;
  if (total <= 0) return { soldiers: 0, tanks: 0, aircraft: 0, ships: 0 };

  const exposure = enemyValue / total;
  const victoryRelief = 1 - victoryType * C.COMBAT.CASUALTY_VICTORY_REDUCTION;
  const jitter = randBetween(rng, C.COMBAT.CASUALTY_JITTER_MIN, C.COMBAT.CASUALTY_JITTER_MAX);

  const rate = Math.max(
    C.COMBAT.CASUALTY_BASE_RATE * exposure * victoryRelief * jitter * modifier,
    0
  );

  return {
    soldiers: Math.floor((ownUnits.soldiers || 0) * rate),
    tanks: Math.floor((ownUnits.tanks || 0) * rate),
    aircraft: Math.floor((ownUnits.aircraft || 0) * rate),
    ships: Math.floor((ownUnits.ships || 0) * rate),
  };
}

// ============================================================================
// LOOT
// ============================================================================

/**
 *   loot = min(
 *     (soldiers * rand(0.5,1) + tanks * rand(7,13)) * victoryType,
 *     defenderMoney * 0.75,
 *     defenderMoney - 1,000,000
 *   )
 *
 * The $1M floor means nobody can ever be looted to zero — a small mercy that
 * keeps beaten players solvent enough to stay in the game rather than quit.
 */
function computeLoot(attackUnits, defenderMoney, victoryType, rng, modifier = 1) {
  if (victoryType <= 0 || defenderMoney <= 0) return 0;

  const soldierLoot = (attackUnits.soldiers || 0)
    * randBetween(rng, C.COMBAT.LOOT_SOLDIER_MIN, C.COMBAT.LOOT_SOLDIER_MAX);
  const tankLoot = (attackUnits.tanks || 0)
    * randBetween(rng, C.COMBAT.LOOT_TANK_MIN, C.COMBAT.LOOT_TANK_MAX);

  const raw = (soldierLoot + tankLoot) * victoryType * modifier;

  const loot = Math.min(
    raw,
    defenderMoney * C.COMBAT.LOOT_MAX_FRACTION,
    defenderMoney - C.COMBAT.LOOT_FLOOR
  );

  return Math.max(round2(loot), 0);
}

// ============================================================================
// RESISTANCE & CONTROL STATES
// ============================================================================

/**
 * Resistance lost, scaled by victory tier. An Utter Failure removes exactly
 * zero — losing costs the attacker MAP and units and buys nothing.
 */
function resistanceLoss(attackType, victoryType) {
  const base = C.COMBAT.RESISTANCE_LOSS[attackType];
  if (base === undefined) throw new Error(`Unknown attack type: ${attackType}`);
  return base * victoryScale(victoryType);
}

/**
 * Control states are rock-paper-scissors expressed as persistent debuffs.
 *
 * Note the asymmetry, which is deliberate and good: ANY victory (even Pyrrhic)
 * nullifies the enemy's control over you, but only an Immense Triumph grants
 * you one. That gives a losing player a cheap, achievable comeback goal
 * instead of a spiral.
 */
function resolveControlState(attackType, victoryType, currentEnemyControl) {
  const result = { gained: null, nullified: null };

  const mapping = {
    ground_battle: 'ground_control',
    airstrike: 'air_superiority',
    naval_battle: 'blockade',
  };
  const state = mapping[attackType];
  if (!state) return result;

  if (victoryType === C.COMBAT.VICTORY_TYPE.IMMENSE_TRIUMPH) {
    result.gained = state;
  }
  if (victoryType > 0 && currentEnemyControl === state) {
    result.nullified = state;
  }
  return result;
}

// ============================================================================
// IMPROVEMENT DESTRUCTION
// ============================================================================

/** 10% chance on an Immense Triumph only. */
function rollImprovementDestruction(city, victoryType, rng) {
  if (victoryType !== C.COMBAT.VICTORY_TYPE.IMMENSE_TRIUMPH) return null;
  if (rng() > C.COMBAT.IMPROVEMENT_DESTROY_CHANCE) return null;

  const built = Object.entries(city.improvements || {}).filter(([, n]) => n > 0);
  if (built.length === 0) return null;

  const [key] = built[Math.floor(rng() * built.length)];
  return key;
}

// ============================================================================
// BATTLE RESOLUTION
// ============================================================================

/**
 * Pick the defender's highest-infrastructure city — damage always lands there.
 */
function selectTargetCity(cities) {
  if (!Array.isArray(cities) || cities.length === 0) return null;
  return cities.reduce((best, c) => (c.infrastructure > best.infrastructure ? c : best), cities[0]);
}

/**
 * Ground battle.
 *
 * @param {Object} params
 *   attacker: { units, stockpile, policy }
 *   defender: { units, stockpile, policy, cities, money, population, fortified, controlState }
 *   opts: { warType, rng, currentMap, targetCity }
 * @returns a RESULT DESCRIPTION — nothing is mutated
 */
function groundBattle(params) {
  const { attacker, defender, opts = {} } = params;
  const rng = opts.rng || Math.random;

  // --- MAP gate ---
  const mapCheck = military.canPerformAction(opts.currentMap ?? Infinity, 'ground_battle');
  if (!mapCheck.ok) {
    return { ok: false, reason: `Need ${mapCheck.cost} MAP, short by ${mapCheck.shortfall}` };
  }

  // --- Supply, then strength ---
  const atkSupply = military.computeSupply(attacker.units, attacker.stockpile || {});
  const defSupply = military.computeSupply(defender.units, defender.stockpile || {});

  const atkValue = military.armyValue(atkSupply, {
    airSuperiorityAgainst: defender.controlState === 'air_superiority',
  });
  const defValue = military.armyValue(defSupply, {
    defenderPopulation: defender.population,
    airSuperiorityAgainst: attacker.controlState === 'air_superiority',
  });

  // --- Roll ---
  const battle = rollBattle(atkValue, defValue, rng);
  const mods = resolveModifiers({
    warType: opts.warType,
    attackerPolicy: attacker.policy,
    defenderPolicy: defender.policy,
    defenderFortified: defender.fortified,
  });

  // --- Damage ---
  const targetCity = opts.targetCity || selectTargetCity(defender.cities);
  let infraDestroyed = 0;
  let improvementDestroyed = null;

  if (targetCity && battle.victoryType > 0) {
    infraDestroyed = groundInfraDamage(
      { soldiers: atkSupply.armedSoldiers + atkSupply.unarmedSoldiers, tanks: atkSupply.suppliedTanks },
      { soldiers: defSupply.armedSoldiers + defSupply.unarmedSoldiers, tanks: defSupply.suppliedTanks },
      battle.victoryType, targetCity.infrastructure, rng, mods.infraDamage
    );
    infraDestroyed = Math.min(infraDestroyed, targetCity.infrastructure);
    improvementDestroyed = rollImprovementDestruction(targetCity, battle.victoryType, rng);
  }

  // --- Casualties: unsupplied units included at full rate ---
  const attackerCasualties = computeCasualties(
    attacker.units, atkValue, defValue, battle.victoryType, rng, mods.casualtiesTaken
  );
  const defenderCasualties = computeCasualties(
    defender.units, defValue, atkValue, C.COMBAT.ROLL_COUNT - battle.victoryType, rng, mods.casualtiesDealt
  );

  // --- Loot ---
  const loot = computeLoot(
    { soldiers: atkSupply.armedSoldiers + atkSupply.unarmedSoldiers, tanks: atkSupply.suppliedTanks },
    defender.money || 0, battle.victoryType, rng, mods.loot
  );

  return {
    ok: true,
    type: 'ground_battle',
    victoryType: battle.victoryType,
    victoryName: victoryName(battle.victoryType),
    rolls: battle.rolls,
    attackerValue: round2(atkValue),
    defenderValue: round2(defValue),
    mapCost: mapCheck.cost,
    resistanceLoss: round2(resistanceLoss('ground_battle', battle.victoryType)),
    infraDestroyed: round2(infraDestroyed),
    targetCity: targetCity ? targetCity.name : null,
    improvementDestroyed,
    attackerCasualties,
    defenderCasualties,
    loot,
    control: resolveControlState('ground_battle', battle.victoryType, defender.controlState),
    supply: { attacker: atkSupply, defender: defSupply },
    consumption: { attacker: atkSupply.consumption, defender: defSupply.consumption },
  };
}

/**
 * Airstrike. Aircraft contest aircraft; a win grants Air Superiority, which
 * halves the enemy's tank value in every subsequent ground battle.
 *
 * `target` selects what the strike aims at: 'infrastructure' does full damage,
 * anything else (soldiers/tanks/aircraft/ships) destroys units and does 1/3
 * collateral infra damage.
 */
function airStrike(params) {
  const { attacker, defender, opts = {} } = params;
  const rng = opts.rng || Math.random;
  const target = opts.target || 'infrastructure';

  const mapCheck = military.canPerformAction(opts.currentMap ?? Infinity, 'airstrike');
  if (!mapCheck.ok) {
    return { ok: false, reason: `Need ${mapCheck.cost} MAP, short by ${mapCheck.shortfall}` };
  }

  const atkSupply = military.computeSupply(attacker.units, attacker.stockpile || {});
  const defSupply = military.computeSupply(defender.units, defender.stockpile || {});

  const atkValue = military.airforceValue(atkSupply);
  const defValue = military.airforceValue(defSupply);

  const battle = rollBattle(atkValue, defValue, rng);
  const mods = resolveModifiers({
    warType: opts.warType,
    attackerPolicy: attacker.policy,
    defenderPolicy: defender.policy,
    defenderFortified: defender.fortified,
  });

  const targetCity = opts.targetCity || selectTargetCity(defender.cities);
  let infraDestroyed = 0;
  if (targetCity && battle.victoryType > 0) {
    infraDestroyed = airInfraDamage(
      atkSupply.suppliedAircraft, defSupply.suppliedAircraft,
      battle.victoryType, targetCity.infrastructure, rng, mods.infraDamage,
      target === 'infrastructure'
    );
    infraDestroyed = Math.min(infraDestroyed, targetCity.infrastructure);
  }

  const attackerCasualties = computeCasualties(
    { aircraft: attacker.units.aircraft }, atkValue, defValue,
    battle.victoryType, rng, mods.casualtiesTaken
  );
  const defenderCasualties = computeCasualties(
    { aircraft: defender.units.aircraft }, defValue, atkValue,
    C.COMBAT.ROLL_COUNT - battle.victoryType, rng, mods.casualtiesDealt
  );

  // Strikes aimed at a unit class destroy some of it outright.
  const unitsDestroyed = {};
  if (target !== 'infrastructure' && battle.victoryType > 0) {
    const rate = C.COMBAT.CASUALTY_BASE_RATE * victoryScale(battle.victoryType) * 2; // PLACEHOLDER
    unitsDestroyed[target] = Math.floor((defender.units[target] || 0) * rate);
  }

  return {
    ok: true,
    type: 'airstrike',
    target,
    victoryType: battle.victoryType,
    victoryName: victoryName(battle.victoryType),
    rolls: battle.rolls,
    attackerValue: round2(atkValue),
    defenderValue: round2(defValue),
    mapCost: mapCheck.cost,
    resistanceLoss: round2(resistanceLoss('airstrike', battle.victoryType)),
    infraDestroyed: round2(infraDestroyed),
    targetCity: targetCity ? targetCity.name : null,
    attackerCasualties,
    defenderCasualties,
    unitsDestroyed,
    loot: 0,
    control: resolveControlState('airstrike', battle.victoryType, defender.controlState),
    supply: { attacker: atkSupply, defender: defSupply },
  };
}

/**
 * Naval battle. A win grants Blockade, which stops the target moving money or
 * resources in or out — the economic-strangulation win condition.
 *
 * ⚠️ NAVAL_INFRA_COEFF is a PLACEHOLDER; P&W's naval damage formula is not
 * sourced. Structure follows the shared damage shape.
 */
function navalBattle(params) {
  const { attacker, defender, opts = {} } = params;
  const rng = opts.rng || Math.random;

  const mapCheck = military.canPerformAction(opts.currentMap ?? Infinity, 'naval_battle');
  if (!mapCheck.ok) {
    return { ok: false, reason: `Need ${mapCheck.cost} MAP, short by ${mapCheck.shortfall}` };
  }

  const atkSupply = military.computeSupply(attacker.units, attacker.stockpile || {});
  const defSupply = military.computeSupply(defender.units, defender.stockpile || {});

  const atkValue = military.navalValue(atkSupply);
  const defValue = military.navalValue(defSupply);

  const battle = rollBattle(atkValue, defValue, rng);
  const mods = resolveModifiers({
    warType: opts.warType,
    attackerPolicy: attacker.policy,
    defenderPolicy: defender.policy,
    defenderFortified: defender.fortified,
  });

  const targetCity = opts.targetCity || selectTargetCity(defender.cities);
  let infraDestroyed = 0;
  if (targetCity && battle.victoryType > 0) {
    infraDestroyed = navalInfraDamage(
      atkSupply.suppliedShips, defSupply.suppliedShips,
      battle.victoryType, targetCity.infrastructure, rng, mods.infraDamage
    );
    infraDestroyed = Math.min(infraDestroyed, targetCity.infrastructure);
  }

  return {
    ok: true,
    type: 'naval_battle',
    victoryType: battle.victoryType,
    victoryName: victoryName(battle.victoryType),
    rolls: battle.rolls,
    attackerValue: round2(atkValue),
    defenderValue: round2(defValue),
    mapCost: mapCheck.cost,
    resistanceLoss: round2(resistanceLoss('naval_battle', battle.victoryType)),
    infraDestroyed: round2(infraDestroyed),
    targetCity: targetCity ? targetCity.name : null,
    attackerCasualties: computeCasualties(
      { ships: attacker.units.ships }, atkValue, defValue, battle.victoryType, rng, mods.casualtiesTaken),
    defenderCasualties: computeCasualties(
      { ships: defender.units.ships }, defValue, atkValue,
      C.COMBAT.ROLL_COUNT - battle.victoryType, rng, mods.casualtiesDealt),
    loot: 0,
    control: resolveControlState('naval_battle', battle.victoryType, defender.controlState),
    supply: { attacker: atkSupply, defender: defSupply },
  };
}

// ============================================================================
// VICTORY & BEIGE
// ============================================================================

/**
 * Apply a resistance loss and report whether the war has been won.
 * Fastest known route to zero in P&W: 5 naval + 3 ground Immense Triumphs.
 */
function applyResistance(currentResistance, loss) {
  assertNonNegative(currentResistance, 'currentResistance');
  const remaining = Math.max(currentResistance - loss, 0);
  return { resistance: round2(remaining), defeated: remaining <= 0 };
}

/**
 * What the loser forfeits when resistance hits zero.
 *
 * The alliance-bank loot is the part that makes wars POLITICAL rather than
 * merely personal — your alliance has a real stake in every fight you pick.
 */
function applyDefeat(loser, opts = {}) {
  const V = C.VICTORY;
  const warType = C.WAR_TYPES[opts.warType || 'ordinary'];

  const moneyLost = round2((loser.money || 0) * V.LOOT_MONEY_FRACTION * warType.loot);

  const resourcesLost = {};
  for (const [res, amount] of Object.entries(loser.stockpile || {})) {
    if (res === 'credits' && !V.CREDITS_LOOTABLE) continue;
    if (res === 'money') continue;
    resourcesLost[res] = round2(amount * V.LOOT_RESOURCE_FRACTION * warType.loot);
  }

  const infraLost = (loser.cities || []).map(c => ({
    name: c.name,
    lost: round2(c.infrastructure * V.INFRA_LOSS_FRACTION * warType.infraDamage),
  }));

  return {
    beigeDays: V.BEIGE_DURATION_DAYS,
    moneyLost,
    resourcesLost,
    infraLost,
    allianceBankLooted: V.LOOTS_ALLIANCE_BANK,
  };
}

/** Beige duration stacks with each war lost. */
function beigeTurnsRemaining(warsLost, turnsElapsed = 0) {
  const total = warsLost * C.VICTORY.BEIGE_DURATION_DAYS * C.TICK.TURNS_PER_DAY;
  return Math.max(total - turnsElapsed, 0);
}

// ============================================================================
// SIMULATOR — for balance work and UI odds
// ============================================================================

/**
 * Monte-Carlo the roll system to get real odds for a strength ratio.
 *
 * Use this two ways:
 *   1. Show players their odds before they commit MAP and munitions. P&W hides
 *      this entirely and players resort to external spreadsheets.
 *   2. Re-run it whenever you touch ROLL_MIN_FRACTION, to see what the change
 *      actually did to the shape of combat.
 */
function battleOdds(attackerValue, defenderValue, iterations = 10000, seed = 12345) {
  const rng = makeRng(seed);
  const counts = [0, 0, 0, 0];

  for (let i = 0; i < iterations; i++) {
    counts[rollBattle(attackerValue, defenderValue, rng).victoryType]++;
  }

  const pct = counts.map(c => c / iterations);
  return {
    utterFailure: pct[0],
    pyrrhicVictory: pct[1],
    moderateSuccess: pct[2],
    immenseTriumph: pct[3],
    anyVictory: 1 - pct[0],
    expectedVictoryType: pct.reduce((sum, p, i) => sum + p * i, 0),
    ratio: defenderValue > 0 ? attackerValue / defenderValue : Infinity,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // rng
  makeRng,

  // rolls
  rollBattle,
  victoryName,
  victoryScale,

  // modifiers
  resolveModifiers,

  // damage
  infraDamageCap,
  groundInfraDamage,
  airInfraDamage,
  navalInfraDamage,

  // casualties & loot
  computeCasualties,
  computeLoot,

  // resistance & control
  resistanceLoss,
  resolveControlState,
  rollImprovementDestruction,
  selectTargetCity,

  // battles
  groundBattle,
  airStrike,
  navalBattle,

  // victory
  applyResistance,
  applyDefeat,
  beigeTurnsRemaining,

  // analysis
  battleOdds,
};
