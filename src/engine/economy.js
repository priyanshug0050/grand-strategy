/**
 * ============================================================================
 *  PART 4 of 7 — economy.js
 * ============================================================================
 *  Commerce, income, tax, production chains, power, food, and upkeep.
 *
 *  Pure functions. No database, no side effects.
 *
 *  ---------------------------------------------------------------------------
 *  UNITS — EVERY FUNCTION SAYS WHICH ONE IT USES
 *  ---------------------------------------------------------------------------
 *  Two clocks run in this game and mixing them is the easiest way to be wrong
 *  by a factor of 12:
 *
 *      PER TURN  — production, consumption, power fuel burn, alliance tax
 *      PER DAY   — income, unit upkeep, improvement upkeep
 *
 *  Every function name ends in PerTurn or PerDay. There are no unitless
 *  quantity functions in this module. Convert with turnsToDays/daysToTurns,
 *  never by hand.
 *
 *  ---------------------------------------------------------------------------
 *  THE 1000x TRAP
 *  ---------------------------------------------------------------------------
 *  P&W documents "Minimum Wage = 725" but the real income constant is 0.725.
 *  See the comment on ECONOMY in constants.js. This module uses
 *  INCOME_PER_CAPITA_BASE for all money math and never touches MINIMUM_WAGE.
 * ============================================================================
 */

'use strict';

const C = require('./constants');
const policy = require('./policy');

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

function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function countImprovement(city, key) {
  if (!city.improvements) return 0;
  return city.improvements[key] || 0;
}

/**
 * One policy coefficient. Accepts a pre-resolved effect object or the raw
 * selection — see the same helper in city.js.
 */
function policyMultiplier(opts, key) {
  if (opts.policyEffects) return opts.policyEffects[key] ?? 1;
  if (!opts.policies) return 1;
  let amplification = 0;
  for (const p of (opts.projects || [])) {
    const bonus = C.PROJECTS[p]?.effect?.domesticPolicyBonus;
    if (bonus) amplification += bonus;
  }
  return policy.policyEffects(opts.policies, { amplification }).effects[key] ?? 1;
}

function daysToTurns(perDay) { return perDay / C.TICK.TURNS_PER_DAY; }
function turnsToDays(perTurn) { return perTurn * C.TICK.TURNS_PER_DAY; }

/** Empty resource ledger — every resource present and zeroed. */
function emptyLedger() {
  const ledger = {};
  for (const r of C.ALL_RESOURCES) ledger[r] = 0;
  return ledger;
}

function addToLedger(target, source, multiplier = 1) {
  for (const [k, v] of Object.entries(source)) {
    target[k] = (target[k] || 0) + v * multiplier;
  }
  return target;
}

// ============================================================================
// STACKING BONUSES
// ============================================================================

/**
 * Both raw and manufacturing improvements reward specialisation, topping out
 * at +50% when built to the per-city limit.
 *
 * This one curve is what produces the game's economic tier structure — raw
 * exporters, refiners, developed consumers — with no explicit class system.
 * Players specialise because the math pays them to.
 *
 * Manufacturing is VERIFIED: +12.5% for each of the 2nd through 5th.
 * Raw uses the same shape interpolated across its (larger) limit — the exact
 * P&W raw curve is unsourced.
 *
 * @returns {number} bonus as a fraction, e.g. 0.5 for +50%
 */
function stackingBonus(count, improvementKey) {
  assertNonNegative(count, 'count');
  const def = C.IMPROVEMENTS[improvementKey];
  if (!def) throw new Error(`Unknown improvement: ${improvementKey}`);
  if (count <= 1) return 0;

  const limit = def.limit;

  if (def.category === 'manufacturing') {
    const bonus = C.STACKING.MANUFACTURING_STEP_BONUS * (count - 1);   // VERIFIED
    return Math.min(bonus, C.STACKING.MANUFACTURING_MAX_BONUS);
  }

  if (def.category === 'raw') {
    if (!limit || limit <= 1) return 0;
    const bonus = C.STACKING.RAW_MAX_BONUS * ((count - 1) / (limit - 1)); // PLACEHOLDER curve
    return Math.min(bonus, C.STACKING.RAW_MAX_BONUS);
  }

  return 0;
}

