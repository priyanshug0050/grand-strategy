/**
 * ============================================================================
 *  PART 1 of 7 — constants.js
 * ============================================================================
 *  Every tunable number in the game lives here. Nothing else in the engine
 *  should ever contain a magic number — if you find one, it belongs in here.
 *
 *  TAGS
 *    VERIFIED    — sourced from Politics & War documentation
 *    PLACEHOLDER — my invented value; P&W's real number is unknown to me.
 *                  Grep "PLACEHOLDER" to find everything still needing a source.
 *    DESIGN      — our own decision, no P&W equivalent
 *
 *  Balance is tuned by editing this file. No other module changes.
 * ============================================================================
 */

'use strict';

// ============================================================================
// 1. TICK ENGINE
// ============================================================================

const TICK = {
  // P&W runs one turn every 2 hours (12/day) plus a daily rollover at 00:00.
  TURN_INTERVAL_MS: 2 * 60 * 60 * 1000,        // VERIFIED — 2 hours
  TURNS_PER_DAY: 12,                            // VERIFIED

  // Dev overrides — set via env so local testing doesn't take 2 hours per turn.
  DEV_TURN_INTERVAL_MS: 30 * 1000,              // DESIGN
  DEV_DAY_INTERVAL_MS: 6 * 60 * 1000,           // DESIGN

  // What resolves on each cadence.
  PER_TURN: ['production', 'consumption', 'allianceTax', 'mapRegen', 'market'],
  PER_DAY: ['taxIncome', 'unitUpkeep', 'recruitmentReset', 'cityAge'],
};

// ============================================================================
// 2. CITY — COST CURVES & LIMITS
// ============================================================================

const CITY = {
  STARTING_INFRA: 10,                           // VERIFIED
  STARTING_LAND: 250,                           // VERIFIED
  INFRA_PER_IMPROVEMENT_SLOT: 50,               // VERIFIED

  // --- Infrastructure cost -------------------------------------------------
  // unitCost = INFRA_BASE_COST + ((currentInfra - INFRA_OFFSET) ^ EXPONENT) / DIVISOR
  // Quirk: because of the offset, cheapest infra is NOT at zero.
  INFRA_BASE_COST: 300,                         // VERIFIED
  INFRA_OFFSET: 10,                             // VERIFIED
  INFRA_EXPONENT: 2.2,                          // VERIFIED
  INFRA_DIVISOR: 710,                           // VERIFIED
  INFRA_PURCHASE_BRACKET: 100,                  // VERIFIED — buy in multiples of 100

  // --- Land cost -----------------------------------------------------------
  // Exponential from a base of 50/unit, charged in 500-unit brackets.
  // First bracket is 250 because cities spawn with 250 land.
  // unitCost = LAND_BASE_COST + LAND_QUADRATIC_COEFF * (currentLand - LAND_OFFSET)^2
  LAND_BASE_COST: 50,                           // VERIFIED
  LAND_PURCHASE_BRACKET: 500,                   // VERIFIED
  LAND_FIRST_BRACKET: 250,                      // VERIFIED
  LAND_QUADRATIC_COEFF: 0.002,                  // PLACEHOLDER — exact curve unsourced
  LAND_OFFSET: 20,                              // PLACEHOLDER

  // --- New city cost -------------------------------------------------------
  // cost = A * (X-1)^3 + B * X + C   where X = current city count
  // Cubic. This is the game's primary long-term money sink.
  CITY_COST_CUBIC: 50000,                       // VERIFIED
  CITY_COST_LINEAR: 150000,                     // VERIFIED
  CITY_COST_CONSTANT: 75000,                    // VERIFIED
  CITY_COST_FLOOR: 1,                           // VERIFIED — never below $1 after discounts

  // --- City purchase gating ------------------------------------------------
  // Demolishing returns half the MATERIALS and no money. Full return would
  // make build/demolish cycling a way to launder value; zero return makes a
  // misclick on a 300-steel drydock catastrophic.
  DEMOLITION_SALVAGE_RATE: 0.5,                 // DESIGN

  FREE_CITY_COUNT: 10,                          // VERIFIED — first 10 have no timer
  CITY_COOLDOWN_TURNS: 120,                     // VERIFIED — 10 days after city 10
};

// ============================================================================
// 3. POPULATION
// ============================================================================

