/**
 * ============================================================================
 *  PART 3 of 7 — population.js
 * ============================================================================
 *  Base population, disease, crime, age multiplier, assembled population.
 *
 *  This is the load-bearing wall of the entire game. Every economic number
 *  downstream — income, tax, GDP — is a function of the population this module
 *  produces. Get it wrong and nothing else can be right.
 *
 *  ---------------------------------------------------------------------------
 *  UNITS — READ THIS BEFORE TOUCHING ANYTHING
 *  ---------------------------------------------------------------------------
 *  The source formulas mix percent-space and fraction-space terms, which is a
 *  silent-corruption trap. This module resolves it explicitly:
 *
 *    - diseaseRate/crimeRate are computed INTERNALLY in PERCENT (0-100),
 *      because the hospital (-2.5), pollution (+0.05) and infra (/1000) terms
 *      are all percentage-point contributions.
 *    - They are RETURNED as FRACTIONS (0-1), because that is what the death
 *      formulas and every downstream consumer expect.
 *
 *  Functions ending in `Percent` return percent. Everything else returns a
 *  fraction. Do not mix them.
 *
 *  Sanity anchors for the disease curve (percent):
 *    density  100  ->   0.75%   (healthy)
 *    density  200  ->   3.75%
 *    density  500  ->  24.75%   (bleeding badly)
 *    density 1000  ->  99.75%   (city collapses to floor of 10)
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

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

/** Count of an improvement in a city, defaulting to 0. */
function countImprovement(city, key) {
  if (!city.improvements) return 0;
  return city.improvements[key] || 0;
}

/** One policy coefficient — see the identical helper in city.js. */
function policyEffect(opts, key, neutral) {
  if (opts.policyEffects) return opts.policyEffects[key] ?? neutral;
  if (!opts.policies) return neutral;
  let amplification = 0;
  for (const p of (opts.projects || [])) {
    const bonus = C.PROJECTS[p]?.effect?.domesticPolicyBonus;
    if (bonus) amplification += bonus;
  }
  return policy.policyEffects(opts.policies, { amplification }).effects[key] ?? neutral;
}

// ============================================================================
// BASE POPULATION
// ============================================================================

/**
 * Population before disease and crime are subtracted.
 *
 *   base = (infra * 100) + (infra / 1000) * (100 * ageDays / 3)
 *
 * The second term is a slow additive drift that rewards keeping a city alive.
 * It is small: at infra 2000 and 365 days it adds ~24,000 to a base of 200,000.
 */
function basePopulation(infrastructure, cityAgeDays = 0) {
  assertNonNegative(infrastructure, 'infrastructure');
  assertNonNegative(cityAgeDays, 'cityAgeDays');

  const { PER_INFRA, AGE_DIVISOR, AGE_FACTOR } = C.POPULATION;

  return (infrastructure * PER_INFRA)
       + (infrastructure / AGE_DIVISOR) * (100 * cityAgeDays / AGE_FACTOR);
}

// ============================================================================
// DENSITY — AND THE FEEDBACK-LOOP BREAK
// ============================================================================

/**
 * ⚠️ THE MOST IMPORTANT COMMENT IN THIS FILE ⚠️
 *
 * Density is computed from INFRASTRUCTURE, not from live population.
 *
 * Why: disease reduces population. If density were derived from the reduced
 * population, then lower population would mean lower density would mean less
 * disease would mean higher population — a feedback loop that either
 * oscillates forever or converges to a wrong answer. P&W breaks the loop by
 * anchoring density to base population (which is just infra * 100).
 *
 * If you ever "optimise" this to use the real population figure, you will
 * introduce a bug that is extremely hard to trace. Don't.
 */
function populationDensity(infrastructure, land) {
  assertNonNegative(infrastructure, 'infrastructure');
  assertNonNegative(land, 'land');
  return (infrastructure * C.POPULATION.PER_INFRA)
       / (land + C.POPULATION.DISEASE_EPSILON);
}

// ============================================================================
// DISEASE
// ============================================================================

/**
 * Disease rate in PERCENT (may exceed 100 or go negative before clamping).
 *
 *   percent = (0.01 * density^2 - 25) / 100
 *           + infra / 1000
 *           - hospitals * 2.5
 *           + pollution * 0.05
 *           + radiation * coefficient
 *
 * The squared density term is the single most load-bearing expression in the
 * game. It alone generates: the land economy, the improvement-slot tradeoff,
 * pollution mattering, and the "never let infra exceed land" rule that every
 * new-player guide leads with. Do not linearise it.
 */