// ============================================================================
// POWER
// ============================================================================

/**
 * Infrastructure that a city's power plants can cover.
 * Each plant type has its own capacity; they sum.
 */
function powerCapacity(city) {
  let capacity = 0;
  for (const [key, count] of Object.entries(city.improvements || {})) {
    const def = C.IMPROVEMENTS[key];
    if (def && def.category === 'power') {
      capacity += def.infraCapacity * count;
    }
  }
  return capacity;
}

/**
 * A city is powered only if its plants cover ALL of its infrastructure.
 * Partial coverage is not partial power — this is a hard threshold, which is
 * why crossing 500 infra with one plant is a classic new-player trap.
 */
function isPowered(city, opts = {}) {
  if (city.infrastructure <= 0) return true;
  if (powerCapacity(city) < city.infrastructure) return false;

  // ⚠️ CAPACITY IS NOT POWER. A plant with no fuel is a building, not a
  // power station.
  //
  // Checking capacity alone let a nation run factories on plants burning coal
  // it did not own: the city reported "powered", every manufacturing building
  // ran, and coal simply went negative before the tick clamped it to zero.
  // Free electricity, which is the same exploit as free steel.
  //
  // When no stockpile is supplied we assume fuel is available — callers like
  // the city-shape preview legitimately ask "would this be powered?" without
  // modelling reserves. The tick always passes one.
  if (!opts.stockpile) return true;

  const fuel = fuelConsumptionPerTurn(city);
  for (const [resource, needed] of Object.entries(fuel)) {
    if (needed <= 0) continue;
    const available = (opts.stockpile[resource] || 0) + (opts.producedThisTurn?.[resource] || 0);
    if (available < needed) return false;
  }
  return true;
}

/** Why is this city unpowered? Capacity, fuel, or neither. */
function powerStatus(city, opts = {}) {
  const capacity = powerCapacity(city);
  const deficit = Math.max(city.infrastructure - capacity, 0);

  if (deficit > 0) {
    return { powered: false, reason: 'capacity', deficit,
      message: `${Math.round(deficit)} infrastructure uncovered — build another power plant.` };
  }

  const fuel = fuelConsumptionPerTurn(city);
  if (opts.stockpile) {
    for (const [resource, needed] of Object.entries(fuel)) {
      if (needed <= 0) continue;
      const available = (opts.stockpile[resource] || 0) + (opts.producedThisTurn?.[resource] || 0);
      if (available < needed) {
        return { powered: false, reason: 'fuel', resource,
          needed: round4(needed), available: round4(available),
          message: `Plants need ${round4(needed)} ${resource} per turn and you have ${round4(available)}. Everything that needs power is idle.` };
      }
    }
  }

  return { powered: true, reason: null, capacity, headroom: capacity - city.infrastructure };
}

/**
 * Fuel burned per turn, per resource type.
 *   0.1 tons per turn per 100 infrastructure, per plant type in use.
 *
 * Plants only burn fuel for the infrastructure they actually cover, so a
 * city with excess capacity does not waste fuel.
 */
function fuelConsumptionPerTurn(city) {
  const consumption = {};
  const infra = city.infrastructure;
  if (infra <= 0) return consumption;

  let remaining = infra;

  for (const [key, count] of Object.entries(city.improvements || {})) {
    const def = C.IMPROVEMENTS[key];
    if (!def || def.category !== 'power' || !def.fuel) continue;
    if (remaining <= 0) break;

    const covered = Math.min(def.infraCapacity * count, remaining);
    const burn = C.POWER.FUEL_PER_TURN_PER_100_INFRA * (covered / C.POWER.INFRA_UNIT);

    consumption[def.fuel] = (consumption[def.fuel] || 0) + burn;
    remaining -= covered;
  }

  return consumption;
}

// ============================================================================
// RAW PRODUCTION
// ============================================================================

/**
 * Raw extraction per turn for one improvement type in one city.
 * Raw improvements do NOT require power — which is why mines-first is always
 * the correct opening.
 */