const POPULATION = {
  // --- Base population -----------------------------------------------------
  // base = (infra * PER_INFRA) + (infra / AGE_DIVISOR) * (100 * ageDays / AGE_FACTOR)
  PER_INFRA: 100,                               // VERIFIED
  AGE_DIVISOR: 1000,                            // VERIFIED
  AGE_FACTOR: 3,                                // VERIFIED

  // --- Age multiplier ------------------------------------------------------
  // multiplier = 1 + ln(ageDays) / AGE_LOG_DIVISOR
  // Logarithmic: negligible below ~200 days, then a real retention reward.
  AGE_LOG_DIVISOR: 15,                          // VERIFIED

  // --- Disease -------------------------------------------------------------
  // density = (infra * 100) / (land + EPSILON)
  // rate = ((DENSITY_COEFF * density^2 - DENSITY_OFFSET) / 100)
  //      + (infra / INFRA_TERM_DIVISOR)
  //      - (hospitals * HOSPITAL_REDUCTION)
  //      + (pollution * POLLUTION_COEFF)
  //
  // The squared density term is the single most load-bearing line in the game.
  // It generates the land economy, the improvement-slot tradeoff, and makes
  // pollution a real cost. Do not linearise it.
  DISEASE_EPSILON: 0.001,                       // VERIFIED — divide-by-zero guard
  DISEASE_DENSITY_COEFF: 0.01,                  // VERIFIED
  DISEASE_DENSITY_OFFSET: 25,                   // VERIFIED
  DISEASE_INFRA_TERM_DIVISOR: 1000,             // VERIFIED
  DISEASE_HOSPITAL_REDUCTION: 2.5,              // VERIFIED — per hospital, in %
  DISEASE_POLLUTION_COEFF: 0.05,                // VERIFIED — per pollution point, in %
  DISEASE_MIN: 0,                               // VERIFIED
  DISEASE_MAX: 1.0,                             // VERIFIED — 100%, city floors at MIN_POPULATION
  DISEASE_DEATH_MULTIPLIER: 100,                // VERIFIED — killed = rate * infra * 100

  // --- Crime ---------------------------------------------------------------
  // Mirror of disease: rises with population, falls with commerce and police.
  //
  //   percent = ((103 - commerce)^2 + basePop * 0.1) / 111111 - police * 2.5
  //
  // ⚠️ STILL UNVERIFIED against the live game, but this shape is a large
  // improvement on what was here before. The previous version scaled crime
  // LINEARLY with population, which meant a 110,000-person city lost 34% of
  // its people to crime every turn — the number simply grew forever.
  //
  // The squared commerce term is what makes commerce buildings do double duty:
  // they raise income AND suppress crime, so a developed city is safer as well
  // as richer. That is a much better incentive than a flat penalty.
  //
  // Sanity anchors (percent, before police):
  //   commerce   0, pop 110k -> 0.195%
  //   commerce  50, pop 110k -> 0.124%
  //   commerce 100, pop 110k -> 0.100%
  CRIME_COMMERCE_CEILING: 103,                  // PLACEHOLDER — (103 - commerce)^2
  CRIME_POP_COEFF: 0.1,                         // PLACEHOLDER
  CRIME_DIVISOR: 111111,                        // PLACEHOLDER
  CRIME_POLICE_REDUCTION: 2.5,                  // PLACEHOLDER — per police station, in %
  CRIME_MIN: 0,                                 // DESIGN
  CRIME_MAX: 1.0,                               // DESIGN
  CRIME_DEATH_WEIGHT: 4,                        // VERIFIED — crime losses count ~4x

  MIN_POPULATION: 10,                           // VERIFIED — hard floor on a dead city
};

// ============================================================================
// 4. ECONOMY — INCOME & COMMERCE
// ============================================================================

const ECONOMY = {
  // ⚠️ UNIT TRAP — READ THIS.
  // P&W documents "Minimum Wage = 725", but the actual daily city income
  // formula is:
  //     income = (((commerce / 50) * 0.725) + 0.725) * population
  // The 1000x difference comes from the minimum wage being defined as
  // 725 / (taxRate * 1000), with the taxRate cancelling against the final
  // multiplication. The net effective per-capita constant is 0.725.
  //
  // Use MINIMUM_WAGE only for display/GDP. Use INCOME_PER_CAPITA_BASE for
  // any actual money calculation. Confusing them is a 1000x error.
  MINIMUM_WAGE: 725,                            // VERIFIED — display only
  INCOME_PER_CAPITA_BASE: 0.725,                // VERIFIED — the real one
  COMMERCE_DIVISOR: 50,                         // VERIFIED

  COMMERCE_MAX: 100,                            // VERIFIED — commerce rate caps at 100%
  COMMERCE_MAX_WITH_ITC: 115,                   // PLACEHOLDER — International Trade Center

  // --- Gross income modifiers (multiplicative) -----------------------------
  OPEN_MARKETS_BONUS: 1.01,                     // VERIFIED — +1%
  OUT_OF_FOOD_PENALTY: 0.67,                    // VERIFIED — -33%, makes food strategic
  // Color trade bloc bonus is a flat per-turn addition, see COLORS below.

  DEFAULT_TAX_RATE: 0.25,                       // DESIGN
  MIN_TAX_RATE: 0,                              // DESIGN
  MAX_TAX_RATE: 1.0,                            // DESIGN

  // --- Food consumption ----------------------------------------------------
  // Civilian rate is unsourced. Military rates ARE sourced (see UNITS).
  FOOD_PER_POPULATION_PER_TURN: 1 / 1000,       // PLACEHOLDER
};

// ============================================================================
// 5. RESOURCES
// ============================================================================

const RAW_RESOURCES = ['coal', 'oil', 'iron', 'bauxite', 'lead', 'uranium', 'food'];
const MANUFACTURED_RESOURCES = ['steel', 'aluminum', 'gasoline', 'munitions'];
const SPECIAL_RESOURCES = ['money', 'credits'];

const ALL_RESOURCES = [
  ...RAW_RESOURCES,
  ...MANUFACTURED_RESOURCES,
  ...SPECIAL_RESOURCES,
];

/**
 * Refining recipes. Daily rates at a single improvement with no bonuses.
 * Manufacturing is far more profitable than raw extraction — that gap is what
 * creates the raw-exporter -> refiner -> consumer economic tier structure.
 */
const RECIPES = {
  steel: {
    improvement: 'steel_mill',
    inputs: { iron: 3, coal: 3 },               // VERIFIED
    output: 9,                                  // VERIFIED — 3+3 in, 9 out per day
  },
  aluminum: {
    improvement: 'aluminum_refinery',
    inputs: { bauxite: 3 },                     // PLACEHOLDER
    output: 6,                                  // PLACEHOLDER
  },
  gasoline: {
    improvement: 'oil_refinery',
    inputs: { oil: 3 },                         // VERIFIED
    output: 6,                                  // VERIFIED — 3 in, 6 out per day
  },
  munitions: {
    improvement: 'munitions_factory',
    inputs: { lead: 3 },                        // PLACEHOLDER
    output: 6,                                  // PLACEHOLDER
  },
};

/**
 * Continent gating. No nation can produce every raw resource — this is the
 * mechanism that forces inter-player trade. Food is universal.
 * Exact per-continent tables are PLACEHOLDER; the structure is correct.
 */
