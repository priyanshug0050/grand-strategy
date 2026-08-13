/**
 * ============================================================================
 *  policy.js — national policy
 * ============================================================================
 *  Pure functions. No database, no I/O.
 *
 *  ---------------------------------------------------------------------------
 *  WHY THIS IS NOT POLITICS & WAR'S SYSTEM
 *  ---------------------------------------------------------------------------
 *  P&W has six domestic policies. Each is a flat bonus — Manifest Destiny cuts
 *  city cost 5%, Urbanisation cuts infrastructure cost 5%, and so on. None of
 *  them costs you anything.
 *
 *  A choice with no downside is not a choice. Whichever policy happens to suit
 *  your current build is simply correct, you set it once, and you never think
 *  about it again. P&W's own WAR policies get this right — Attrition trades
 *  loot for damage, Turtle trades loot for protection — and the domestic ones
 *  read as though nobody ever came back to finish them.
 *
 *  So this system has one rule, applied without exception:
 *
 *      EVERY POLICY COSTS SOMETHING.
 *
 *  If you cannot say what a policy takes away, it is not finished. There is a
 *  test that enforces this — a policy with no cost fails the suite.
 *
 *  ---------------------------------------------------------------------------
 *  THREE SLOTS, NOT ONE
 *  ---------------------------------------------------------------------------
 *  You run one ECONOMIC, one SOCIAL and one MILITARY policy at once. Fixed
 *  slots rather than "pick any three" is deliberate: free choice would mean
 *  everyone stacks three economy policies and the social and military ones
 *  would never be read. One per category forces a rounded government, and it
 *  makes a nation's policy set legible to its rivals.
 *
 *  ---------------------------------------------------------------------------
 *  HOW EFFECTS COMBINE
 *  ---------------------------------------------------------------------------
 *  Multipliers MULTIPLY (0.95 × 0.90 = 0.855), additive terms ADD. That means
 *  two −10% effects give −19%, not −20%: you can never reach zero by stacking,
 *  which is what stops a discount spiral.
 *
 *  Since only one policy per category is active, direct conflicts are rare —
 *  but projects also feed this pipeline, so the arithmetic still has to be
 *  right.
 * ============================================================================
 */

'use strict';

const C = require('./constants');

// ============================================================================
// SLOTS
// ============================================================================

const SLOTS = ['economic', 'social', 'military'];

const SLOT_INFO = {
  economic: {
    label: 'Economic',
    blurb: 'How your government treats money, industry and land.',
  },
  social: {
    label: 'Social',
    blurb: 'How it treats the people who live in your cities.',
  },
  military: {
    label: 'Military',
    blurb: 'How it raises, supplies and spends an army.',
  },
};

// ============================================================================
// EFFECT VOCABULARY
// ============================================================================

/**
 * Every lever a policy is allowed to pull, and what it means.
 *
 * Keeping this list explicit is what stops policies from quietly inventing new
 * mechanics. A policy is a COEFFICIENT on something the engine already does —
 * the same discipline that lets ~30 projects exist without the codebase
 * exploding.
 *
 *   `better`  which direction is good for the player, so the UI can colour it
 *   `unit`    'multiplier' (1.05 = +5%) or 'flat' (added directly)
 */
const EFFECT_KEYS = {
  grossIncomeMultiplier:      { label: 'gross income',           better: 'higher', unit: 'multiplier' },
  improvementUpkeepMultiplier:{ label: 'building upkeep',        better: 'lower',  unit: 'multiplier' },
  infraCostMultiplier:        { label: 'infrastructure cost',    better: 'lower',  unit: 'multiplier' },
  landCostMultiplier:         { label: 'land cost',              better: 'lower',  unit: 'multiplier' },
  cityCostMultiplier:         { label: 'new city cost',          better: 'lower',  unit: 'multiplier' },
  projectCostMultiplier:      { label: 'project cost',           better: 'lower',  unit: 'multiplier' },
  rawProductionMultiplier:    { label: 'mine and farm output',   better: 'higher', unit: 'multiplier' },
  manufacturingMultiplier:    { label: 'refinery output',        better: 'higher', unit: 'multiplier' },
  commerceMultiplier:         { label: 'commerce',               better: 'higher', unit: 'multiplier' },
  materialCostMultiplier:     { label: 'building material cost', better: 'lower',  unit: 'multiplier' },

  diseaseFlat:                { label: 'disease',                better: 'lower',  unit: 'flat', suffix: '%' },
  crimeFlat:                  { label: 'crime',                  better: 'lower',  unit: 'flat', suffix: '%' },
  pollutionMultiplier:        { label: 'pollution',              better: 'lower',  unit: 'multiplier' },
  ageBonusMultiplier:         { label: 'city age bonus',         better: 'higher', unit: 'multiplier' },
  foodConsumptionMultiplier:  { label: 'food eaten',             better: 'lower',  unit: 'multiplier' },

  unitUpkeepMultiplier:       { label: 'military upkeep',        better: 'lower',  unit: 'multiplier' },
  recruitmentMultiplier:      { label: 'recruitment rate',       better: 'higher', unit: 'multiplier' },
  infraDamageDealtMultiplier: { label: 'damage you deal',        better: 'higher', unit: 'multiplier' },
  infraDamageTakenMultiplier: { label: 'damage you take',        better: 'lower',  unit: 'multiplier' },
  lootReceivedMultiplier:     { label: 'loot you take',          better: 'higher', unit: 'multiplier' },
  lootLostMultiplier:         { label: 'loot you lose',          better: 'lower',  unit: 'multiplier' },
  casualtiesTakenMultiplier:  { label: 'your casualties',        better: 'lower',  unit: 'multiplier' },
  espionageOddsMultiplier:    { label: 'espionage odds',         better: 'higher', unit: 'multiplier' },
};