function rawProductionPerTurn(city, improvementKey, opts = {}) {
  const def = C.IMPROVEMENTS[improvementKey];
  if (!def || def.category !== 'raw') {
    throw new Error(`${improvementKey} is not a raw improvement`);
  }

  const count = countImprovement(city, improvementKey);
  if (count === 0) return 0;

  // Farms are land-driven, not flat-rate.
  if (improvementKey === 'farm') return farmProductionPerTurn(city, opts);

  const bonus = stackingBonus(count, improvementKey);
  const perTurnEach = daysToTurns(def.perDay);
  let output = perTurnEach * count * (1 + bonus);

  output *= projectProductionMultiplier(def.produces, opts.projects || []);
  output *= policyMultiplier(opts, 'rawProductionMultiplier');
  return output;
}

/**
 * Farm output scales with LAND, not with a flat rate.
 *   food/turn = land / 500   (or land / 400 with Mass Irrigation)
 *
 * This is the second reason land matters — the first being disease. It's a
 * neat bit of design: one purchase decision feeds two unrelated systems.
 */
function farmProductionPerTurn(city, opts = {}) {
  const count = countImprovement(city, 'farm');
  if (count === 0) return 0;

  const projects = opts.projects || [];
  const divisor = projects.includes('mass_irrigation')
    ? C.FARM.LAND_DIVISOR_IRRIGATED
    : C.FARM.LAND_DIVISOR_PER_TURN;

  const bonus = stackingBonus(count, 'farm');
  let output = (city.land / divisor) * count * (1 + bonus)
             * policyMultiplier(opts, 'rawProductionMultiplier');

  // Continent penalty (Antarctica halves food).
  const continent = C.CONTINENTS[city.continent];
  if (continent && continent.foodPenalty) output *= continent.foodPenalty;

  // Radiation suppresses food production globally.
  const radiation = opts.radiation || 0;
  if (radiation > 0) {
    let penalty = radiation * C.RADIATION.FOOD_PENALTY_PER_ROENTGEN;
    if (projects.includes('fallout_shelter')) penalty = Math.min(penalty, 0.5); // VERIFIED cap exists
    output *= Math.max(1 - penalty, 0);
  }

  return output;
}

/** Production-booster projects are pure coefficients — see the design rule. */
function projectProductionMultiplier(resource, projects) {
  let multiplier = 1;
  for (const key of projects) {
    const proj = C.PROJECTS[key];
    if (proj && proj.effect && proj.effect.productionBonus && proj.effect.productionBonus[resource]) {
      multiplier *= 1 + proj.effect.productionBonus[resource];
    }
  }
  return multiplier;
}

// ============================================================================
// MANUFACTURING
// ============================================================================

/**
 * Manufacturing converts raw into refined, requires power, and is far more
 * profitable than extraction. That profit gap is what pushes mid-sized nations
 * into the refiner role and creates the trade economy.
 *
 * Throughput scales with count AND the stacking bonus; input consumption
 * scales identically, so the conversion ratio stays fixed. The bonus is extra
 * throughput per building, not free efficiency.
 *
 * @param {Object} available  optional stockpile; output is throttled to what
 *                            the inputs can actually support
 * @returns {{outputs: Object, inputs: Object, throttled: boolean, limitedBy: string|null}}
 */
function manufacturingPerTurn(city, resource, opts = {}) {
  const recipe = C.RECIPES[resource];
  if (!recipe) throw new Error(`No recipe for resource: ${resource}`);

  const key = recipe.improvement;
  const count = countImprovement(city, key);

  const result = { outputs: {}, inputs: {}, throttled: false, limitedBy: null };
  if (count === 0) return result;

  // Unpowered manufacturing produces nothing. Pass the stockpile through so
  // "powered" means fuelled, not merely wired.
  if (!isPowered(city, opts)) {
    result.limitedBy = 'power';
    return result;
  }

  const bonus = stackingBonus(count, key);
  const throughput = count * (1 + bonus);
  const projectMult = projectProductionMultiplier(resource, opts.projects || []);

  const policyMult = policyMultiplier(opts, 'manufacturingMultiplier');
  let outputPerTurn = daysToTurns(recipe.output) * throughput * projectMult * policyMult;
  const inputsPerTurn = {};
  for (const [res, amount] of Object.entries(recipe.inputs)) {
    // Inputs scale with output, so the conversion ratio never drifts — a
    // policy that raises throughput raises the raw material bill with it.
    inputsPerTurn[res] = daysToTurns(amount) * throughput * projectMult * policyMult;
  }

  // Throttle to available stockpile if one was supplied.
  if (opts.available) {
    let ratio = 1;
    let limiter = null;
    for (const [res, needed] of Object.entries(inputsPerTurn)) {
      if (needed <= 0) continue;
      const have = opts.available[res] || 0;
      const possible = have / needed;
      if (possible < ratio) { ratio = possible; limiter = res; }
    }
    if (ratio < 1) {
      ratio = Math.max(ratio, 0);
      outputPerTurn *= ratio;
      for (const res of Object.keys(inputsPerTurn)) inputsPerTurn[res] *= ratio;
      result.throttled = true;
      result.limitedBy = limiter;
    }
  }

  result.outputs[resource] = outputPerTurn;
  result.inputs = inputsPerTurn;
  return result;
}

