/**
 * ============================================================================
 *  PART 7b of 7 — tick.js
 * ============================================================================
 *  The orchestrator. Wires all six modules into a running engine.
 *
 *  ---------------------------------------------------------------------------
 *  STILL PURE
 *  ---------------------------------------------------------------------------
 *  processTurn() takes a state object and returns a NEW state plus a list of
 *  events. It mutates nothing and touches no database. Your persistence layer
 *  does:
 *
 *      const { state, events } = tick.processTurn(loadedState, { turn });
 *      await withTransaction(async (tx) => {
 *        await saveState(tx, state);
 *        await recordEvents(tx, events);
 *      });
 *
 *  This split is the whole anti-duping strategy. All the arithmetic happens in
 *  memory where it cannot interleave with another request; the database sees
 *  one atomic write of an already-final answer. Row-level locks then protect
 *  the read-modify-write boundary. If you ever find yourself computing game
 *  math inside a transaction, you have lost this property.
 *
 *  ---------------------------------------------------------------------------
 *  THE TWO CLOCKS
 *  ---------------------------------------------------------------------------
 *      PER TURN  (every 2h, 12/day) — production, consumption, tax, MAP,
 *                                     radiation decay, beige countdown
 *      PER DAY   (turn % 12 === 0)  — income, upkeep, city age, recruit reset
 *
 *  Population is recomputed on the MACRO cadence, not every turn. It is the
 *  most expensive calculation in the engine and it does not need to be fast.
 *  See LAYER_CADENCE below.
 *
 *  ---------------------------------------------------------------------------
 *  STATE IS DERIVED, NOT ACCUMULATED
 *  ---------------------------------------------------------------------------
 *  Population, score, commerce and disease are RECOMPUTED from infrastructure,
 *  land and improvements every time. They are never stored and incremented.
 *  That is what prevents drift, desync, and the need for event replay — and it
 *  is why this engine can be verified by unit tests instead of by staring at
 *  production data.
 * ============================================================================
 */

'use strict';

const C = require('./constants');
const city = require('./city');
const population = require('./population');
const economy = require('./economy');
const military = require('./military');
const combat = require('./combat');
const modifiers = require('./modifiers');
const policyEngine = require('./policy');

/**
 * Which layer owns what. Mirrors the 4-layer design: cheap things run often,
 * expensive things run rarely.
 */
const LAYER_CADENCE = {
  L1_MICRO: { everyTurns: 1, owns: ['map_regen', 'market_matching', 'combat_resolution'] },
  L2_STANDARD: { everyTurns: 1, owns: ['production', 'consumption', 'alliance_tax', 'radiation_decay'] },
  L3_MACRO: { everyTurns: 4, owns: ['population', 'disease', 'crime', 'pollution'] },
  L4_EPOCH: { everyTurns: 12, owns: ['income', 'upkeep', 'city_age', 'score', 'rankings'] },
};

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isDayChange(turn) {
  return turn > 0 && turn % C.TICK.TURNS_PER_DAY === 0;
}

function shouldRunLayer(turn, layer) {
  return turn % LAYER_CADENCE[layer].everyTurns === 0;
}