// ============================================================================
// THE POLICIES
// ============================================================================

/**
 * Six per slot. Each has a `gain` and a `cost` — never only a gain.
 *
 * The flavour text is not decoration. A player who reads "the state stops
 * subsidising industry" understands why income rises and output falls, and
 * will remember the tradeoff without re-reading the numbers.
 */
const POLICIES = {

  // ---------------------------------------------------------------- ECONOMIC
  laissez_faire: {
    slot: 'economic',
    name: 'Laissez-Faire',
    summary: 'Government steps back. Trade thrives, industry is left to fend for itself.',
    gain: { grossIncomeMultiplier: 1.06 },
    cost: { rawProductionMultiplier: 0.90 },
  },
  state_industry: {
    slot: 'economic',
    name: 'State Industry',
    summary: 'Refineries run under state direction — more output, at the cost of a taxed and throttled market.',
    gain: { manufacturingMultiplier: 1.15 },
    cost: { grossIncomeMultiplier: 0.92 },
  },
  urbanisation: {
    slot: 'economic',
    name: 'Urbanisation',
    summary: 'Cheap, fast construction. Nobody stops to ask what it does to the air.',
    gain: { infraCostMultiplier: 0.92 },
    cost: { pollutionMultiplier: 1.15 },
  },
  agrarian_reform: {
    slot: 'economic',
    name: 'Agrarian Reform',
    summary: 'Land redistributed to farmers. Fields flourish; the cities that trade with them do not.',
    gain: { landCostMultiplier: 0.90, rawProductionMultiplier: 1.08 },
    cost: { commerceMultiplier: 0.95 },
  },
  manifest_destiny: {
    slot: 'economic',
    name: 'Manifest Destiny',
    summary: 'Expansion above all. New cities are cheap; the ones you already hold are neglected.',
    gain: { cityCostMultiplier: 0.92 },
    cost: { infraCostMultiplier: 1.08 },
  },
  austerity: {
    slot: 'economic',
    name: 'Austerity',
    summary: 'Budgets cut everywhere. Buildings cost less to run, and the economy runs colder.',
    gain: { improvementUpkeepMultiplier: 0.85 },
    cost: { grossIncomeMultiplier: 0.95 },
  },

  // ------------------------------------------------------------------ SOCIAL
  public_health: {
    slot: 'social',
    name: 'Public Health',
    summary: 'Clinics in every district. Fewer people die; the bill lands on your buildings.',
    gain: { diseaseFlat: -1.5 },
    cost: { improvementUpkeepMultiplier: 1.12 },
  },
  police_state: {
    slot: 'social',
    name: 'Police State',
    summary: 'Order enforced hard. Crime collapses, and so does the informal trade that fed your cities.',
    gain: { crimeFlat: -3 },
    cost: { grossIncomeMultiplier: 0.96 },
  },
  open_borders: {
    slot: 'social',
    name: 'Open Borders',
    summary: 'Anyone may settle. Cities fill faster than their sanitation can cope.',
    gain: { ageBonusMultiplier: 1.08 },
    cost: { diseaseFlat: 1.0 },
  },
  rationing: {
    slot: 'social',
    name: 'Rationing',
    summary: 'Food is measured out. Stores last far longer; nobody enjoys it.',
    gain: { foodConsumptionMultiplier: 0.75 },
    cost: { grossIncomeMultiplier: 0.95 },
  },
  green_initiative: {
    slot: 'social',
    name: 'Green Initiative',
    summary: 'Emissions capped. The air clears and the refineries slow to a crawl.',
    gain: { pollutionMultiplier: 0.80 },
    cost: { manufacturingMultiplier: 0.90 },
  },
  free_press: {
    slot: 'social',
    name: 'Free Press',
    summary: 'Information moves freely. So does commerce — and so do the people exploiting it.',
    gain: { commerceMultiplier: 1.05 },
    cost: { crimeFlat: 1.0 },
  },

  // ---------------------------------------------------------------- MILITARY
  standing_army: {
    slot: 'military',
    name: 'Standing Army',
    summary: 'A small professional force. Cheap to keep, slow to grow.',
    gain: { unitUpkeepMultiplier: 0.80 },
    cost: { recruitmentMultiplier: 0.90 },
  },
  total_mobilisation: {
    slot: 'military',
    name: 'Total Mobilisation',
    summary: 'The whole nation is a recruiting ground. You will fill your barracks and empty your treasury.',
    gain: { recruitmentMultiplier: 1.25 },
    cost: { unitUpkeepMultiplier: 1.30 },
  },
  fortress_doctrine: {
    slot: 'military',
    name: 'Fortress Doctrine',
    summary: 'Dig in and hold. Your cities survive what would flatten others; your offensives crawl.',
    gain: { infraDamageTakenMultiplier: 0.88 },
    cost: { infraDamageDealtMultiplier: 0.90 },
  },
  blitzkrieg: {
    slot: 'military',
    name: 'Blitzkrieg',
    summary: 'Hit hard, hit first, accept the butcher\u2019s bill.',
    gain: { infraDamageDealtMultiplier: 1.12 },
    cost: { casualtiesTakenMultiplier: 1.15 },
  },
  privateering: {
    slot: 'military',
    name: 'Privateering',
    summary: 'War for profit. You come home rich, having broken very little.',
    gain: { lootReceivedMultiplier: 1.25 },
    cost: { infraDamageDealtMultiplier: 0.85 },
  },
  deep_cover: {
    slot: 'military',
    name: 'Deep Cover',
    summary: 'Budget shifted from barracks to back rooms.',
    gain: { espionageOddsMultiplier: 1.20 },
    cost: { recruitmentMultiplier: 0.90 },
  },
};