// ============================================================================
// CITY PRODUCTION ROLLUP
// ============================================================================

/**
 * Everything one city produces and consumes in a turn.
 * Net figures are what the tick engine applies to the stockpile.
 */
function cityProductionPerTurn(city, opts = {}) {
  const gross = emptyLedger();
  const consumed = emptyLedger();

  // --- Raw extraction ---
  for (const [key, count] of Object.entries(city.improvements || {})) {
    const def = C.IMPROVEMENTS[key];
    if (!def || def.category !== 'raw' || count === 0) continue;
    gross[def.produces] += rawProductionPerTurn(city, key, opts);
  }

  // --- Power fuel burn ---
  //
  // Plants burn from the same budget as everything else, and can never burn
  // more than exists. If they cannot be fuelled, the city is unpowered — which
  // isPowered() below will detect, shutting down every powered building.
  const fuel = fuelConsumptionPerTurn(city);
  for (const [resource, needed] of Object.entries(fuel)) {
    const stocked = opts.stockpile ? (opts.stockpile[resource] || 0) : Infinity;
    const availableNow = stocked + gross[resource];
    consumed[resource] += Math.min(needed, Math.max(availableNow, 0));
  }

  // --- Manufacturing ---
  //
  // ⚠️ THE BUDGET BELOW IS WHAT STOPS FREE STEEL.
  //
  // manufacturingPerTurn() only throttles when it is TOLD what is available.
  // Called without a stockpile it assumes infinite inputs — so a nation with
  // three steel mills and no mines produced steel out of nothing, drove its
  // iron negative, and the tick engine then clamped iron to zero and moved on.
  // The mills kept the steel. That is free resources, which is an exploit.
  //
  // So: build a budget from the stockpile PLUS this turn's own extraction
  // (a mine feeding a mill in the same turn is legitimate), and spend it down
  // as each recipe runs. Whatever is left when a recipe's turn comes is all
  // that recipe gets.
  const budget = {};
  for (const r of C.ALL_RESOURCES) {
    const stocked = opts.stockpile ? (opts.stockpile[r] || 0) : 0;
    budget[r] = Math.max(stocked + gross[r] - consumed[r], 0);
  }

  // A mine can fuel a plant in the same turn it extracts, so the power check
  // must see this turn's own extraction — not just yesterday's stockpile.
  const powerOpts = { ...opts, producedThisTurn: gross };

  const manufacturing = {};
  for (const resource of Object.keys(C.RECIPES)) {
    // Pass the remaining budget unless the caller explicitly supplied its own
    // `available` (the market preview does this to model a hypothetical).
    const runOpts = opts.available !== undefined
      ? { ...opts, producedThisTurn: gross }
      : { ...opts, producedThisTurn: gross, available: opts.stockpile ? budget : undefined };

    const run = manufacturingPerTurn(city, resource, runOpts);

    if (run.outputs[resource]) {
      gross[resource] += run.outputs[resource];
      addToLedger(consumed, run.inputs);
      // Spend what this recipe took, so the next one cannot claim it again.
      for (const [res, amount] of Object.entries(run.inputs)) {
        budget[res] = Math.max((budget[res] || 0) - amount, 0);
      }
    }
    manufacturing[resource] = run;
  }

  const net = emptyLedger();
  for (const r of C.ALL_RESOURCES) net[r] = gross[r] - consumed[r];

  return {
    gross, consumed, net, manufacturing,
    powered: isPowered(city, powerOpts),
    power: powerStatus(city, powerOpts),
  };
}