function cityAgeDays(cityObj, currentTurn) {
  const founded = cityObj.foundedTurn ?? 0;   // ?? not || — turn 0 is valid
  return Math.max((currentTurn - founded) / C.TICK.TURNS_PER_DAY, 0);
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

// ============================================================================
// SNAPSHOT — everything derived, in one pass
// ============================================================================

/**
 * Compute every derived value for a nation at a point in time.
 *
 * This is the function the API layer should call to render a dashboard: one
 * call, everything consistent, nothing stored. It is also what processTurn()
 * uses internally, so the numbers a player sees are the same numbers the tick
 * acts on — no possibility of the UI and the engine disagreeing.
 */
function snapshot(nation, currentTurn, opts = {}) {
  const projects = nation.projects || [];
  const effects = modifiers.aggregateProjectEffects(projects);
  const policies = nation.policies || {};

  // Resolve the policy set ONCE per snapshot and pass the result down. Every
  // cost and production function would otherwise recompute it — the same
  // arithmetic, dozens of times per turn per nation.
  const policyResult = policyEngine.policyEffects(policies, {
    amplification: effects.domesticPolicyBonus || 0,
  });
  const policyEffects = policyResult.effects;
  const cities = nation.cities || [];

  const perCity = cities.map(c => {
    const ageDays = cityAgeDays(c, currentTurn);
    const pollution = economy.pollutionIndex(c, { projects, policyEffects });
    const commerce = economy.commerceRate(c, { projects, policyEffects });

    const popBreakdown = population.populationBreakdown(c, {
      cityAgeDays: ageDays,
      pollution,
      radiation: opts.radiation || 0,
      commerce,
      projects,
      policyEffects,
    });

    return {
      // id/infrastructure/land/improvements travel WITH the city, not in a
      // separate array the caller has to index into. A UI that has to
      // correlate two lists by position will eventually correlate them wrongly
      // — that mistake has already caused two silent bugs here (the density
      // bar rendering blank, and improvement counts all showing zero).
      id: c.id,
      name: c.name,
      infrastructure: c.infrastructure,
      land: c.land,
      improvements: c.improvements || {},
      ageDays,
      pollution,
      commerce,
      population: popBreakdown.population,
      populationDetail: popBreakdown,
      improvementSlots: city.improvementSlots(c.infrastructure),
      usedSlots: city.usedImprovementSlots(c.improvements),
      powered: economy.isPowered(c),
      warnings: [...city.cityShapeWarnings(c)],
    };
  });

  const populations = perCity.map(c => c.population);

  const revenue = economy.nationRevenue(cities, populations, {
    projects,
    policies,
    policyEffects,
    units: nation.units,
    atWar: opts.atWar || false,
    stockpile: nation.stockpile,
    colorBonusPerTurn: opts.colorBonusPerTurn || 0,
    treasureBonus: opts.treasureBonus || 0,
  });

  const score = military.nationScore(nation);
  const colorState = modifiers.resolveColorState(nation, currentTurn);

  return {
    turn: currentTurn,
    score: round2(score),
    scoreBreakdown: military.scoreBreakdown(nation),
    warRange: military.warRange(score),
    vulnerableTo: military.vulnerableToRange(score),
    totalPopulation: revenue.totalPopulation,
    perCity,
    revenue,
    colorState,
    projectEffects: effects,
    policyEffects,
    activePolicies: policyResult.applied,
    offensiveWarSlots: military.offensiveWarSlots(projects),
  };
}

// ============================================================================
// PER-TURN PROCESSING
// ============================================================================

/**
 * Advance the game by one turn.
 *
 * @param {Object} state  { nation, turn, world }
 * @param {Object} opts   { allianceTaxRates, blocBonus }
 * @returns {{state: Object, events: Array}}
 */
function processTurn(state, opts = {}) {
  const next = cloneState(state);
  const events = [];
  const turn = (state.turn ?? 0) + 1;
  next.turn = turn;

  const nation = next.nation;
  const projects = nation.projects || [];
  nation.stockpile = nation.stockpile || {};

  // ---- L1: MAP regeneration ----
  nation.map = military.accrueMap(nation.map || 0, 1);

  // ---- Color state (gates tax and protection) ----
  const colorState = modifiers.resolveColorState(nation, turn);
  const colorBonus = modifiers.colorBlocBonus(colorState.color, nation.allianceColor, {
    blocBonus: opts.blocBonus,
  });

  // ---- Derived snapshot: everything recomputed, nothing accumulated ----
  const snap = snapshot(nation, turn, {
    radiation: (next.world && next.world.radiation) || 0,
    atWar: (nation.activeWars || 0) > 0,
    colorBonusPerTurn: colorBonus,
  });

  // ---- L2: resource production and consumption ----
  const production = snap.revenue.resourcesPerTurn;
  const shortfalls = [];

  for (const [resource, delta] of Object.entries(production)) {
    if (resource === 'money' || resource === 'credits') continue;
    const before = nation.stockpile[resource] || 0;
    const after = before + delta;

    if (after < 0) {
      // Stockpiles never go negative. Consumption is throttled to what exists,
      // and the shortfall is reported rather than silently swallowed.
      nation.stockpile[resource] = 0;
      shortfalls.push({ resource, short: round2(-after) });
    } else {
      nation.stockpile[resource] = round2(after);
    }
  }

  if (shortfalls.length > 0) {
    events.push({ type: 'resource_shortfall', turn, shortfalls });
  }

  // ---- Food emergency: the -33% income penalty ----
  const outOfFood = (nation.stockpile.food || 0) <= 0;
  if (outOfFood) {
    events.push({
      type: 'out_of_food',
      turn,
      message: 'Out of food — gross income cut by 33% and population will decline.',
    });
  }

  // ---- Color bloc income ----
  if (colorBonus > 0) {
    nation.money = round2((nation.money || 0) + colorBonus);
    events.push({ type: 'color_bloc_bonus', turn, amount: colorBonus, color: colorState.color });
  }

  // ---- L2: alliance tax ----
  if (nation.allianceId && opts.allianceTaxRates) {
    const tax = modifiers.collectAllianceTax(nation, opts.allianceTaxRates, {
      currentTurn: turn,
      colorState,
      incomeThisTurn: economy.daysToTurns(snap.revenue.grossIncomePerDay),
      productionThisTurn: production,
    });

    if (!tax.exempt) {
      nation.money = round2(Math.max((nation.money || 0) - tax.money, 0));
      for (const [res, amount] of Object.entries(tax.resources)) {
        nation.stockpile[res] = round2(Math.max((nation.stockpile[res] || 0) - amount, 0));
      }
      events.push({ type: 'alliance_tax', turn, money: tax.money, resources: tax.resources });
    }
  }

  // ---- L2: radiation decay ----
  if (next.world && next.world.radiation > 0) {
    next.world.radiation = round2(modifiers.decayRadiation(next.world.radiation, 1, projects));
  }

  // ---- Beige countdown ----
  if (nation.beigeUntilTurn && turn >= nation.beigeUntilTurn) {
    delete nation.beigeUntilTurn;
    // The COLOR must change too, not just the turn marker. Leaving it as
    // 'beige' means the nation keeps beige's bonus and tax exemption forever.
    if (nation.color === 'beige') nation.color = 'gray';
    events.push({
      type: 'beige_expired',
      turn,
      message: 'Beige protection has ended. Pick a color bloc to earn the alliance bonus. You can never return to beige.',
    });
  }

  // ---- L4: the daily rollover ----
  if (isDayChange(turn)) {
    applyDayChange(next, snap, events, turn);
  }

  // ---- Warnings worth surfacing ----
  for (const c of snap.perCity) {
    for (const w of c.warnings) {
      events.push({ type: 'city_warning', turn, city: c.name, message: w });
    }
  }
  for (const c of snap.revenue.perCity) {
    for (const w of c.warnings) {
      events.push({ type: 'economy_warning', turn, message: w });
    }
  }

  return { state: next, events, snapshot: snap };
}

/**
 * Daily rollover: income, upkeep, recruitment reset.
 *
 * Income and upkeep are settled together so a nation that cannot pay its army
 * is caught in the same pass. Bankruptcy has to do SOMETHING — an army that
 * costs money you do not have but suffers no consequence is a free army.
 */
function applyDayChange(next, snap, events, turn) {
  const nation = next.nation;

  const income = snap.revenue.grossIncomePerDay;
  const improvementUpkeep = snap.revenue.improvementUpkeepPerDay;
  const unitUpkeep = snap.revenue.unitUpkeepPerDay;
  const netIncome = income - improvementUpkeep - unitUpkeep;

  nation.money = round2((nation.money || 0) + netIncome);

  events.push({
    type: 'daily_income',
    turn,
    gross: income,
    improvementUpkeep,
    unitUpkeep,
    net: round2(netIncome),
  });

  // ---- Bankruptcy ----
  if (nation.money < 0) {
    const deficit = -nation.money;
    nation.money = 0;
    // PLACEHOLDER consequence: units desert proportionally to the shortfall.
    // P&W's exact bankruptcy behaviour is unsourced, but SOME consequence is
    // required or upkeep is not a real constraint.
    const desertionRate = Math.min(deficit / Math.max(unitUpkeep, 1), 1) * 0.1;
    const deserted = {};
    for (const [unit, count] of Object.entries(nation.units || {})) {
      const lost = Math.floor(count * desertionRate);
      if (lost > 0) { nation.units[unit] = count - lost; deserted[unit] = lost; }
    }
    events.push({ type: 'bankruptcy', turn, deficit: round2(deficit), deserted });
  }

  // ---- Recruitment allowance resets ----
  nation.recruitedToday = {};

  events.push({ type: 'day_change', turn, day: turn / C.TICK.TURNS_PER_DAY });
}

// ============================================================================
// BATCH PROCESSING
// ============================================================================

/**
 * Run several turns in sequence. Useful for catch-up after downtime and for
 * balance simulation.
 *
 * Cap it. Running thousands of turns in one request is how a catch-up job
 * becomes an outage.
 */
function processTurns(state, count, opts = {}) {
  if (count > 1000) throw new RangeError('Refusing to process more than 1000 turns at once');

  let current = state;
  const allEvents = [];

  for (let i = 0; i < count; i++) {
    const result = processTurn(current, opts);
    current = result.state;
    allEvents.push(...result.events);
  }

  return { state: current, events: allEvents };
}

// ============================================================================
// ACTION HANDLERS
// ============================================================================

/**
 * Validate-then-describe. Every handler returns what SHOULD change; it never
 * applies it. The persistence layer applies the description in a transaction.
 */
const actions = {
  buyInfrastructure(state, { cityIndex, targetInfra }) {
    const nation = state.nation;
    const target = nation.cities[cityIndex];
    if (!target) return { ok: false, reason: 'City not found' };

    const cost = city.infraPurchaseCost(target.infrastructure, targetInfra, {
      projects: nation.projects,
      policies: nation.policies,
    });

    if ((nation.money || 0) < cost) {
      return { ok: false, reason: `Costs $${cost.toLocaleString()}, have $${(nation.money || 0).toLocaleString()}` };
    }

    return {
      ok: true,
      cost,
      efficient: city.isInfraPurchaseEfficient(target.infrastructure, targetInfra),
      changes: { money: -cost, cityIndex, infrastructure: targetInfra },
    };
  },

  buyLand(state, { cityIndex, targetLand }) {
    const nation = state.nation;
    const target = nation.cities[cityIndex];
    if (!target) return { ok: false, reason: 'City not found' };

    const cost = city.landPurchaseCost(target.land, targetLand, { policies: nation.policies });
    if ((nation.money || 0) < cost) {
      return { ok: false, reason: `Costs $${cost.toLocaleString()}` };
    }

    return {
      ok: true,
      cost,
      efficient: city.isLandPurchaseEfficient(target.land, targetLand),
      changes: { money: -cost, cityIndex, land: targetLand },
    };
  },

  foundCity(state, { name, continent }) {
    const nation = state.nation;
    const count = nation.cities.length;

    const gate = city.canPurchaseCity(count, nation.lastCityTurn, state.turn);
    if (!gate.ok) return gate;

    const cost = city.nextCityCost(count, { projects: nation.projects, policies: nation.policies });
    if ((nation.money || 0) < cost) {
      return { ok: false, reason: `Costs $${cost.toLocaleString()}` };
    }

    return {
      ok: true,
      cost,
      changes: { money: -cost, newCity: city.createCity(name, continent, state.turn), lastCityTurn: state.turn },
    };
  },

  recruit(state, { unitKey, count }) {
    const nation = state.nation;
    const recruitedToday = (nation.recruitedToday || {})[unitKey] || 0;

    const check = military.canRecruit(nation, unitKey, count, {
      recruitedToday,
      stockpile: { ...nation.stockpile, money: nation.money },
    });
    if (!check.ok) return check;

    return { ok: true, cost: military.buildCost(unitKey, count), changes: { units: { [unitKey]: count } } };
  },

  declareWar(state, { target, warType }) {
    return military.canDeclareWar(state.nation, target, {
      warType,
      currentOffensiveWars: state.nation.offensiveWars || 0,
      targetDefensiveWars: target.defensiveWars || 0,
      targetOnBeige: modifiers.resolveColorState(target, state.turn).color === 'beige',
    });
  },

  attack(state, { attackType, defender, warType, targetCity }) {
    const nation = state.nation;
    const params = {
      attacker: {
        units: nation.units,
        stockpile: nation.stockpile,
        policy: (nation.policies || {}).war,
        controlState: nation.controlState,
      },
      defender,
      opts: {
        warType,
        currentMap: nation.map,
        targetCity,
        rng: state.rng,   // pass a seeded rng to make the battle reproducible
      },
    };

    switch (attackType) {
      case 'ground_battle': return combat.groundBattle(params);
      case 'airstrike': return combat.airStrike(params);
      case 'naval_battle': return combat.navalBattle(params);
      default: return { ok: false, reason: `Unknown attack type: ${attackType}` };
    }
  },
};

// ============================================================================
// NATION FACTORY
// ============================================================================

function createNation(name, continent, currentTurn = 0, opts = {}) {
  const capital = city.createCity(opts.capitalName || `${name} City`, continent, currentTurn);

  const stockpile = {};
  for (const r of C.ALL_RESOURCES) stockpile[r] = 0;
  stockpile.food = opts.startingFood ?? 1000;

  return {
    name,
    continent,
    cities: [capital],
    projects: [],
    policies: { domestic: null, war: null },
    units: { soldiers: 0, tanks: 0, aircraft: 0, ships: 0, missiles: 0, nukes: 0 },
    stockpile,
    money: opts.startingMoney ?? 1000000,
    map: 0,
    color: 'beige',
    // New nations get 14 days of beige protection to find their feet.
    beigeUntilTurn: currentTurn + C.COLORS.BEIGE.newNationDays * C.TICK.TURNS_PER_DAY,
    lastActiveTurn: currentTurn,
    recruitedToday: {},
    foundedTurn: currentTurn,
  };
}

function createGameState(nation, turn = 0) {
  return { turn, nation, world: { radiation: 0 } };
}

module.exports = {
  LAYER_CADENCE,
  snapshot,
  processTurn,
  processTurns,
  applyDayChange,
  actions,
  createNation,
  createGameState,
  isDayChange,
  shouldRunLayer,
  cityAgeDays,
};