// ============================================================================
// AGGREGATION
// ============================================================================

/** Every effect key at its neutral value. */
function neutralEffects() {
  const out = {};
  for (const [key, def] of Object.entries(EFFECT_KEYS)) {
    out[key] = def.unit === 'multiplier' ? 1 : 0;
  }
  return out;
}

/**
 * Collapse a policy set into one flat effect object.
 *
 * This is the function the rest of the engine consumes. Nothing outside this
 * file needs to know which policies exist — only what multipliers came out.
 *
 * @param {Object} active  { economic: 'austerity', social: null, military: ... }
 * @param {Object} opts    { amplification: 0.5 }  Government Support Agency etc.
 */
function policyEffects(active = {}, opts = {}) {
  const effects = neutralEffects();
  const amplification = opts.amplification || 0;
  const applied = [];
  const unknown = [];

  for (const slot of SLOTS) {
    const key = active[slot];
    if (!key) continue;

    const policy = POLICIES[key];
    if (!policy) { unknown.push(key); continue; }
    if (policy.slot !== slot) { unknown.push(key); continue; }

    // Amplification (from projects) strengthens the GAIN only. Amplifying the
    // cost too would make the project a wash; amplifying nothing would make it
    // pointless. Strengthening only the upside is what players expect from a
    // "policy support" project, and it keeps the tradeoff intact.
    for (const [effectKey, value] of Object.entries(policy.gain)) {
      applyEffect(effects, effectKey, value, amplification);
    }
    for (const [effectKey, value] of Object.entries(policy.cost)) {
      applyEffect(effects, effectKey, value, 0);
    }

    applied.push(key);
  }

  return { effects, applied, unknown };
}

function applyEffect(effects, key, value, amplification) {
  const def = EFFECT_KEYS[key];
  if (!def) throw new Error(`Policy uses unknown effect "${key}" — add it to EFFECT_KEYS or fix the policy`);

  if (def.unit === 'multiplier') {
    // Amplify the DEVIATION from 1, not the value: 0.92 amplified by 50%
    // becomes 0.88, not 1.38.
    const deviation = (value - 1) * (1 + amplification);
    effects[key] *= 1 + deviation;
  } else {
    effects[key] += value * (1 + amplification);
  }
}

