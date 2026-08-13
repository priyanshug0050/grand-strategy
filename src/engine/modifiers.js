/**
 * ============================================================================
 *  PART 7a of 7 — modifiers.js
 * ============================================================================
 *  Espionage, projects, policies, color trade blocs, and alliance tax.
 *
 *  Pure functions. No database, no side effects.
 *
 *  ---------------------------------------------------------------------------
 *  THE DESIGN RULE THIS FILE ENFORCES
 *  ---------------------------------------------------------------------------
 *  Every project is a COEFFICIENT on an existing formula, never a new system.
 *  That is how P&W supports ~30 projects without the codebase exploding, and
 *  it is why aggregateProjectEffects() below can collapse the entire project
 *  list into one flat object that the other six modules already know how to
 *  consume. If a project you want to add needs its own table, redesign it.
 *
 *  Same discipline for policies: every one is a STRICT TRADEOFF. If you cannot
 *  name what a policy costs the player, it is not finished.
 * ============================================================================
 */

'use strict';

const C = require('./constants');
const policy = require('./policy');

function assertNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got: ${value}`);
  }
  if (value < 0) throw new RangeError(`${name} must be >= 0, got: ${value}`);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

// ============================================================================
// ESPIONAGE
// ============================================================================

/**
 * A clean opposed check:
 *
 *   odds = (safetyLevel * 25) + (yourSpies * 100) / ((enemySpies * 3) + 1)
 *   final = odds / operationModifier
 *
 * Three things are being balanced at once: your spy count, their spy count
 * (weighted 3x, so defence is cheap), and how valuable the target is. Sabotage
 * a nuke and you divide your odds by 5.
 *
 * @returns {number} success probability as a percentage, clamped 0-100
 */
function espionageOdds(yourSpies, enemySpies, safetyLevel, operation, opts = {}) {
  assertNonNegative(yourSpies, 'yourSpies');
  assertNonNegative(enemySpies, 'enemySpies');

  const E = C.ESPIONAGE;
  const safety = typeof safetyLevel === 'string' ? E.SAFETY_LEVELS[safetyLevel] : safetyLevel;
  if (!safety || safety < 1 || safety > 3) {
    throw new Error(`Invalid safety level: ${safetyLevel}`);
  }

  const modifier = E.OPERATION_MODIFIER[operation];
  if (modifier === undefined) throw new Error(`Unknown espionage operation: ${operation}`);

  let odds = (safety * E.SAFETY_MULTIPLIER)
           + (yourSpies * E.SPY_NUMERATOR) / ((enemySpies * E.ENEMY_SPY_MULTIPLIER) + E.ENEMY_SPY_CONSTANT);

  odds /= modifier;

  // Military policy. Deep Cover raises the attacker's odds; a defender running
  // it makes itself harder to reach, so the same coefficient works both ways.
  odds *= policy.policyEffects({ military: opts.attackerPolicy }).effects.espionageOddsMultiplier;
  odds /= policy.policyEffects({ military: opts.defenderPolicy }).effects.espionageOddsMultiplier;

  return clamp(odds, 0, 100);
}

/**
 * Resolve an espionage attempt.
 * Higher safety improves odds AND reduces the chance of being identified —
 * so the "quick and dirty" option is genuinely a gamble, not just slower.
 */
function resolveEspionage(yourSpies, enemySpies, safetyLevel, operation, opts = {}) {
  const rng = opts.rng || Math.random;
  const odds = espionageOdds(yourSpies, enemySpies, safetyLevel, operation, opts);
  const safety = typeof safetyLevel === 'string'
    ? C.ESPIONAGE.SAFETY_LEVELS[safetyLevel]
    : safetyLevel;

  const success = rng() * 100 < odds;

  // Detection: identity revealed more often at low safety. PLACEHOLDER curve.
  const detectionChance = success ? (4 - safety) * 10 : (4 - safety) * 25;
  const detected = rng() * 100 < detectionChance;

  // Failed operations cost spies.
  const spiesLost = success ? 0 : Math.ceil(yourSpies * 0.25 * rng());

  return { success, detected, odds: round2(odds), spiesLost, operation, safetyLevel: safety };
}

function maxSpies(projects = []) {
  return projects.includes('intelligence_agency')
    ? C.ESPIONAGE.MAX_SPIES_WITH_AGENCY
    : C.ESPIONAGE.MAX_SPIES;
}

// ============================================================================
// PROJECTS
// ============================================================================

/**
 * Collapse a nation's project list into one flat effect object.
 *
 * This is the function that makes the "projects are coefficients" rule pay off:
 * the other six modules never need to know which projects exist, only what
 * multipliers came out the other side.
 */
function aggregateProjectEffects(projects = []) {
  const effects = {
    productionBonus: {},
    infraCostMultiplier: 1,
    cityCostDiscount: 0,
    manufacturingPollutionMultiplier: 1,
    farmPollutionMultiplier: 1,
    resourceUpkeepMultiplier: 1,
    nukeDamageMultiplier: 1,
    falloutDurationMultiplier: 1,
    domesticPolicyBonus: 0,
    commerceMax: C.ECONOMY.COMMERCE_MAX,
    offensiveWarSlots: C.COMBAT.OFFENSIVE_WAR_SLOTS,
    maxSpiesBonus: 0,
    salvageFraction: 0,
    militaryRecruitmentBonus: 0,
    farmLandDivisor: C.FARM.LAND_DIVISOR_PER_TURN,
    unlocks: [],
    unknown: [],
  };

  for (const key of projects) {
    const proj = C.PROJECTS[key];
    if (!proj) { effects.unknown.push(key); continue; }
    const e = proj.effect || {};

    if (e.productionBonus) {
      for (const [res, bonus] of Object.entries(e.productionBonus)) {
        effects.productionBonus[res] = (effects.productionBonus[res] || 0) + bonus;
      }
    }
    if (e.infraCostMultiplier) effects.infraCostMultiplier *= e.infraCostMultiplier;
    if (e.cityCostDiscount) effects.cityCostDiscount += e.cityCostDiscount;
    if (e.manufacturingPollutionMultiplier) effects.manufacturingPollutionMultiplier *= e.manufacturingPollutionMultiplier;
    if (e.farmPollutionMultiplier) effects.farmPollutionMultiplier *= e.farmPollutionMultiplier;
    if (e.resourceUpkeepMultiplier) effects.resourceUpkeepMultiplier *= e.resourceUpkeepMultiplier;
    if (e.nukeDamageMultiplier) effects.nukeDamageMultiplier *= e.nukeDamageMultiplier;
    if (e.falloutDurationMultiplier) effects.falloutDurationMultiplier *= e.falloutDurationMultiplier;
    if (e.domesticPolicyBonus) effects.domesticPolicyBonus += e.domesticPolicyBonus;
    if (e.commerceMax) effects.commerceMax = Math.max(effects.commerceMax, e.commerceMax);
    if (e.offensiveWarSlots) effects.offensiveWarSlots = Math.max(effects.offensiveWarSlots, e.offensiveWarSlots);
    if (e.maxSpiesBonus) effects.maxSpiesBonus += e.maxSpiesBonus;
    if (e.salvageFraction) effects.salvageFraction += e.salvageFraction;
    if (e.militaryRecruitmentBonus) effects.militaryRecruitmentBonus += e.militaryRecruitmentBonus;
    if (e.farmLandDivisor) effects.farmLandDivisor = Math.min(effects.farmLandDivisor, e.farmLandDivisor);
    if (e.unlocks) effects.unlocks.push(e.unlocks);
  }

  return effects;
}

function projectScore(projects = []) {
  return projects.length * C.PROJECT_SCORE_VALUE;
}

/**
 * Projects are permanent and one-time. Attempting to rebuild one is almost
 * always a UI bug rather than a player action, so it gets its own reason.
 */
function canBuildProject(nation, projectKey, stockpile = {}) {
  const proj = C.PROJECTS[projectKey];
  if (!proj) return { ok: false, reason: `Unknown project: ${projectKey}` };

  const owned = nation.projects || [];
  if (owned.includes(projectKey)) {
    return { ok: false, reason: 'Already built — projects are permanent and one-time' };
  }

  const missing = {};
  let affordable = true;
  for (const [res, needed] of Object.entries(proj.cost || {})) {
    const have = stockpile[res] || 0;
    if (have < needed) { missing[res] = needed - have; affordable = false; }
  }
  if (!affordable) {
    const shortfall = Object.entries(missing).map(([r, n]) => `${round2(n)} ${r}`).join(', ');
    return { ok: false, reason: `Insufficient resources: short ${shortfall}`, missing };
  }

  return { ok: true, cost: proj.cost };
}

// ============================================================================
// POLICIES
// ============================================================================

/**
 * Domestic policy effects, amplified by Government Support Agency / Bureau of
 * Domestic Affairs (each adds +50% to the policy's strength).
 */
function domesticPolicyEffects(policyKey, projects = []) {
  if (!policyKey) return {};
  const policy = C.DOMESTIC_POLICIES[policyKey];
  if (!policy) throw new Error(`Unknown domestic policy: ${policyKey}`);

  const amplification = aggregateProjectEffects(projects).domesticPolicyBonus;
  if (amplification === 0) return { ...policy };

  const amplified = {};
  for (const [key, value] of Object.entries(policy)) {
    // Multipliers are expressed relative to 1.0; amplify the deviation.
    const deviation = value - 1;
    amplified[key] = 1 + deviation * (1 + amplification);
  }
  return amplified;
}

function warPolicyEffects(policyKey) {
  if (!policyKey) return {};
  const policy = C.WAR_POLICIES[policyKey];
  if (!policy) throw new Error(`Unknown war policy: ${policyKey}`);
  return { ...policy };
}

/**
 * Cooldown check. Policies are cheap to switch in principle, which is why the
 * cooldown exists — without it, players would swap to Turtle the moment they
 * were attacked and Attrition the moment they attacked, and the tradeoffs
 * would mean nothing.
 */
function canChangePolicy(type, lastChangedTurn, currentTurn) {
  assertNonNegative(currentTurn, 'currentTurn');
  if (lastChangedTurn === null || lastChangedTurn === undefined) return { ok: true };
  assertNonNegative(lastChangedTurn, 'lastChangedTurn');

  const days = type === 'war' ? C.POLICY_COOLDOWN.WAR_DAYS : C.POLICY_COOLDOWN.DOMESTIC_DAYS;
  const requiredTurns = days * C.TICK.TURNS_PER_DAY;
  const elapsed = currentTurn - lastChangedTurn;

  if (elapsed < requiredTurns) {
    return {
      ok: false,
      reason: `${type} policy locked for ${days} days after a change`,
      turnsRemaining: requiredTurns - elapsed,
    };
  }
  return { ok: true };
}

// ============================================================================
// COLOR TRADE BLOCS
// ============================================================================

/**
 * A coordination bonus that gives alliances a purely economic reason to exist
 * beyond mutual defence, and makes the political map readable at a glance.
 * Very low implementation cost, very high metagame payoff.
 *
 * @returns {number} flat money bonus per turn
 */
function colorBlocBonus(nationColor, allianceColor, opts = {}) {
  if (nationColor === 'beige') return C.COLORS.BEIGE.perTurnBonus;
  if (nationColor === 'gray') return C.COLORS.GRAY.perTurnBonus;

  if (!allianceColor) return 0;                    // unaligned earns nothing
  if (nationColor !== allianceColor) return 0;     // mismatch earns nothing

  return opts.blocBonus !== undefined ? opts.blocBonus : C.COLORS.DEFAULT_BLOC_BONUS;
}

/**
 * The beige/gray state machine.
 *
 * Beige is a protective state — immune to NEW declarations while existing wars
 * continue — that a nation enters on creation or after losing, and can never
 * return to once left. Gray is the opposite: no bonus, no tax, excluded from
 * total score, and deliberately juicy as a raid target.
 */
function resolveColorState(nation, currentTurn) {
  const beigeUntil = nation.beigeUntilTurn ?? 0;
  if (currentTurn < beigeUntil) {
    return {
      color: 'beige',
      immuneToNewDeclarations: true,
      exemptFromAllianceTax: C.COLORS.BEIGE.exemptFromAllianceTax,
      countsTowardTotalScore: C.COLORS.BEIGE.countsTowardTotalScore,
      turnsRemaining: beigeUntil - currentTurn,
    };
  }

  // ⚠️ MUST use ?? not || here. Turn 0 is a legitimate value, and `||` treats
  // it as missing — which silently made every nation created at turn 0 appear
  // permanently active, so inactivity never triggered gray. Same trap applies
  // to any turn-numbered field.
  const lastActive = nation.lastActiveTurn ?? currentTurn;
  const idleTurns = currentTurn - lastActive;
  const inactivityTurns = C.COLORS.GRAY.inactivityDays * C.TICK.TURNS_PER_DAY;
  if (idleTurns >= inactivityTurns) {
    return {
      color: 'gray',
      immuneToNewDeclarations: false,
      exemptFromAllianceTax: C.COLORS.GRAY.exemptFromAllianceTax,
      countsTowardTotalScore: C.COLORS.GRAY.countsTowardTotalScore,
      reason: 'inactive',
    };
  }

  // Beige is a ONE-WAY EXIT. If the stored color is still 'beige' but the
  // protection turn has passed, the nation has left beige and cannot return —
  // fall through to gray until they pick a real color.
  //
  // Without this the color column stays 'beige' forever after expiry, so the
  // nation keeps the beige per-turn bonus, stays exempt from alliance tax, and
  // — worst of all — reads as immune to war declarations to any caller that
  // checks `.color` rather than `.immuneToNewDeclarations`. Permanently
  // unattackable, permanently untaxed, purely by not updating a column.
  if (nation.color === 'beige') {
    return {
      color: 'gray',
      immuneToNewDeclarations: false,
      exemptFromAllianceTax: C.COLORS.GRAY.exemptFromAllianceTax,
      countsTowardTotalScore: C.COLORS.GRAY.countsTowardTotalScore,
      reason: 'beige_expired',
    };
  }

  return {
    color: nation.color || 'gray',
    immuneToNewDeclarations: false,
    exemptFromAllianceTax: false,
    countsTowardTotalScore: true,
  };
}

function canChangeColorBloc(lastChangedTurn, currentTurn) {
  if (lastChangedTurn === null || lastChangedTurn === undefined) return { ok: true };
  const elapsed = currentTurn - lastChangedTurn;
  const required = C.COLORS.BLOC_CHANGE_COOLDOWN_TURNS;
  if (elapsed < required) {
    return { ok: false, reason: 'Color bloc locked after a change', turnsRemaining: required - elapsed };
  }
  return { ok: true };
}

/** Beige duration from wars lost, in turns. Stacks. */
function beigeUntilTurn(currentTurn, warsLost = 1) {
  return currentTurn + warsLost * C.VICTORY.BEIGE_DURATION_DAYS * C.TICK.TURNS_PER_DAY;
}

// ============================================================================
// ALLIANCE TAX
// ============================================================================

/**
 * Collected EVERY TURN on both income and resource production.
 *
 * The bank plus this tax is what makes alliances institutions rather than chat
 * groups — real assets to steward, real defection risk, real internal politics.
 * It is also the number one abuse surface, which is why the seniority
 * requirement exists.
 */
function collectAllianceTax(nation, taxRates, opts = {}) {
  const colorState = opts.colorState || resolveColorState(nation, opts.currentTurn || 0);

  if (colorState.exemptFromAllianceTax) {
    return { money: 0, resources: {}, exempt: true, reason: `${colorState.color} nations are exempt` };
  }

  const seniorityTurns = C.ALLIANCE.TAX_SENIORITY_DAYS * C.TICK.TURNS_PER_DAY;
  const memberFor = (opts.currentTurn ?? 0) - (nation.joinedAllianceTurn ?? 0);
  if (memberFor < seniorityTurns) {
    return {
      money: 0, resources: {}, exempt: true,
      reason: `Requires ${C.ALLIANCE.TAX_SENIORITY_DAYS} days of alliance seniority`,
    };
  }

  const moneyRate = clamp(taxRates.money || 0, 0, 1);
  const resourceRate = clamp(taxRates.resources || 0, 0, 1);

  const money = round2((opts.incomeThisTurn || 0) * moneyRate);
  const resources = {};
  for (const [res, amount] of Object.entries(opts.productionThisTurn || {})) {
    if (res === 'money' || res === 'credits') continue;
    if (amount > 0) resources[res] = round2(amount * resourceRate);
  }

  return { money, resources, exempt: false };
}

// ============================================================================
// RADIATION
// ============================================================================

/** Dissipates linearly over 100 turns. Fallout Shelter shortens the tail. */
function decayRadiation(currentRadiation, turnsElapsed = 1, projects = []) {
  assertNonNegative(currentRadiation, 'currentRadiation');
  const effects = aggregateProjectEffects(projects);
  const duration = C.RADIATION.DISSIPATION_TURNS * effects.falloutDurationMultiplier;
  const perTurn = C.RADIATION.PER_NUKE_CONTINENT / duration;
  return Math.max(currentRadiation - perTurn * turnsElapsed, 0);
}

/**
 * Radiation is the cleverest bit of design in P&W: the whole world pays for
 * one nation's nuke. That is what creates real diplomatic pressure against
 * their use, rather than relying on a rule that says "don't".
 */
function addNukeRadiation(continentRadiation, globalRadiation) {
  return {
    continent: continentRadiation + C.RADIATION.PER_NUKE_CONTINENT,
    global: globalRadiation + C.RADIATION.PER_NUKE_GLOBAL,
  };
}

module.exports = {
  espionageOdds,
  resolveEspionage,
  maxSpies,

  aggregateProjectEffects,
  projectScore,
  canBuildProject,

  domesticPolicyEffects,
  warPolicyEffects,
  canChangePolicy,

  colorBlocBonus,
  resolveColorState,
  canChangeColorBloc,
  beigeUntilTurn,

  collectAllianceTax,

  decayRadiation,
  addNukeRadiation,
};