// ============================================================================
// COMMERCE
// ============================================================================

/**
 * Commerce raises average income. It is capped — 100 normally, higher with the
 * International Trade Center project.
 */
function commerceRate(city, opts = {}) {
  let commerce = 0;
  for (const [key, count] of Object.entries(city.improvements || {})) {
    const def = C.IMPROVEMENTS[key];
    if (def && def.commerce) commerce += def.commerce * count;
  }

  commerce *= policyMultiplier(opts, 'commerceMultiplier');

  const projects = opts.projects || [];
  const cap = projects.includes('international_trade_center')
    ? C.ECONOMY.COMMERCE_MAX_WITH_ITC
    : C.ECONOMY.COMMERCE_MAX;

  return Math.min(commerce, cap);
}

// ============================================================================
// INCOME
// ============================================================================

/**
 * Daily income per citizen.
 *   avgIncome = ((commerce / 50) * 0.725) + 0.725
 *
 * Linear in commerce by design — all the curvature in this game lives upstream
 * in the population model, not here.
 */
function averageIncomePerDay(commerce) {
  assertNonNegative(commerce, 'commerce');
  const { COMMERCE_DIVISOR, INCOME_PER_CAPITA_BASE } = C.ECONOMY;
  return ((commerce / COMMERCE_DIVISOR) * INCOME_PER_CAPITA_BASE) + INCOME_PER_CAPITA_BASE;
}

/**
 * Daily revenue from one city, before nation-level modifiers.
 * Note: P&W's tax rate mathematically cancels out of this expression — see the
 * unit trap comment in constants.js. This IS the government's take.
 */
function cityIncomePerDay(city, population, opts = {}) {
  assertNonNegative(population, 'population');
  const commerce = opts.commerce !== undefined ? opts.commerce : commerceRate(city, opts);
  return averageIncomePerDay(commerce) * population;
}

/**
 * Nation-level gross income with all modifiers applied.
 *
 * Modifiers are MULTIPLICATIVE, then flat bonuses are ADDED. The out-of-food
 * penalty is the big one at -33%, and it is why food is strategically
 * load-bearing rather than a nuisance resource — and why naval blockades bite.
 *
 * @param {number} baseIncomePerDay  sum of cityIncomePerDay across cities
 * @param {Object} opts { policies, projects, outOfFood, colorBonusPerTurn,
 *                        treasureBonus, atWar }
 */
function grossIncomePerDay(baseIncomePerDay, opts = {}) {
  assertNonNegative(baseIncomePerDay, 'baseIncomePerDay');
  let income = baseIncomePerDay;

  income *= policyMultiplier(opts, 'grossIncomeMultiplier');

  if (opts.outOfFood) {
    income *= C.ECONOMY.OUT_OF_FOOD_PENALTY;
  }

  if (opts.treasureBonus) {
    income *= 1 + opts.treasureBonus;
  }

  // Color trade bloc pays a flat per-turn amount, not a percentage.
  if (opts.colorBonusPerTurn) {
    income += turnsToDays(opts.colorBonusPerTurn);
  }

  return round2(income);
}

// ============================================================================
// CONSUMPTION & UPKEEP
// ============================================================================

/**
 * Food eaten per turn by civilians and soldiers.
 * Soldier rates ARE sourced; the civilian rate is a placeholder.
 * Soldiers eat measurably more at war — one of several ways war costs money
 * even when you are winning.
 */
function foodConsumptionPerTurn(population, units = {}, atWar = false, opts = {}) {
  assertNonNegative(population, 'population');

  const civilian = population * C.ECONOMY.FOOD_PER_POPULATION_PER_TURN;

  const soldiers = units.soldiers || 0;
  const perSoldier = atWar
    ? C.UNITS.soldiers.foodPerUnitWar
    : C.UNITS.soldiers.foodPerUnitPeace;
  const military = daysToTurns(soldiers * perSoldier);

  return (civilian + military) * policyMultiplier(opts, 'foodConsumptionMultiplier');
}

/**
 * Unit upkeep in $ per day. War rates are ~50% higher across the board.
 */