// ============================================================================
// VALIDATION & COOLDOWN
// ============================================================================

function isValidPolicy(key, slot) {
  const p = POLICIES[key];
  if (!p) return false;
  return slot ? p.slot === slot : true;
}

/**
 * Can this slot be changed yet?
 *
 * Cooldowns exist because switching would otherwise be free: a player would
 * run Blitzkrieg while attacking and Fortress Doctrine the moment they were
 * attacked, and every tradeoff in the file would mean nothing.
 */
function canChangePolicy(slot, lastChangedTurn, currentTurn) {
  if (!SLOTS.includes(slot)) {
    return { ok: false, reason: `Unknown policy slot: ${slot}` };
  }
  if (lastChangedTurn === null || lastChangedTurn === undefined) {
    return { ok: true };
  }

  const days = slot === 'military'
    ? C.POLICY_COOLDOWN.WAR_DAYS
    : C.POLICY_COOLDOWN.DOMESTIC_DAYS;
  const requiredTurns = days * C.TICK.TURNS_PER_DAY;
  const elapsed = currentTurn - lastChangedTurn;

  if (elapsed < requiredTurns) {
    const remaining = requiredTurns - elapsed;
    return {
      ok: false,
      reason: `${SLOT_INFO[slot].label} policy is locked for ${days} days after a change`,
      turnsRemaining: remaining,
      daysRemaining: Math.ceil(remaining / C.TICK.TURNS_PER_DAY),
    };
  }
  return { ok: true };
}

// ============================================================================
// DESCRIPTION — for the UI and the wiki page
// ============================================================================

/** One effect rendered as human text, plus whether it helps or hurts. */
function describeEffect(key, value) {
  const def = EFFECT_KEYS[key];
  if (!def) return null;

  let text, good;
  if (def.unit === 'multiplier') {
    const pct = (value - 1) * 100;
    const rounded = Math.round(pct * 10) / 10;
    text = `${rounded > 0 ? '+' : ''}${rounded}% ${def.label}`;
    good = def.better === 'higher' ? pct > 0 : pct < 0;
  } else {
    const rounded = Math.round(value * 10) / 10;
    text = `${rounded > 0 ? '+' : ''}${rounded}${def.suffix || ''} ${def.label}`;
    good = def.better === 'higher' ? value > 0 : value < 0;
  }
  return { key, label: def.label, value, text, good };
}

/** Everything the UI needs to render one policy card. */
function describePolicy(key) {
  const p = POLICIES[key];
  if (!p) return null;

  return {
    key,
    slot: p.slot,
    name: p.name,
    summary: p.summary,
    gain: Object.entries(p.gain).map(([k, v]) => describeEffect(k, v)).filter(Boolean),
    cost: Object.entries(p.cost).map(([k, v]) => describeEffect(k, v)).filter(Boolean),
  };
}

/** Every policy, grouped by slot — the whole catalogue in one call. */
function catalogue() {
  const out = {};
  for (const slot of SLOTS) {
    out[slot] = {
      ...SLOT_INFO[slot],
      policies: Object.keys(POLICIES)
        .filter(k => POLICIES[k].slot === slot)
        .map(describePolicy),
    };
  }
  return out;
}

/**
 * Compare two policy sets, effect by effect.
 *
 * Swapping a policy changes several unrelated numbers at once, and a player
 * should see all of them before committing rather than discovering the third
 * one a day later.
 */
function comparePolicies(current, proposed, opts = {}) {
  const before = policyEffects(current, opts).effects;
  const after = policyEffects(proposed, opts).effects;

  const changes = [];
  for (const [key, def] of Object.entries(EFFECT_KEYS)) {
    if (Math.abs(after[key] - before[key]) < 1e-9) continue;

    const delta = def.unit === 'multiplier'
      ? (after[key] / before[key] - 1) * 100
      : after[key] - before[key];

    const improved = def.better === 'higher' ? delta > 0 : delta < 0;
    const rounded = Math.round(delta * 10) / 10;

    changes.push({
      key,
      label: def.label,
      before: before[key],
      after: after[key],
      delta: rounded,
      text: `${rounded > 0 ? '+' : ''}${rounded}${def.unit === 'multiplier' ? '%' : (def.suffix || '')} ${def.label}`,
      improved,
    });
  }

  return changes;
}

module.exports = {
  SLOTS,
  SLOT_INFO,
  EFFECT_KEYS,
  POLICIES,

  neutralEffects,
  policyEffects,
  isValidPolicy,
  canChangePolicy,

  describeEffect,
  describePolicy,
  catalogue,
  comparePolicies,
};
