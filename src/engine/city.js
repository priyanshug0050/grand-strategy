/**
 * ============================================================================
 *  PART 2 of 7 — city.js
 * ============================================================================
 *  Cost curves, improvement slots, and purchase validation.
 *
 *  Pure functions only. No database, no Express, no side effects.
 *  Every number comes from constants.js — nothing is hardcoded here.
 *
 *  This module owns the three nonlinearities that generate all of the game's
 *  strategic depth:
 *      1. Infrastructure cost — exponent 2.2
 *      2. Land cost          — quadratic
 *      3. New city cost      — cubic
 *  Everything else in the engine is linear. Change these curves and you change
 *  the entire pacing of the game.
 * ============================================================================
 */

'use strict';

const C = require('./constants');
const policy = require('./policy');

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Money is stored as a float but must never be handed out with sub-cent
 * precision — floating point drift in a loop compounds into free money.
 * Every cost function terminates in this.
 */
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function assertFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got: ${value}`);
  }
}

function assertNonNegative(value, name) {
  assertFiniteNumber(value, name);
  if (value < 0) {
    throw new RangeError(`${name} must be >= 0, got: ${value}`);
  }
}

// ============================================================================
// IMPROVEMENT SLOTS
// ============================================================================

/**
 * The 50:1 ratio is the economic spine of the entire game. Infrastructure is
 * not just population — it is the permission to build anything at all.
 *
 * @param {number} infrastructure
 * @returns {number} whole improvement slots available
 */
function improvementSlots(infrastructure) {
  assertNonNegative(infrastructure, 'infrastructure');
  return Math.floor(infrastructure / C.CITY.INFRA_PER_IMPROVEMENT_SLOT);
}

/**
 * @param {Object} improvements  map of improvementKey -> count
 * @returns {number} total slots consumed
 */
function usedImprovementSlots(improvements) {
  if (!improvements || typeof improvements !== 'object') return 0;
  let total = 0;
  for (const [key, count] of Object.entries(improvements)) {
    if (!C.IMPROVEMENTS[key]) {
      throw new Error(`Unknown improvement: ${key}`);
    }
    assertNonNegative(count, `improvements.${key}`);
    total += count;
  }
  return total;
}

function availableImprovementSlots(city) {
  return improvementSlots(city.infrastructure) - usedImprovementSlots(city.improvements);
}

/**
 * Full build check: does the improvement exist, is there a free slot, and is
 * the per-city cap respected?
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function canBuildImprovement(city, improvementKey, count = 1, opts = {}) {
  const def = C.IMPROVEMENTS[improvementKey];
  if (!def) return { ok: false, reason: `Unknown improvement: ${improvementKey}` };
  assertNonNegative(count, 'count');
  if (count === 0) return { ok: false, reason: 'Count must be at least 1' };

  const current = (city.improvements && city.improvements[improvementKey]) || 0;

  if (def.limit !== undefined && current + count > def.limit) {
    return {
      ok: false,
      reason: `Per-city limit for ${improvementKey} is ${def.limit} (have ${current})`,
    };
  }

  const free = availableImprovementSlots(city);
  if (count > free) {
    return {
      ok: false,
      reason: `Needs ${count} improvement slot(s), only ${free} free. ` +
              `Buy ${(count - free) * C.CITY.INFRA_PER_IMPROVEMENT_SLOT} more infrastructure.`,
    };
  }

  // Materials, if a stockpile was supplied. Callers that only want to know
  // "is there room for this?" can omit it — the cities page does that to grey
  // out buttons before the player has committed to a quantity.
  if (opts.stockpile) {
    const cost = improvementCost(improvementKey, count, opts);
    const missing = {};
    let short = false;

    for (const [resource, needed] of Object.entries(cost.materials)) {
      const have = opts.stockpile[resource] || 0;
      if (have < needed) { missing[resource] = round2(needed - have); short = true; }
    }
    if (short) {
      const list = Object.entries(missing).map(([r, n]) => `${n} ${r}`).join(', ');
      return {
        ok: false,
        reason: `Not enough materials — short ${list}. Refine them or buy on the market.`,
        missing,
        cost,
      };
    }
  }

  return { ok: true, cost: improvementCost(improvementKey, count, opts) };
}

/**
 * What one or more of an improvement costs, in money AND materials.
 *
 * Commerce, civil and military buildings consume refined goods. That is what
 * gives steel and aluminum a use inside your own borders — without it a nation
 * could refine endlessly and have nothing to spend the output on, and a rich
 * player could skip industry entirely.
 *
 * Raw and manufacturing buildings have no material cost by design: a steel
 * mill that needs steel is a trap a new player can never climb out of.
 */
function improvementCost(improvementKey, count = 1, opts = {}) {
  const def = C.IMPROVEMENTS[improvementKey];
  if (!def) throw new Error(`Unknown improvement: ${improvementKey}`);
  assertNonNegative(count, 'count');

  const materialMultiplier = policyMultiplier(opts, 'materialCostMultiplier');

  const materials = {};
  for (const [resource, amount] of Object.entries(def.materials || {})) {
    materials[resource] = round2(amount * count * materialMultiplier);
  }

  return {
    money: round2(def.cost * count),
    materials,
    // True when this building needs nothing but cash — useful for the UI,
    // which shows a simpler line in that case.
    moneyOnly: Object.keys(materials).length === 0,
  };
}

// ============================================================================
// INFRASTRUCTURE COST
// ============================================================================

/**
 * Marginal cost of ONE unit of infrastructure at the current level.
 *
 *   unitCost = BASE + ((currentInfra - OFFSET) ^ EXPONENT) / DIVISOR
 *
 * Quirk worth preserving: because of the OFFSET, the cheapest infrastructure
 * in the game is NOT at zero. Below the offset the power term would go
 * imaginary, so it is floored at zero.
 */
function infraUnitCost(currentInfra) {
  assertNonNegative(currentInfra, 'currentInfra');
  const { INFRA_BASE_COST, INFRA_OFFSET, INFRA_EXPONENT, INFRA_DIVISOR } = C.CITY;
  const adjusted = Math.max(currentInfra - INFRA_OFFSET, 0);
  return INFRA_BASE_COST + Math.pow(adjusted, INFRA_EXPONENT) / INFRA_DIVISOR;
}

/**
 * Cost to raise infrastructure from `from` to `to`.
 *
 * PRICING MODEL — read this, it is a design decision, not a transcription:
 * Unit price is held constant within each bracket, fixed at the bracket's
 * floor. This is what makes buying in multiples of 100 efficient and buying
 * 250 wasteful — the standard advice in every P&W guide. A purely continuous
 * per-unit integral would make bracket alignment meaningless.
 *
 * If you later confirm P&W integrates continuously instead, swap the loop for
 * a definite integral; the signature does not change.
 *
 * @param {number} from   current infrastructure
 * @param {number} to     target infrastructure
 * @param {Object} [opts] { projects: string[], policies: {domestic?: string} }
 * @returns {number} total cost in $
 */
function infraPurchaseCost(from, to, opts = {}) {
  assertNonNegative(from, 'from');
  assertNonNegative(to, 'to');
  if (to <= from) return 0;

  const bracket = C.CITY.INFRA_PURCHASE_BRACKET;
  let total = 0;
  let cursor = from;

  while (cursor < to) {
    // Floor of the bracket the cursor currently sits in.
    const bracketFloor = Math.floor(cursor / bracket) * bracket;
    const bracketCeil = bracketFloor + bracket;
    const segmentEnd = Math.min(bracketCeil, to);
    const unitsInSegment = segmentEnd - cursor;

    total += unitsInSegment * infraUnitCost(bracketFloor);
    cursor = segmentEnd;
  }

  return round2(applyInfraDiscounts(total, opts));
}

/**
 * Infrastructure discounts are MULTIPLICATIVE with each other.
 *   Center for Civil Engineering project: -5%
 *   Urbanization domestic policy:         -5%
 */
function applyInfraDiscounts(cost, opts = {}) {
  const projects = opts.projects || [];
  let multiplier = 1;

  if (projects.includes('center_for_civil_engineering')) {
    multiplier *= C.PROJECTS.center_for_civil_engineering.effect.infraCostMultiplier;
  }

  // Policy effects arrive as one flat object from policy.js. Nothing here
  // needs to know WHICH policy is running — only the coefficient it produced.
  multiplier *= policyMultiplier(opts, 'infraCostMultiplier');

  return cost * multiplier;
}

/**
 * Pull one coefficient out of the active policy set.
 *
 * Callers pass either a resolved `policyEffects` object (cheap, when they
 * already computed it) or the raw policy selection (convenient). Supporting
 * both keeps call sites short without recomputing on every cost lookup.
 */
function policyMultiplier(opts, key) {
  if (opts.policyEffects) return opts.policyEffects[key] ?? 1;
  if (!opts.policies) return 1;
  return policy.policyEffects(opts.policies, {
    amplification: policyAmplification(opts.projects),
  }).effects[key] ?? 1;
}

/** Projects that strengthen whatever policy you are running. */
function policyAmplification(projects = []) {
  let amp = 0;
  for (const key of projects) {
    const effect = C.PROJECTS[key]?.effect?.domesticPolicyBonus;
    if (effect) amp += effect;
  }
  return amp;
}

/**
 * Refund for selling infrastructure back down.
 * P&W's exact refund rate is unsourced; a partial refund is required or
 * players will pump infra up and down to launder value.
 */
function infraSellRefund(from, to, refundRate = 0.5) {  // PLACEHOLDER rate
  assertNonNegative(from, 'from');
  assertNonNegative(to, 'to');
  if (to >= from) return 0;
  // Price the band at its own cost, then refund a fraction.
  const bandCost = infraPurchaseCost(to, from);
  return round2(bandCost * refundRate);
}

// ============================================================================
// LAND COST
// ============================================================================

/**
 *   unitCost = BASE + COEFF * (currentLand - OFFSET) ^ 2
 */
function landUnitCost(currentLand) {
  assertNonNegative(currentLand, 'currentLand');
  const { LAND_BASE_COST, LAND_QUADRATIC_COEFF, LAND_OFFSET } = C.CITY;
  const adjusted = Math.max(currentLand - LAND_OFFSET, 0);
  return LAND_BASE_COST + LAND_QUADRATIC_COEFF * adjusted * adjusted;
}

/**
 * Land brackets are irregular: the first boundary is at 250 (cities spawn with
 * 250 land), and every boundary after that is a multiple of 500.
 *
 * So the ladder is: 0 -> 250 -> 500 -> 1000 -> 1500 -> 2000 ...
 */
function nextLandBracketBoundary(land) {
  const { LAND_FIRST_BRACKET, LAND_PURCHASE_BRACKET } = C.CITY;
  if (land < LAND_FIRST_BRACKET) return LAND_FIRST_BRACKET;
  if (land < LAND_PURCHASE_BRACKET) return LAND_PURCHASE_BRACKET;
  return (Math.floor(land / LAND_PURCHASE_BRACKET) + 1) * LAND_PURCHASE_BRACKET;
}

function currentLandBracketFloor(land) {
  const { LAND_FIRST_BRACKET, LAND_PURCHASE_BRACKET } = C.CITY;
  if (land < LAND_FIRST_BRACKET) return 0;
  if (land < LAND_PURCHASE_BRACKET) return LAND_FIRST_BRACKET;
  return Math.floor(land / LAND_PURCHASE_BRACKET) * LAND_PURCHASE_BRACKET;
}

/**
 * Cost to raise land from `from` to `to`, split across brackets exactly the
 * way the game splits it. A 250 -> 1000 purchase is charged as two
 * transactions: 250->500 priced at 250, and 500->1000 priced at 500.
 */
function landPurchaseCost(from, to, opts = {}) {
  assertNonNegative(from, 'from');
  assertNonNegative(to, 'to');
  if (to <= from) return 0;

  let total = 0;
  let cursor = from;
  let guard = 0;

  while (cursor < to) {
    if (++guard > 100000) throw new Error('landPurchaseCost: bracket loop failed to converge');

    const bracketFloor = currentLandBracketFloor(cursor);
    const boundary = nextLandBracketBoundary(cursor);
    const segmentEnd = Math.min(boundary, to);
    const unitsInSegment = segmentEnd - cursor;

    total += unitsInSegment * landUnitCost(bracketFloor);
    cursor = segmentEnd;
  }

  return round2(applyLandDiscounts(total, opts));
}

function applyLandDiscounts(cost, opts = {}) {
  return cost * policyMultiplier(opts, 'landCostMultiplier');
}

/**
 * Is this purchase bracket-aligned? Not an error if false — the player is
 * allowed to waste money. This exists so the UI can warn them.
 */
function isLandPurchaseEfficient(from, to) {
  if (to <= from) return true;
  return to === nextLandBracketBoundary(to - 1);
}

function isInfraPurchaseEfficient(from, to) {
  if (to <= from) return true;
  return to % C.CITY.INFRA_PURCHASE_BRACKET === 0;
}

// ============================================================================
// NEW CITY COST
// ============================================================================

/**
 * The cubic wall. This is the primary long-term money sink and the reason the
 * economy does not hyperinflate.
 *
 *   cost = CUBIC * (X-1)^3 + LINEAR * X + CONSTANT     where X = current count
 *
 * City 2 costs $225,000. City 30 costs tens of billions.
 *
 * DISCOUNT ORDER IS LOAD-BEARING AND A REAL BUG SOURCE:
 *   1. Flat project discounts (Urban Planning tiers) — these STACK
 *   2. THEN the Manifest Destiny percentage
 *   3. THEN floor at $1
 * Applying the percentage first would give a materially different (wrong)
 * answer. Do not reorder.
 *
 * @param {number} currentCityCount
 * @param {Object} [opts] { projects: string[], policies: {domestic?: string} }
 */
function nextCityCost(currentCityCount, opts = {}) {
  assertNonNegative(currentCityCount, 'currentCityCount');
  if (currentCityCount < 1) {
    throw new RangeError('currentCityCount must be at least 1 — every nation has a capital');
  }

  const X = currentCityCount;
  const { CITY_COST_CUBIC, CITY_COST_LINEAR, CITY_COST_CONSTANT, CITY_COST_FLOOR } = C.CITY;

  let cost = CITY_COST_CUBIC * Math.pow(X - 1, 3)
           + CITY_COST_LINEAR * X
           + CITY_COST_CONSTANT;

  // --- Step 1: flat project discounts, stacking ---
  const projects = opts.projects || [];
  for (const key of ['urban_planning', 'advanced_urban_planning', 'metropolitan_planning']) {
    if (projects.includes(key)) {
      cost -= C.PROJECTS[key].effect.cityCostDiscount;
    }
  }

  // --- Step 2: percentage policy discount, applied AFTER the flat ones ---
  //
  // Order still matters: applying the percentage first gives a materially
  // different (wrong) answer. See the comment above.
  cost *= policyMultiplier(opts, 'cityCostMultiplier');

  // --- Step 3: floor ---
  return round2(Math.max(cost, CITY_COST_FLOOR));
}

/**
 * City purchase gating. The first N cities are free of any timer; past that a
 * cooldown applies, measured in turns.
 *
 * @param {number} currentCityCount
 * @param {number|null} lastCityTurn  turn number of the last city built/deleted
 * @param {number} currentTurn
 * @returns {{ok: boolean, reason?: string, turnsRemaining?: number}}
 */
function canPurchaseCity(currentCityCount, lastCityTurn, currentTurn) {
  assertNonNegative(currentCityCount, 'currentCityCount');
  assertNonNegative(currentTurn, 'currentTurn');

  if (currentCityCount < C.CITY.FREE_CITY_COUNT) {
    return { ok: true };
  }

  if (lastCityTurn === null || lastCityTurn === undefined) {
    return { ok: true };
  }

  assertNonNegative(lastCityTurn, 'lastCityTurn');
  const elapsed = currentTurn - lastCityTurn;
  const required = C.CITY.CITY_COOLDOWN_TURNS;

  if (elapsed < required) {
    return {
      ok: false,
      reason: `City cooldown active past ${C.CITY.FREE_CITY_COUNT} cities`,
      turnsRemaining: required - elapsed,
    };
  }

  return { ok: true };
}

// ============================================================================
// CITY FACTORY & VALIDATION
// ============================================================================

/**
 * A city is exactly three things: infrastructure, land, and a bag of
 * improvements. Everything else about it is derived, never stored.
 * Keeping derived values out of the row is what prevents state drift.
 */
function createCity(name, continent, foundedTurn) {
  if (!C.CONTINENTS[continent]) {
    throw new Error(`Unknown continent: ${continent}`);
  }
  return {
    name,
    continent,
    foundedTurn,
    infrastructure: C.CITY.STARTING_INFRA,
    land: C.CITY.STARTING_LAND,
    improvements: {},
    powered: false,
  };
}

function validateCity(city) {
  const errors = [];

  if (!city || typeof city !== 'object') {
    return { valid: false, errors: ['City must be an object'] };
  }
  if (typeof city.infrastructure !== 'number' || city.infrastructure < 0) {
    errors.push('infrastructure must be a non-negative number');
  }
  if (typeof city.land !== 'number' || city.land < 0) {
    errors.push('land must be a non-negative number');
  }
  if (city.continent && !C.CONTINENTS[city.continent]) {
    errors.push(`Unknown continent: ${city.continent}`);
  }

  if (city.improvements) {
    for (const [key, count] of Object.entries(city.improvements)) {
      const def = C.IMPROVEMENTS[key];
      if (!def) {
        errors.push(`Unknown improvement: ${key}`);
        continue;
      }
      if (def.limit !== undefined && count > def.limit) {
        errors.push(`${key}: ${count} exceeds per-city limit of ${def.limit}`);
      }
    }

    if (errors.length === 0) {
      const used = usedImprovementSlots(city.improvements);
      const capacity = improvementSlots(city.infrastructure);
      if (used > capacity) {
        // Reachable legitimately: war damage destroys infra, orphaning
        // improvements. Report it, do not throw — the tick engine decides
        // whether to disable the excess.
        errors.push(`Improvements (${used}) exceed slot capacity (${capacity})`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Population density — the input to the disease formula in Part 3.
 * Exposed here because it is a property of the city's shape, not of its people.
 */
function populationDensity(city) {
  return (city.infrastructure * C.POPULATION.PER_INFRA)
       / (city.land + C.POPULATION.DISEASE_EPSILON);
}

/**
 * Convenience for the UI: a one-glance health read on a city's shape.
 * Infra badly outrunning land is the #1 new-player mistake in this genre.
 */
function cityShapeWarnings(city) {
  const warnings = [];
  if (city.infrastructure > city.land) {
    warnings.push('Infrastructure exceeds land — density is driving disease up. Buy land.');
  }
  const free = availableImprovementSlots(city);
  if (free < 0) {
    warnings.push(`Over slot capacity by ${-free} — some improvements are inactive.`);
  } else if (free > 5) {
    warnings.push(`${free} improvement slots sitting empty.`);
  }
  return warnings;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // slots
  improvementSlots,
  usedImprovementSlots,
  availableImprovementSlots,
  canBuildImprovement,
  improvementCost,
  policyMultiplier,
  policyAmplification,

  // infrastructure
  infraUnitCost,
  infraPurchaseCost,
  infraSellRefund,
  isInfraPurchaseEfficient,

  // land
  landUnitCost,
  landPurchaseCost,
  isLandPurchaseEfficient,
  nextLandBracketBoundary,
  currentLandBracketFloor,

  // cities
  nextCityCost,
  canPurchaseCity,
  createCity,
  validateCity,

  // derived
  populationDensity,
  cityShapeWarnings,

  // exposed for testing
  _round2: round2,
};