const CONTINENTS = {
  north_america: { produces: ['coal', 'iron', 'uranium', 'lead', 'food'] },      // PLACEHOLDER
  south_america: { produces: ['oil', 'bauxite', 'lead', 'food'] },               // PLACEHOLDER
  europe:        { produces: ['coal', 'iron', 'lead', 'uranium', 'food'] },      // PLACEHOLDER
  africa:        { produces: ['oil', 'bauxite', 'uranium', 'food'] },            // PLACEHOLDER
  asia:          { produces: ['oil', 'iron', 'uranium', 'coal', 'food'] },       // PLACEHOLDER
  australia:     { produces: ['coal', 'bauxite', 'lead', 'oil', 'food'] },       // PLACEHOLDER
  antarctica:    { produces: ['oil', 'coal', 'uranium', 'food'], foodPenalty: 0.5 }, // VERIFIED penalty
};

// ============================================================================
// 6. IMPROVEMENTS
// ============================================================================

/**
 * Stacking bonuses. Both reward specialisation, which is how the game gets
 * distinct nation archetypes with no explicit class system.
 */
const STACKING = {
  RAW_MAX_BONUS: 0.50,                          // VERIFIED — +50% at build limit
  MANUFACTURING_STEP_BONUS: 0.125,              // VERIFIED — +12.5% for 2nd-5th
  MANUFACTURING_MAX_BONUS: 0.50,                // VERIFIED — +50% at 5
};

/**
 * Improvement definitions.
 *   cost/upkeep in $ (upkeep is per day)
 *   pollution is a flat index contribution
 *   limit is per city
 *   power: true means it does nothing without a powered city
 */
const IMPROVEMENTS = {
  // --- Raw extraction (no power required) ----------------------------------
  coal_mine:      { category: 'raw', produces: 'coal',    perDay: 3,    cost: 1000,  upkeep: 400, pollution: 12, limit: 10, power: false }, // VERIFIED rate/limit
  oil_well:       { category: 'raw', produces: 'oil',     perDay: 3,    cost: 1500,  upkeep: 600, pollution: 12, limit: 10, power: false }, // VERIFIED rate/limit
  iron_mine:      { category: 'raw', produces: 'iron',    perDay: 3,    cost: 9500,  upkeep: 400, pollution: 12, limit: 10, power: false }, // PLACEHOLDER rate/cost
  bauxite_mine:   { category: 'raw', produces: 'bauxite', perDay: 3,    cost: 9500,  upkeep: 400, pollution: 12, limit: 10, power: false }, // PLACEHOLDER rate/cost
  lead_mine:      { category: 'raw', produces: 'lead',    perDay: 3,    cost: 9500,  upkeep: 400, pollution: 12, limit: 10, power: false }, // PLACEHOLDER rate/cost
  uranium_mine:   { category: 'raw', produces: 'uranium', perDay: 3,    cost: 25000, upkeep: 1000, pollution: 20, limit: 5,  power: false }, // VERIFIED limit only

  // Farm output scales with LAND, not a flat rate — see FARM below.
  farm:           { category: 'raw', produces: 'food',    cost: 1000,  upkeep: 300, pollution: 2,  limit: 20, power: false }, // VERIFIED limit

  // --- Manufacturing (power required) --------------------------------------
  // All share: $45,000 build, $4,000/day upkeep, +32 pollution, limit 5.
  steel_mill:        { category: 'manufacturing', produces: 'steel',     cost: 45000, upkeep: 4000, pollution: 32, limit: 5, power: true }, // VERIFIED
  aluminum_refinery: { category: 'manufacturing', produces: 'aluminum',  cost: 45000, upkeep: 4000, pollution: 32, limit: 5, power: true }, // VERIFIED
  oil_refinery:      { category: 'manufacturing', produces: 'gasoline',  cost: 45000, upkeep: 4000, pollution: 32, limit: 5, power: true }, // VERIFIED
  munitions_factory: { category: 'manufacturing', produces: 'munitions', cost: 45000, upkeep: 4000, pollution: 32, limit: 5, power: true }, // VERIFIED

  // --- Power ---------------------------------------------------------------
  // Cleanliness ladder: wind -> nuclear -> oil -> coal
  coal_power:    { category: 'power', fuel: 'coal',    cost: 5000,   upkeep: 1200, pollution: 8, limit: 5, infraCapacity: 500 },  // VERIFIED capacity
  oil_power:     { category: 'power', fuel: 'oil',     cost: 7000,   upkeep: 1800, pollution: 6, limit: 5, infraCapacity: 500 },  // VERIFIED capacity
  nuclear_power: { category: 'power', fuel: 'uranium', cost: 500000, upkeep: 10500, pollution: 0, limit: 2, infraCapacity: 2000 }, // PLACEHOLDER
  wind_power:    { category: 'power', fuel: null,      cost: 30000,  upkeep: 500,  pollution: 0, limit: 5, infraCapacity: 250 },  // PLACEHOLDER

  // --- Civil (mitigation) --------------------------------------------------
  police_station:   { category: 'civil', cost: 75000,  materials: { steel: 40, munitions: 15 },  upkeep: 750,  crimeReduction: 2.5, limit: 5, power: true }, // PLACEHOLDER
  hospital:         { category: 'civil', cost: 100000, materials: { steel: 50, aluminum: 40 },   upkeep: 1000, diseaseReduction: 2.5, limit: 5, power: true }, // VERIFIED reduction
  recycling_center: { category: 'civil', cost: 125000, materials: { steel: 70, aluminum: 30 },   upkeep: 2500, pollutionReduction: 70, limit: 3, power: true }, // VERIFIED reduction/limit
  subway:           { category: 'civil', cost: 250000, materials: { steel: 200, aluminum: 100 }, upkeep: 3250, pollutionReduction: 45, commerce: 8, limit: 1, power: true }, // PLACEHOLDER

  // --- Commerce (raise the commerce rate -> raise income) -------------------
  // ⚠️ MATERIALS, NOT JUST MONEY.
  //
  // These used to cost money alone, which made the whole manufacturing chain
  // pointless: you could refine steel and have nothing to spend it on, and a
  // rich nation could skip industry entirely and buy its way to max commerce.
  //
  // Now every commerce, civil and military building consumes REFINED goods.
  // That gives steel and aluminum a domestic sink, makes the market matter,
  // and means growth costs production time rather than only cash.
  //
  // Raw and manufacturing buildings deliberately do NOT need materials — a
  // steel mill requiring steel is a chicken-and-egg trap a new player can
  // never escape.
  supermarket:   { category: 'commerce', cost: 5000,   materials: { steel: 10 },                 upkeep: 600,   commerce: 3,  limit: 4, power: true }, // PLACEHOLDER
  bank:          { category: 'commerce', cost: 15000,  materials: { steel: 25, aluminum: 10 },   upkeep: 1800,  commerce: 5,  limit: 5, power: true }, // PLACEHOLDER
  shopping_mall: { category: 'commerce', cost: 45000,  materials: { steel: 60, aluminum: 30 },   upkeep: 5400,  commerce: 9,  limit: 4, power: true }, // PLACEHOLDER
  stadium:       { category: 'commerce', cost: 100000, materials: { steel: 120, aluminum: 80 },  upkeep: 12150, commerce: 12, limit: 3, power: true }, // PLACEHOLDER

  // --- Military (unit capacity + recruitment throughput) -------------------
  // Barracks stay cheap and material-free on purpose: soldiers are the one
  // military option a nation with no industry can still reach for, which is
  // what keeps a bombed-out player able to defend themselves.
  barracks: { category: 'military', unit: 'soldiers', capacity: 3000, perDay: 1000, cost: 3000,   materials: {},                                upkeep: 0, limit: 5, power: false }, // VERIFIED
  factory:  { category: 'military', unit: 'tanks',    capacity: 250,  perDay: 50,   cost: 15000,  materials: { steel: 30 },                     upkeep: 0, limit: 5, power: true },  // PLACEHOLDER
  hangar:   { category: 'military', unit: 'aircraft', capacity: 18,   perDay: 3,    cost: 100000, materials: { steel: 80, aluminum: 120 },      upkeep: 0, limit: 5, power: true },  // PLACEHOLDER
  drydock:  { category: 'military', unit: 'ships',    capacity: 5,    perDay: 1,    cost: 250000, materials: { steel: 300, aluminum: 60 },      upkeep: 0, limit: 3, power: true },  // PLACEHOLDER
};