function unitUpkeepPerDay(units = {}, atWar = false, opts = {}) {
  let total = 0;
  for (const [unitKey, count] of Object.entries(units)) {
    const def = C.UNITS[unitKey];
    if (!def || !count) continue;
    total += count * (atWar ? def.upkeepWar : def.upkeepPeace);
  }
  return round2(total * policyMultiplier(opts, 'unitUpkeepMultiplier'));
}

/**
 * Improvement upkeep in $ per day.
 * Green Technologies reduces resource-improvement upkeep by 10%.
 */
function improvementUpkeepPerDay(city, opts = {}) {
  const projects = opts.projects || [];
  const greenTech = projects.includes('green_technologies');
  let total = 0;

  for (const [key, count] of Object.entries(city.improvements || {})) {
    const def = C.IMPROVEMENTS[key];
    if (!def || !def.upkeep || !count) continue;
    let upkeep = def.upkeep * count;
    if (greenTech && (def.category === 'raw' || def.category === 'manufacturing')) {
      upkeep *= C.PROJECTS.green_technologies.effect.resourceUpkeepMultiplier;
    }
    total += upkeep;
  }
  return round2(total * policyMultiplier(opts, 'improvementUpkeepMultiplier'));
}

// ============================================================================
// POLLUTION
// ============================================================================

/**
 * City pollution index. Feeds the disease formula in Part 3 at +0.05% each.
 * Green Technologies is applied per-source, then reducers subtract.
 */
function pollutionIndex(city, opts = {}) {
  const projects = opts.projects || [];
  const greenTech = projects.includes('green_technologies');
  let pollution = 0;

  for (const [key, count] of Object.entries(city.improvements || {})) {
    const def = C.IMPROVEMENTS[key];
    if (!def || !count) continue;

    if (def.pollution) {
      let p = def.pollution * count;
      if (greenTech) {
        const eff = C.PROJECTS.green_technologies.effect;
        if (def.category === 'manufacturing') p *= eff.manufacturingPollutionMultiplier;
        if (key === 'farm') p *= eff.farmPollutionMultiplier;
      }
      pollution += p;
    }

    if (def.pollutionReduction) {
      let r = def.pollutionReduction * count;
      if (greenTech && key === 'subway') {
        r += C.PROJECTS.green_technologies.effect.subwayEffectivenessBonus * count;
      }
      if (projects.includes('recycling_initiative') && key === 'recycling_center') {
        r += C.PROJECTS.recycling_initiative.effect.recyclingCenterBonus * count;
      }
      pollution -= r;
    }
  }

  return Math.max(pollution * policyMultiplier(opts, 'pollutionMultiplier'), 0);
}

// ============================================================================
// FULL REVENUE ROLLUP
// ============================================================================

/**
 * Everything about one city's economics, with every intermediate exposed.
 *
 * P&W hides all of this behind external wikis. Surfacing it — showing players
 * exactly where their money goes and what is throttling their factories — is
 * one of the clearest differentiators available to us.
 */
function cityRevenueBreakdown(city, population, opts = {}) {
  const production = cityProductionPerTurn(city, opts);
  const commerce = commerceRate(city, opts);
  const pollution = pollutionIndex(city, opts);

  const incomePerDay = cityIncomePerDay(city, population, { ...opts, commerce });
  const upkeepPerDay = improvementUpkeepPerDay(city, opts);

  return {
    commerce,
    pollution,
    powered: production.powered,

    incomePerDay: round2(incomePerDay),
    upkeepPerDay,
    netCashPerDay: round2(incomePerDay - upkeepPerDay),
    netCashPerTurn: round2(daysToTurns(incomePerDay - upkeepPerDay)),

    resourcesPerTurn: production.net,
    grossResourcesPerTurn: production.gross,
    consumedResourcesPerTurn: production.consumed,
    manufacturing: production.manufacturing,

    warnings: economyWarnings(city, production, commerce),
  };
}