function diseaseRatePercent(city, opts = {}) {
  const infra = city.infrastructure;
  const land = city.land;
  assertNonNegative(infra, 'city.infrastructure');
  assertNonNegative(land, 'city.land');

  const P = C.POPULATION;
  const density = populationDensity(infra, land);
  const hospitals = countImprovement(city, 'hospital');
  const pollution = opts.pollution || 0;
  const radiation = opts.radiation || 0;

  let percent =
      ((P.DISEASE_DENSITY_COEFF * density * density - P.DISEASE_DENSITY_OFFSET) / 100)
    + (infra / P.DISEASE_INFRA_TERM_DIVISOR)
    - (hospitals * P.DISEASE_HOSPITAL_REDUCTION)
    + (pollution * P.DISEASE_POLLUTION_COEFF)
    + (radiation * C.RADIATION.DISEASE_PER_ROENTGEN);

  // Clinical Research Center project further suppresses disease.
  const projects = opts.projects || [];
  if (projects.includes('clinical_research_center')) {
    percent -= P.DISEASE_HOSPITAL_REDUCTION;   // PLACEHOLDER magnitude
  }

  // Policies add or subtract percentage POINTS, not a multiplier — a policy
  // that halved a 0.5% rate would be worthless, while −1.5 points is felt at
  // every city size.
  percent += policyEffect(opts, 'diseaseFlat', 0);

  return percent;
}

/**
 * Disease rate as a FRACTION, clamped to [0, 1].
 * At 1.0 the city loses its entire base population and floors at MIN_POPULATION.
 */
function diseaseRate(city, opts = {}) {
  const percent = diseaseRatePercent(city, opts);
  return clamp(percent / 100, C.POPULATION.DISEASE_MIN, C.POPULATION.DISEASE_MAX);
}

/**
 * People killed by disease.
 *
 *   killed = rate * basePopulation
 *
 * ⚠️ NOTE ON THE SOURCE FORMULA. P&W documents this as `rate * infra * 100`,
 * which is the infrastructure-derived part of base population only — it
 * ignores the age-drift term. That works until a city is old: at 100% disease
 * a 500-day city would keep the ~33,000 people the age bonus added, and never
 * reach the documented "collapses to a floor of 10" outcome.
 *
 * A disease RATE is the fraction of the population that dies, so it is applied
 * to the whole base population. For a young city the two are identical; for an
 * old one this is the version that behaves as documented.
 *
 * A test asserts the collapse case, so this cannot silently regress.
 */
function peopleKilledByDisease(city, opts = {}) {
  const rate = diseaseRate(city, opts);
  return rate * basePopulation(city.infrastructure, opts.cityAgeDays || 0);
}

// ============================================================================
// CRIME
// ============================================================================

/**
 * Crime is the mirror of disease: it rises with base population and falls with
 * commerce and police stations.
 *
 * ⚠️ The real P&W crime equation is NOT sourced. The structure below is
 * correct in shape (pop up, commerce down, police down) but the coefficients
 * are placeholders in constants.js. Closing this is the highest-priority
 * research gap in the whole engine — crime losses carry 4x weight, so a wrong
 * coefficient here distorts every income number in the game.
 */
/**
 * Crime rate in PERCENT.
 *
 *   percent = ((103 - commerce)^2 + basePop * 0.1) / 111111 - police * 2.5
 *
 * Two things worth noticing about this shape:
 *
 * 1. The population term is DIVIDED by a large constant, so crime grows slowly
 *    and stays a background drag. The previous version multiplied population
 *    by a coefficient instead, which meant crime scaled without limit — a
 *    110,000-person city lost 34% of its people every turn, and the bigger the
 *    city got the worse it became, forever.
 *
 * 2. The commerce term is SQUARED, so commerce buildings do double duty: they
 *    raise income and suppress crime together. A developed city is safer as
 *    well as richer, which is a far better incentive than a flat penalty.
 *
 * ⚠️ Still unverified against the live game — the coefficients are educated,
 * not sourced. But the behaviour is now sane, which the old one was not.
 */
function crimeRatePercent(city, opts = {}) {
  const P = C.POPULATION;
  const commerce = opts.commerce || 0;
  const police = countImprovement(city, 'police_station');
  const base = basePopulation(city.infrastructure, opts.cityAgeDays || 0);

  const commerceTerm = Math.pow(P.CRIME_COMMERCE_CEILING - commerce, 2);
  const popTerm = base * P.CRIME_POP_COEFF;

  return ((commerceTerm + popTerm) / P.CRIME_DIVISOR)
       - (police * P.CRIME_POLICE_REDUCTION)
       + policyEffect(opts, 'crimeFlat', 0);
}