/** Farm output is land-driven, not flat. */
const FARM = {
  LAND_DIVISOR_PER_TURN: 250,                   // VERIFIED — food/turn = land / 500
  LAND_DIVISOR_IRRIGATED: 185,                  // VERIFIED — with Mass Irrigation project
};

/** Power plant fuel burn. */
const POWER = {
  FUEL_PER_TURN_PER_100_INFRA: 0.1,             // VERIFIED
  INFRA_UNIT: 100,                              // VERIFIED
};

// ============================================================================
// 7. POLLUTION & RADIATION
// ============================================================================

const POLLUTION = {
  DISEASE_PER_POINT: 0.05,                      // VERIFIED — +0.05% disease per point
};

/**
 * Radiation makes nuclear war a tragedy of the commons — the whole world pays
 * for one nation's nuke. That's what creates real diplomatic pressure against
 * their use, and it's the single cleverest bit of design in the game.
 */
const RADIATION = {
  PER_NUKE_CONTINENT: 5,                        // VERIFIED — Roentgen
  PER_NUKE_GLOBAL: 1,                           // VERIFIED
  DISSIPATION_TURNS: 100,                       // VERIFIED
  FOOD_PENALTY_PER_ROENTGEN: 0.01,              // PLACEHOLDER
  DISEASE_PER_ROENTGEN: 0.01,                   // PLACEHOLDER
};

// ============================================================================
// 8. SCORE & MATCHMAKING
// ============================================================================

/**
 * Score is simultaneously a power rating AND a matchmaking weight. That dual
 * role is why ships are a trap unit in P&W: 1.0 score each pushes you into
 * bigger nations' down-declare range. Choose these coefficients carefully.
 */
const SCORE = {
  BASE: 10,                                     // VERIFIED
  PER_CITY: 100,                                // VERIFIED — applied to (cityCount - 1)
  INFRA_DIVISOR: 40,                            // VERIFIED
  PER_PROJECT: 20,                              // VERIFIED

  MILITARY: {
    soldiers: 0.0004,                           // VERIFIED
    tanks:    0.025,                            // VERIFIED
    aircraft: 0.3,                              // VERIFIED
    ships:    1,                                // VERIFIED
    missiles: 5,                                // VERIFIED
    nukes:    15,                               // VERIFIED
  },
  MISSILE_SCORE_CAP: 50,                        // VERIFIED
  NUKE_SCORE_CAP: 50,                           // VERIFIED
};

/**
 * Asymmetric on purpose: you can always be hit by someone meaningfully bigger,
 * never by someone overwhelmingly bigger. The anti-griefing backbone.
 */
const WAR_RANGE = {
  MIN_MULTIPLIER: 0.75,                         // VERIFIED — 25% below
  MAX_MULTIPLIER: 1.75,                         // VERIFIED — 75% above
};

const ESPIONAGE_RANGE = {
  MIN_MULTIPLIER: 0.75,                         // PLACEHOLDER — separate range in P&W
  MAX_MULTIPLIER: 1.75,                         // PLACEHOLDER
};

// ============================================================================
// 9. MILITARY UNITS
// ============================================================================

/**
 * THE most important rule here: unsupplied units contribute ZERO army value
 * but STILL take casualties. One clause makes logistics mandatory without a
 * separate logistics system. Enforced in combat.js (Part 6).
 */