function economyWarnings(city, production, commerce) {
  const warnings = [];

  if (!production.powered) {
    const deficit = city.infrastructure - powerCapacity(city);
    warnings.push(`Unpowered — ${deficit} infrastructure uncovered. Manufacturing, civil and commerce improvements are all inactive.`);
  }

  for (const [resource, run] of Object.entries(production.manufacturing)) {
    if (run.throttled && run.limitedBy) {
      warnings.push(`${resource} production throttled — out of ${run.limitedBy}.`);
    }
  }

  for (const [resource, amount] of Object.entries(production.net)) {
    if (amount < 0 && resource !== 'money') {
      warnings.push(`Net ${resource} is negative (${amount.toFixed(2)}/turn) — you are burning stockpile.`);
    }
  }

  if (commerce === 0 && city.infrastructure > 500) {
    warnings.push('No commerce improvements — income is at the minimum-wage floor.');
  }

  return warnings;
}

/**
 * Nation-level rollup. `populations` must align index-for-index with `cities`.
 */
function nationRevenue(cities, populations, opts = {}) {
  if (!Array.isArray(cities)) throw new TypeError('cities must be an array');
  if (!Array.isArray(populations) || populations.length !== cities.length) {
    throw new TypeError('populations must be an array matching cities in length');
  }

  const resourcesPerTurn = emptyLedger();
  let baseIncomePerDay = 0;
  let improvementUpkeep = 0;
  const perCity = [];

  // The stockpile is NATIONAL but consumed CITY BY CITY. Without tracking what
  // is left, every city would claim the same 100 iron and a nation with five
  // steel-mill cities would refine 500 iron it never had.
  //
  // Cities are served in order. That is arbitrary but deterministic, which is
  // what matters — a player can reason about it, and it never double-spends.
  const remaining = { ...(opts.stockpile || {}) };

  cities.forEach((city, i) => {
    const b = cityRevenueBreakdown(city, populations[i], { ...opts, stockpile: remaining });
    perCity.push(b);
    baseIncomePerDay += b.incomePerDay;
    improvementUpkeep += b.upkeepPerDay;
    addToLedger(resourcesPerTurn, b.resourcesPerTurn);

    // Hand the next city what this one did not use.
    if (opts.stockpile) {
      for (const r of C.ALL_RESOURCES) {
        const delta = (b.resourcesPerTurn[r] || 0);
        remaining[r] = Math.max((remaining[r] || 0) + delta, 0);
      }
    }
  });

  const totalPopulation = populations.reduce((a, b) => a + b, 0);
  const foodPerTurn = foodConsumptionPerTurn(totalPopulation, opts.units, opts.atWar, opts);
  resourcesPerTurn.food -= foodPerTurn;

  const outOfFood = opts.outOfFood !== undefined
    ? opts.outOfFood
    : ((opts.stockpile && opts.stockpile.food !== undefined)
        ? (opts.stockpile.food + resourcesPerTurn.food) <= 0
        : false);

  const gross = grossIncomePerDay(baseIncomePerDay, { ...opts, outOfFood });
  const unitUpkeep = unitUpkeepPerDay(opts.units, opts.atWar, opts);

  return {
    perCity,
    totalPopulation,
    baseIncomePerDay: round2(baseIncomePerDay),
    grossIncomePerDay: gross,
    improvementUpkeepPerDay: round2(improvementUpkeep),
    unitUpkeepPerDay: unitUpkeep,
    netIncomePerDay: round2(gross - improvementUpkeep - unitUpkeep),
    netIncomePerTurn: round2(daysToTurns(gross - improvementUpkeep - unitUpkeep)),
    resourcesPerTurn,
    foodConsumptionPerTurn: foodPerTurn,
    outOfFood,
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // stacking
  stackingBonus,

  // power
  powerCapacity,
  isPowered,
  powerStatus,
  fuelConsumptionPerTurn,

  // production
  rawProductionPerTurn,
  farmProductionPerTurn,
  manufacturingPerTurn,
  cityProductionPerTurn,
  projectProductionMultiplier,

  // commerce & income
  commerceRate,
  averageIncomePerDay,
  cityIncomePerDay,
  grossIncomePerDay,

  // consumption
  foodConsumptionPerTurn,
  unitUpkeepPerDay,
  improvementUpkeepPerDay,

  // pollution
  pollutionIndex,

  // rollups
  cityRevenueBreakdown,
  nationRevenue,

  // unit conversion — always use these, never convert by hand
  daysToTurns,
  turnsToDays,
  policyMultiplier,

  // testing
  _emptyLedger: emptyLedger,
  _round2: round2,
};