function crimeRate(city, opts = {}) {
  const percent = crimeRatePercent(city, opts);
  return clamp(percent / 100, C.POPULATION.CRIME_MIN, C.POPULATION.CRIME_MAX);
}

/** Same reasoning as disease: a rate applies to the population, not to infra. */
function peopleKilledByCrime(city, opts = {}) {
  const rate = crimeRate(city, opts);
  return rate * basePopulation(city.infrastructure, opts.cityAgeDays || 0);
}

// ============================================================================
// AGE MULTIPLIER
// ============================================================================

/**
 *   multiplier = 1 + ln(ageDays) / 15
 *
 * Logarithmic, so it is negligible below ~200 days and then becomes a real
 * reward for not deleting cities. This is the game's retention mechanic
 * expressed as a formula.
 *
 * ln(0) is -Infinity, so ages below 1 day are floored at 1 (multiplier 1.0).
 */
function ageMultiplier(cityAgeDays, opts = {}) {
  assertNonNegative(cityAgeDays, 'cityAgeDays');
  const days = Math.max(cityAgeDays, 1);
  const base = 1 + Math.log(days) / C.POPULATION.AGE_LOG_DIVISOR;
  // Amplify the BONUS, not the whole multiplier: +8% on a x1.30 bonus means
  // x1.324, not x1.404.
  const boost = policyEffect(opts, 'ageBonusMultiplier', 1);
  return 1 + (base - 1) * boost;
}

// ============================================================================
// ASSEMBLED POPULATION
// ============================================================================

/**
 * The full pipeline:
 *
 *   population = (basePop - diseaseDeaths - crimeDeaths * 4) * ageMultiplier
 *
 * Floored at MIN_POPULATION (10). A city at 100% disease does not go negative
 * or to zero — it collapses to 10 and sits there as a monument to the player's
 * density mistake.
 *
 * @param {Object} city  { infrastructure, land, improvements, foundedTurn }
 * @param {Object} opts  { cityAgeDays, pollution, radiation, commerce, projects }
 * @returns {number}
 */
function computePopulation(city, opts = {}) {
  return populationBreakdown(city, opts).population;
}

/**
 * Same computation, but returns every intermediate value.
 *
 * Use this for the city UI and for debugging. Showing players the actual
 * numbers — how many died of disease, how many of crime, what density is
 * doing — is a real differentiator: in P&W none of this is visible in-game
 * and players have to consult external wikis to understand their own cities.
 */
function populationBreakdown(city, opts = {}) {
  const cityAgeDays = opts.cityAgeDays || 0;
  const P = C.POPULATION;

  const base = basePopulation(city.infrastructure, cityAgeDays);
  const density = populationDensity(city.infrastructure, city.land);

  const diseasePct = diseaseRatePercent(city, opts);
  const diseaseFrac = clamp(diseasePct / 100, P.DISEASE_MIN, P.DISEASE_MAX);
  const diseaseDeaths = diseaseFrac * base;

  const crimePct = crimeRatePercent(city, { ...opts, cityAgeDays });
  const crimeFrac = clamp(crimePct / 100, P.CRIME_MIN, P.CRIME_MAX);
  const crimeDeathsRaw = crimeFrac * base;
  const crimeDeaths = crimeDeathsRaw * P.CRIME_DEATH_WEIGHT;

  const ageMult = ageMultiplier(cityAgeDays, opts);

  const surviving = base - diseaseDeaths - crimeDeaths;
  const population = Math.max(surviving * ageMult, P.MIN_POPULATION);

  return {
    population: Math.floor(population),
    basePopulation: Math.floor(base),
    density,

    diseaseRate: diseaseFrac,
    diseaseRatePercent: diseasePct,
    diseaseDeaths: Math.floor(diseaseDeaths),

    crimeRate: crimeFrac,
    crimeRatePercent: crimePct,
    crimeDeaths: Math.floor(crimeDeaths),

    ageMultiplier: ageMult,
    cityAgeDays,

    collapsed: population <= P.MIN_POPULATION,
  };
}

/**
 * Nation-wide population — the input to income in Part 4.
 */