const UNITS = {
  soldiers: {
    cost: { money: 5 },                         // PLACEHOLDER
    upkeepPeace: 1.25,                          // VERIFIED — per day
    upkeepWar: 1.88,                            // VERIFIED
    foodPerUnitPeace: 1 / 750,                  // VERIFIED
    foodPerUnitWar: 1 / 500,                    // VERIFIED
    battleConsumption: { munitions: 1 / 5000 }, // PLACEHOLDER — optional, big damage boost
    building: 'barracks',
  },
  tanks: {
    cost: { money: 60, steel: 0.5 },            // VERIFIED
    upkeepPeace: 50,                            // VERIFIED
    upkeepWar: 75,                              // VERIFIED
    battleConsumption: { munitions: 1 / 100, gasoline: 1 / 100 }, // VERIFIED
    building: 'factory',
  },
  aircraft: {
    cost: { money: 4000, aluminum: 5 },         // VERIFIED
    upkeepPeace: 500,                           // VERIFIED
    upkeepWar: 750,                             // VERIFIED
    battleConsumption: { munitions: 0.25, gasoline: 0.25 }, // VERIFIED
    building: 'hangar',
  },
  ships: {
    cost: { money: 50000, steel: 30 },          // PLACEHOLDER
    upkeepPeace: 3750,                          // VERIFIED
    upkeepWar: 5625,                            // VERIFIED
    battleConsumption: { munitions: 2.5, gasoline: 1.5 }, // PLACEHOLDER
    building: 'drydock',
  },
  missiles: {
    cost: { money: 150000, aluminum: 100, gasoline: 75, munitions: 75 }, // PLACEHOLDER
    upkeepPeace: 0,
    upkeepWar: 0,
    requiresProject: 'missile_launch_pad',
  },
  nukes: {
    cost: { money: 500000, aluminum: 750, gasoline: 500, uranium: 250 }, // PLACEHOLDER
    upkeepPeace: 0,
    upkeepWar: 0,
    requiresProject: 'nuclear_research_facility',
  },
};

// ============================================================================
// 10. COMBAT
// ============================================================================

const COMBAT = {
  // --- Army value ----------------------------------------------------------
  ARMY_VALUE: {
    UNARMED_SOLDIER: 1,                         // VERIFIED
    ARMED_SOLDIER: 1.75,                        // VERIFIED
    TANK: 40,                                   // VERIFIED — a tank ≈ 23 armed soldiers
  },

  // Defenders get a population-scaled militia bonus.
  // ⚠️ SOURCES CONFLICT: the wiki says population/400 (0.25%), the in-game FAQ
  // says 0.025% (population/4000). Verify against live game before shipping.
  DEFENDER_MILITIA_DIVISOR: 400,                // PLACEHOLDER — conflicting sources

  // --- The 3-roll system ---------------------------------------------------
  // THE master tuning knob of the entire game. Widen the band and combat is
  // coin-flippy; narrow it and combat is pure arithmetic with no reason to
  // fight an even match. At 40-100%: >2.5x advantage is a near-certain sweep,
  // below that it stays genuinely uncertain.
  ROLL_COUNT: 3,                                // VERIFIED
  ROLL_MIN_FRACTION: 0.4,                       // VERIFIED
  ROLL_MAX_FRACTION: 1.0,                       // VERIFIED

  VICTORY_TYPE: {
    UTTER_FAILURE: 0,                           // VERIFIED — 0 rolls won
    PYRRHIC_VICTORY: 1,                         // VERIFIED — 1 roll won
    MODERATE_SUCCESS: 2,                        // VERIFIED — 2 rolls won
    IMMENSE_TRIUMPH: 3,                         // VERIFIED — 3 rolls won
  },
  VICTORY_TYPE_DIVISOR: 3,                      // VERIFIED — damage scales by type/3

  // --- MAP (Military Action Points) ----------------------------------------
  MAP_MAX: 12,                                  // PLACEHOLDER
  MAP_PER_TURN: 1,                              // PLACEHOLDER
  MAP_COST: {
    ground_battle: 3,                           // VERIFIED
    airstrike: 4,                               // VERIFIED
    naval_battle: 4,                            // PLACEHOLDER
    missile_launch: 8,                          // PLACEHOLDER
    nuclear_attack: 12,                         // PLACEHOLDER
  },

  // --- Resistance ----------------------------------------------------------
  RESISTANCE_START: 100,                        // VERIFIED
  RESISTANCE_LOSS: {
    // by attack type, at IMMENSE_TRIUMPH; lower tiers scale down
    ground_battle: 10,                          // VERIFIED
    airstrike: 8,                               // PLACEHOLDER
    naval_battle: 14,                           // PLACEHOLDER — fastest route is 5 naval + 3 ground
    missile_launch: 12,                         // PLACEHOLDER
    nuclear_attack: 20,                         // PLACEHOLDER
  },

  // --- War slots -----------------------------------------------------------
  OFFENSIVE_WAR_SLOTS: 5,                       // VERIFIED
  OFFENSIVE_WAR_SLOTS_PIRATE: 6,                // VERIFIED — with Pirate Economy project
  DEFENSIVE_WAR_SLOTS: 3,                       // VERIFIED

  // --- Damage --------------------------------------------------------------
  // Shared shape: (attacker - defender*0.5) * constant * jitter * (victoryType/3)
  // then clamped by a per-city cap.
  DEFENDER_DAMAGE_OFFSET: 0.5,                  // VERIFIED
  DAMAGE_JITTER_MIN: 0.85,                      // VERIFIED
  DAMAGE_JITTER_MAX: 1.05,                      // VERIFIED

  GROUND_SOLDIER_INFRA_COEFF: 0.000606061,      // VERIFIED
  GROUND_TANK_INFRA_COEFF: 0.01,                // VERIFIED
  AIR_INFRA_COEFF: 0.35353535,                  // VERIFIED
  NAVAL_INFRA_COEFF: 0.15,                      // PLACEHOLDER

  // Per-battle infra cap: infra * 0.5 + 100.
  // ESSENTIAL — guarantees no city dies in one hit, which is what makes wars
  // multi-day affairs instead of instant knockouts. Do not remove.
  INFRA_DAMAGE_CAP_FRACTION: 0.5,               // VERIFIED
  INFRA_DAMAGE_CAP_CONSTANT: 100,               // VERIFIED

  // Non-"target infrastructure" airstrikes deal 1/3 damage.
  AIRSTRIKE_NON_INFRA_MULTIPLIER: 1 / 3,        // VERIFIED

  IMPROVEMENT_DESTROY_CHANCE: 0.10,             // VERIFIED — on Immense Triumph only

  // --- Loot ----------------------------------------------------------------
  LOOT_SOLDIER_MIN: 0.5,                        // VERIFIED
  LOOT_SOLDIER_MAX: 1.0,                        // VERIFIED
  LOOT_TANK_MIN: 7,                             // VERIFIED
  LOOT_TANK_MAX: 13,                            // VERIFIED
  LOOT_MAX_FRACTION: 0.75,                      // VERIFIED — never more than 75% of their money
  LOOT_FLOOR: 1000000,                          // VERIFIED — can never be looted below $1M

  // --- Casualties ----------------------------------------------------------
  // ⚠️ P&W's exact casualty formulas are NOT sourced. The shape below is
  // self-balancing (losses scale with the ENEMY's strength relative to the
  // total force on the field) which produces sane behaviour, but the
  // coefficients are invented. This is a high-priority research gap: casualty
  // rates set the entire economic cost of war.
  CASUALTY_BASE_RATE: 0.10,                     // PLACEHOLDER — fraction of force at risk
  CASUALTY_VICTORY_REDUCTION: 0.15,             // PLACEHOLDER — per victory tier won
  CASUALTY_JITTER_MIN: 0.9,                     // PLACEHOLDER
  CASUALTY_JITTER_MAX: 1.1,                     // PLACEHOLDER

  // Unsupplied units take casualties at the SAME rate as supplied ones despite
  // contributing zero army value. This is the rule that makes logistics
  // mandatory — see military.js. Never make this less than 1.0.
  UNSUPPLIED_CASUALTY_MULTIPLIER: 1.0,          // VERIFIED (principle)

  // --- Fortify -------------------------------------------------------------
  FORTIFY_CASUALTY_INCREASE: 0.25,              // VERIFIED — attackers take +25%
};

/**
 * Control states — rock-paper-scissors as persistent debuffs rather than
 * damage multipliers. Note the asymmetry: ANY victory nullifies the enemy's
 * control over you, but only an Immense Triumph grants you one. That gives a
 * losing player a cheap, achievable comeback goal.
 */
const CONTROL_STATES = {
  ground_control:  { from: 'ground_battle', effect: 'destroys_enemy_aircraft_scaled_by_tanks' }, // VERIFIED
  air_superiority: { from: 'airstrike',     effect: 'enemy_tank_value_halved', modifier: 0.5 },  // VERIFIED
  blockade:        { from: 'naval_battle',  effect: 'blocks_resource_and_money_transfers' },     // VERIFIED
};

/** Declared up front — one enum field that creates distinct player archetypes. */
const WAR_TYPES = {
  attrition: { infraDamage: 1.00, loot: 0.25 }, // VERIFIED
  ordinary:  { infraDamage: 0.50, loot: 0.50 }, // VERIFIED
  raid:      { infraDamage: 0.25, loot: 1.00 }, // VERIFIED
};

const VICTORY = {
  BEIGE_DURATION_DAYS: 2,                       // VERIFIED — stacks per war lost
  LOOT_MONEY_FRACTION: 0.10,                    // VERIFIED
  LOOT_RESOURCE_FRACTION: 0.10,                 // VERIFIED
  INFRA_LOSS_FRACTION: 0.04,                    // VERIFIED — up to 4% in every city
  CREDITS_LOOTABLE: false,                      // VERIFIED
  LOOTS_ALLIANCE_BANK: true,                    // VERIFIED
};

// ============================================================================
// 11. ESPIONAGE
// ============================================================================

/**
 * Clean opposed check: your strength over 3x theirs, plus a caution bonus,
 * divided by target value.
 *   odds = (safetyLevel * 25) + (yourSpies * 100) / ((enemySpies * 3) + 1)
 *   finalOdds = odds / operationModifier
 */
const ESPIONAGE = {
  SAFETY_MULTIPLIER: 25,                        // VERIFIED
  SPY_NUMERATOR: 100,                           // VERIFIED
  ENEMY_SPY_MULTIPLIER: 3,                      // VERIFIED
  ENEMY_SPY_CONSTANT: 1,                        // VERIFIED

  SAFETY_LEVELS: {
    quick_and_dirty: 1,                         // VERIFIED
    normal_precautions: 2,                      // VERIFIED
    extremely_covert: 3,                        // VERIFIED
  },

  OPERATION_MODIFIER: {
    gather_intelligence: 1,                     // VERIFIED
    assassinate_spies: 1.5,                     // VERIFIED
    sabotage_tanks: 1.5,                        // VERIFIED
    sabotage_aircraft: 2,                       // VERIFIED
    sabotage_ships: 3,                          // VERIFIED
    sabotage_missile: 4,                        // VERIFIED
    sabotage_nuke: 5,                           // VERIFIED
  },

  MAX_SPIES: 50,                                // PLACEHOLDER
  MAX_SPIES_WITH_AGENCY: 60,                    // PLACEHOLDER
  DAILY_OPERATIONS: 2,                          // PLACEHOLDER
};

// ============================================================================
// 12. PROJECTS
// ============================================================================

/**
 * DESIGN RULE, non-negotiable: every project is a COEFFICIENT on an existing
 * formula, never a new system. That's how P&W supports ~30 projects without
 * the codebase exploding. If a project needs its own table, redesign it.
 *
 * All costs below are PLACEHOLDER. Effects are VERIFIED where noted.
 */