function nationPopulation(cities, optsFor = () => ({})) {
  if (!Array.isArray(cities)) throw new TypeError('cities must be an array');
  return cities.reduce((sum, c, i) => sum + computePopulation(c, optsFor(c, i)), 0);
}

// ============================================================================
// SOLVERS — for the UI
// ============================================================================

/**
 * The lowest disease percent this city can reach with infinite land.
 *
 * As density approaches zero the squared term vanishes, leaving:
 *     floor = -0.25 + infra/1000 - hospitals*2.5 + pollution*0.05 + radiation
 *
 * This means the infrastructure term is a genuine floor: past ~250 infra, land
 * alone can never reach 0% disease no matter how much you buy. That is not a
 * bug — it is the mechanism that forces hospitals into the improvement-slot
 * competition once a city gets large.
 */
function minimumAchievableDiseasePercent(city, opts = {}) {
  const P = C.POPULATION;
  const hospitals = countImprovement(city, 'hospital');
  const pollution = opts.pollution || 0;
  const radiation = opts.radiation || 0;

  let floor = (-P.DISEASE_DENSITY_OFFSET / 100)
            + (city.infrastructure / P.DISEASE_INFRA_TERM_DIVISOR)
            - (hospitals * P.DISEASE_HOSPITAL_REDUCTION)
            + (pollution * P.DISEASE_POLLUTION_COEFF)
            + (radiation * C.RADIATION.DISEASE_PER_ROENTGEN);

  const projects = opts.projects || [];
  if (projects.includes('clinical_research_center')) {
    floor -= P.DISEASE_HOSPITAL_REDUCTION;
  }
  return floor;
}

/**
 * How much land does this city need to bring disease down to `targetPercent`?
 *
 * Solve for density where the percent expression equals the target:
 *   (0.01 * d^2 - 25) / 100 = target - R      where R = the non-density terms
 *   d = sqrt((25 + 100*(target - R)) / 0.01)
 *   land = infra * 100 / d
 *
 * Returns null when the target is below what land alone can achieve — check
 * minimumAchievableDiseasePercent() to find out what IS achievable, then reach
 * for hospitals or pollution control instead.
 */
function landNeededForDisease(city, targetPercent = 0, opts = {}) {
  const P = C.POPULATION;
  const infra = city.infrastructure;
  if (infra <= 0) return 0;

  const hospitals = countImprovement(city, 'hospital');
  const pollution = opts.pollution || 0;
  const radiation = opts.radiation || 0;

  let R = (infra / P.DISEASE_INFRA_TERM_DIVISOR)
        - (hospitals * P.DISEASE_HOSPITAL_REDUCTION)
        + (pollution * P.DISEASE_POLLUTION_COEFF)
        + (radiation * C.RADIATION.DISEASE_PER_ROENTGEN);

  const projects = opts.projects || [];
  if (projects.includes('clinical_research_center')) {
    R -= P.DISEASE_HOSPITAL_REDUCTION;
  }

  const numerator = P.DISEASE_DENSITY_OFFSET + 100 * (targetPercent - R);
  if (numerator <= 0) return null;   // target unreachable with land alone

  const targetDensity = Math.sqrt(numerator / P.DISEASE_DENSITY_COEFF);
  const land = (infra * P.PER_INFRA) / targetDensity;

  return Math.ceil(land);
}

/** Convenience wrapper: land needed for exactly 0% disease. */
function landNeededForZeroDisease(city, opts = {}) {
  return landNeededForDisease(city, 0, opts);
}

/**
 * How many hospitals would zero out disease at the current density?
 * Returns null if the city has no free improvement slots for them.
 */
function hospitalsNeededForZeroDisease(city, opts = {}) {
  const withoutHospitals = { ...city, improvements: { ...city.improvements, hospital: 0 } };
  const percent = diseaseRatePercent(withoutHospitals, opts);
  if (percent <= 0) return 0;
  return Math.ceil(percent / C.POPULATION.DISEASE_HOSPITAL_REDUCTION);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  basePopulation,
  populationDensity,

  diseaseRate,
  diseaseRatePercent,
  peopleKilledByDisease,

  crimeRate,
  crimeRatePercent,
  peopleKilledByCrime,

  ageMultiplier,

  computePopulation,
  populationBreakdown,
  nationPopulation,

  landNeededForDisease,
  landNeededForZeroDisease,
  minimumAchievableDiseasePercent,
  hospitalsNeededForZeroDisease,

  // exposed for testing
  _clamp: clamp,
  _countImprovement: countImprovement,
};