const PROJECTS = {
  // --- Production boosters (6) ---------------------------------------------
  ironworks:                 { effect: { productionBonus: { steel: 0.36 } }, cost: { money: 15000000, coal: 1000, iron: 1000 } },
  bauxiteworks:              { effect: { productionBonus: { aluminum: 0.36 } }, cost: { money: 15000000, bauxite: 1000 } },
  arms_stockpile:            { effect: { productionBonus: { munitions: 0.20 } }, cost: { money: 15000000, lead: 1000 } },
  emergency_gasoline_reserve:{ effect: { productionBonus: { gasoline: 0.20 } }, cost: { money: 15000000, oil: 1000 } },
  mass_irrigation:           { effect: { farmLandDivisor: 185}, cost: { money: 3000000, food: 5000 } }, // VERIFIED effect
  uranium_enrichment_program:{ effect: { productionBonus: { uranium: 0.20 } }, cost: { money: 22500000, uranium: 500 } },

  // --- Cost reducers -------------------------------------------------------
  center_for_civil_engineering: { effect: { infraCostMultiplier: 0.95 }, cost: { money: 3000000 } }, // VERIFIED -5%
  urban_planning:            { effect: { cityCostDiscount: 50000000 },  cost: { money: 50000000 } },  // VERIFIED
  advanced_urban_planning:   { effect: { cityCostDiscount: 100000000 }, cost: { money: 100000000 } }, // VERIFIED
  metropolitan_planning:     { effect: { cityCostDiscount: 150000000 }, cost: { money: 150000000 } }, // VERIFIED
  // NOTE: city cost discounts STACK, and are applied BEFORE the Manifest
  // Destiny -5%. Order matters — a real source of bugs.

  // --- Mitigation ----------------------------------------------------------
  green_technologies: {
    effect: {
      manufacturingPollutionMultiplier: 0.75,   // VERIFIED -25%
      farmPollutionMultiplier: 0.5,             // VERIFIED -50%
      subwayEffectivenessBonus: 25,             // VERIFIED
      resourceUpkeepMultiplier: 0.90,           // VERIFIED -10%
    },
    cost: { money: 50000000 },
  },
  recycling_initiative:      { effect: { recyclingCenterBonus: 5, recyclingCenterLimit: 4 }, cost: { money: 45000000 } }, // VERIFIED
  clinical_research_center:  { effect: { diseaseReduction: true }, cost: { money: 20000000 } },   // VERIFIED (magnitude PLACEHOLDER)
  fallout_shelter: {
    effect: {
      nukeDamageMultiplier: 0.90,               // VERIFIED -10%
      falloutDurationMultiplier: 0.75,          // VERIFIED -25%
      capsRadiationFoodImpact: true,            // VERIFIED
    },
    cost: { money: 40000000 },
  },

  // --- Military ------------------------------------------------------------
  iron_dome:                 { effect: { missileInterceptChance: 0.5 }, cost: { money: 21000000 } },
  vital_defense_system:      { effect: { nukeInterceptChance: 0.5 }, cost: { money: 75000000 } },
  intelligence_agency:       { effect: { maxSpiesBonus: 10 }, cost: { money: 5000000 } },
  military_salvage:          { effect: { salvageFraction: 0.05 }, cost: { money: 20000000 } }, // VERIFIED 5%
  missile_launch_pad:        { effect: { unlocks: 'missiles' }, cost: { money: 20000000 } },
  nuclear_research_facility: { effect: { unlocks: 'nukes' }, cost: { money: 75000000 } },
  pirate_economy:            { effect: { offensiveWarSlots: 6 }, cost: { money: 25000000 } }, // VERIFIED
  propaganda_bureau:         { effect: { militaryRecruitmentBonus: 0.10 }, cost: { money: 10000000 } },

  // --- Economic ------------------------------------------------------------
  international_trade_center: { effect: { commerceMax: 115 }, cost: { money: 50000000 } },
  government_support_agency:  { effect: { domesticPolicyBonus: 0.5 }, cost: { money: 20000000 } }, // VERIFIED (MD -5% -> -7.5%)
  bureau_of_domestic_affairs: { effect: { domesticPolicyBonus: 0.5 }, cost: { money: 20000000 } },

  // --- Prestige ------------------------------------------------------------
  moon_landing: { effect: { scoreBonus: 0 }, cost: { money: 100000000 } },
  mars_landing: { effect: { scoreBonus: 0 }, cost: { money: 200000000 } },
};

const PROJECT_SCORE_VALUE = 20;                 // VERIFIED — every project adds +20 score

// ============================================================================
// 13. POLICIES
// ============================================================================

/**
 * DESIGN RULE: every policy is a STRICT TRADEOFF, never a pure buff. This is
 * the discipline that stops the meta collapsing onto one dominant choice.
 * Moneybags exists specifically to counter Pirate — a policy whose purpose is
 * to make an opposing playstyle unprofitable against you.
 *
 * If you add a policy and can't name what it costs you, it isn't finished.
 */
const DOMESTIC_POLICIES = {
  manifest_destiny:         { cityCostMultiplier: 0.95 },       // VERIFIED -5%
  urbanization:             { infraCostMultiplier: 0.95 },      // VERIFIED -5%
  open_markets:             { grossIncomeMultiplier: 1.01 },    // VERIFIED +1%
  technological_advancement:{ projectCostMultiplier: 0.95 },    // PLACEHOLDER
  imperialism:              { militaryUpkeepMultiplier: 0.95 }, // PLACEHOLDER
  rapid_expansion:          { landCostMultiplier: 0.95 },       // PLACEHOLDER — 6th policy, name unsourced
};

const WAR_POLICIES = {
  attrition:  { infraDamageDealt: 1.10, lootReceived: 0.80 },   // VERIFIED
  turtle:     { infraDamageTaken: 0.90, lootLost: 1.20 },       // VERIFIED
  blitzkrieg: { infraDamageDealt: 1.10, casualtiesDealt: 1.10, durationTurns: 12 }, // VERIFIED
  moneybags:  { lootLost: 0.60, infraDamageTaken: 1.05 },       // VERIFIED
  pirate:     { lootReceived: 1.40, infraDamageDealt: 0.90 },   // PLACEHOLDER
  fortress:   { infraDamageTaken: 0.85, infraDamageDealt: 0.90 },// PLACEHOLDER
  guardian:   { lootLost: 0.80, casualtiesTaken: 0.90 },        // PLACEHOLDER
  covert:     { espionageOddsBonus: 0.15, infraDamageTaken: 1.05 }, // PLACEHOLDER
  arcane:     { espionageDefenseBonus: 0.15, lootLost: 1.10 },  // PLACEHOLDER
};

const POLICY_COOLDOWN = {
  DOMESTIC_DAYS: 5,                             // PLACEHOLDER
  WAR_DAYS: 5,                                  // VERIFIED
};

// ============================================================================
// 14. COLOR TRADE BLOCS
// ============================================================================

/**
 * A coordination bonus giving alliances a purely economic reason to exist
 * beyond mutual defence — and it makes the political map readable at a glance.
 * Very low implementation cost, very high metagame payoff.
 */
const COLORS = {
  SELECTABLE: ['aqua', 'black', 'blue', 'brown', 'green', 'lime', 'maroon',
               'olive', 'orange', 'pink', 'purple', 'red', 'white', 'yellow'], // VERIFIED

  BEIGE: {
    selectable: false,                          // VERIFIED
    immuneToNewDeclarations: true,              // VERIFIED — existing wars continue
    newNationDays: 14,                          // VERIFIED
    perWarLossDays: 2,                          // VERIFIED — stacks
    oneWayExit: true,                           // VERIFIED — can never return
    // P&W has used both $50,000 and $85,000 per turn at different times.
    perTurnBonus: 50000,                        // PLACEHOLDER — pick your own
    exemptFromAllianceTax: true,                // VERIFIED
    countsTowardTotalScore: false,              // VERIFIED
  },

  GRAY: {
    selectable: false,                          // VERIFIED
    perTurnBonus: 0,                            // VERIFIED
    inactivityDays: 5,                          // VERIFIED — assigned after 5 days idle
    exemptFromAllianceTax: true,                // VERIFIED
    countsTowardTotalScore: false,              // VERIFIED
  },

  BLOC_CHANGE_COOLDOWN_TURNS: 60,               // VERIFIED — 5 days
  ALLIANCE_COLOR_CHANGE_DAYS: 14,               // VERIFIED
  DEFAULT_BLOC_BONUS: 25000,                    // PLACEHOLDER — per turn, when matching alliance
};

// ============================================================================
// 15. ALLIANCES
// ============================================================================

const ALLIANCE = {
  TAX_SENIORITY_DAYS: 2,                        // VERIFIED — must be a member 2 days to be taxed
  TAX_COLLECTION: 'per_turn',                   // VERIFIED
  MAX_TAX_BRACKETS: 10,                         // PLACEHOLDER
  BANK_HOLDS_ALL_RESOURCES: true,               // VERIFIED

  TREATY_TYPES: ['MDP', 'MDoAP', 'ODP', 'ODoAP', 'NAP', 'protectorate', 'extension'], // VERIFIED
  BLOC_MIN_SIGNATORIES: 3,                      // VERIFIED
};

// ============================================================================
// 16. MARKET
// ============================================================================

const MARKET = {
  // Pure player-driven order book. No NPC price floor or ceiling — which is
  // exactly why prices are genuinely volatile. Resist the urge to add one.
  PER_RESOURCE_ORDER_BOOKS: true,               // VERIFIED
  INSTANT_MATCH_ON_CROSS: true,                 // VERIFIED — not periodic clearing
  TRADEABLE: [...RAW_RESOURCES, ...MANUFACTURED_RESOURCES, 'credits'], // VERIFIED
  EMBARGOES_ENABLED: true,                      // VERIFIED
  MIN_PRICE: 1,                                 // DESIGN
  MAX_PRICE: 100000,                            // DESIGN
};

// ============================================================================
// 17. ANTI-ABUSE
// ============================================================================

/**
 * P&W's scar tissue, learned the hard way. Row-level locking handles the
 * MECHANICAL duping vector; none of it touches the SOCIAL vector below.
 * Build these before you have players, not after.
 */
const ANTI_ABUSE = {
  TRACK_ACCOUNT_LINKAGE: true,                  // VERIFIED — IP/device fingerprint
  LINKED_ACCOUNTS_CANNOT: [
    'war_same_target',
    'trade_with_each_other',
    'route_funds_via_intermediary',
    'share_alliance_bank_transfers',
  ],                                            // VERIFIED
  SWEETHEART_TRADE_DEVIATION_THRESHOLD: 0.35,   // DESIGN — flag trades >35% off rolling median
  AUDIT_ALLIANCE_BANK_WITHDRAWALS: true,        // DESIGN
  BANK_PROTECTION_ABUSE_PENALTY: 0.20,          // VERIFIED — 20% deleted on return
  CREDITS_PURCHASE_CAP_PER_MONTH: 20,           // VERIFIED — bounds pay-to-win
};

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  TICK,
  CITY,
  POPULATION,
  ECONOMY,
  RAW_RESOURCES,
  MANUFACTURED_RESOURCES,
  SPECIAL_RESOURCES,
  ALL_RESOURCES,
  RECIPES,
  CONTINENTS,
  STACKING,
  IMPROVEMENTS,
  FARM,
  POWER,
  POLLUTION,
  RADIATION,
  SCORE,
  WAR_RANGE,
  ESPIONAGE_RANGE,
  UNITS,
  COMBAT,
  CONTROL_STATES,
  WAR_TYPES,
  VICTORY,
  ESPIONAGE,
  PROJECTS,
  PROJECT_SCORE_VALUE,
  DOMESTIC_POLICIES,
  WAR_POLICIES,
  POLICY_COOLDOWN,
  COLORS,
  ALLIANCE,
  MARKET,
  ANTI_ABUSE,
};
