const policy = require('../src/engine/policy');
const C = require('../src/engine/constants');
const city = require('../src/engine/city');
const eco = require('../src/engine/economy');
const pop = require('../src/engine/population');
const cbt = require('../src/engine/combat');

let pass = 0, fail = 0;
function t(n, f) { try { f(); console.log('  PASS ' + n); pass++; } catch (e) { console.log('  FAIL ' + n + ' -> ' + e.message); fail++; } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || ''} expected ${b}, got ${a}`); }
function approx(a, b, tol, m) { if (Math.abs(a - b) > tol) throw new Error(`${m || ''} expected ~${b}, got ${a}`); }

console.log('\n-- THE ONE RULE: every policy costs something --');

t('EVERY policy has a cost, not just a gain', () => {
  // This is the whole design. A policy with no downside is not a choice — it
  // is simply correct, and the slot stops being interesting forever.
  const free = [];
  for (const [key, p] of Object.entries(policy.POLICIES)) {
    if (!p.cost || Object.keys(p.cost).length === 0) free.push(key);
  }
  if (free.length) throw new Error(`policies with no cost: ${free.join(', ')}`);
});

t('every policy also has a gain', () => {
  for (const [key, p] of Object.entries(policy.POLICIES)) {
    if (!p.gain || Object.keys(p.gain).length === 0) {
      throw new Error(`${key} has no gain — nobody would ever pick it`);
    }
  }
});

t('every effect key a policy uses is declared', () => {
  for (const [key, p] of Object.entries(policy.POLICIES)) {
    for (const effectKey of [...Object.keys(p.gain), ...Object.keys(p.cost)]) {
      if (!policy.EFFECT_KEYS[effectKey]) {
        throw new Error(`${key} uses undeclared effect "${effectKey}"`);
      }
    }
  }
});

t('every policy belongs to a real slot', () => {
  for (const [key, p] of Object.entries(policy.POLICIES)) {
    if (!policy.SLOTS.includes(p.slot)) throw new Error(`${key} has slot "${p.slot}"`);
  }
});

t('every slot has options (no empty menus)', () => {
  for (const slot of policy.SLOTS) {
    const count = Object.values(policy.POLICIES).filter(p => p.slot === slot).length;
    if (count < 2) throw new Error(`${slot} has only ${count} policy — that is not a choice`);
  }
});

console.log('\n-- Aggregation --');

t('no policies = perfectly neutral', () => {
  const { effects } = policy.policyEffects({});
  for (const [key, def] of Object.entries(policy.EFFECT_KEYS)) {
    const neutral = def.unit === 'multiplier' ? 1 : 0;
    if (effects[key] !== neutral) throw new Error(`${key} = ${effects[key]}, expected ${neutral}`);
  }
});

t('one per slot, all three apply together', () => {
  const r = policy.policyEffects({
    economic: 'austerity', social: 'public_health', military: 'standing_army',
  });
  eq(r.applied.length, 3);
  approx(r.effects.improvementUpkeepMultiplier, 0.85 * 1.12, 1e-9, 'austerity x public health:');
  approx(r.effects.unitUpkeepMultiplier, 0.80, 1e-9);
  approx(r.effects.diseaseFlat, -1.5, 1e-9);
});

t('multipliers MULTIPLY, so stacking never reaches zero', () => {
  // Two -10% effects give -19%, not -20%. That is what stops a discount spiral.
  const a = 0.9, b = 0.9;
  approx(a * b, 0.81, 1e-9);
  const r = policy.policyEffects({ economic: 'austerity', social: 'police_state' });
  approx(r.effects.grossIncomeMultiplier, 0.95 * 0.96, 1e-9);
});

t('a policy in the wrong slot is rejected, not silently applied', () => {
  const r = policy.policyEffects({ social: 'austerity' });   // economic policy
  eq(r.applied.length, 0);
  eq(r.unknown[0], 'austerity');
});

t('unknown policy names are reported, not crashed on', () => {
  const r = policy.policyEffects({ economic: 'communism_but_with_dragons' });
  eq(r.unknown.length, 1);
  eq(r.applied.length, 0);
});

console.log('\n-- Amplification (projects) --');

t('amplifies the GAIN only, never the cost', () => {
  // Amplifying both would make the project a wash; amplifying neither would
  // make it pointless. Only the upside grows.
  const plain = policy.policyEffects({ economic: 'austerity' }).effects;
  const amped = policy.policyEffects({ economic: 'austerity' }, { amplification: 0.5 }).effects;

  // gain: upkeep 0.85 -> deviation -0.15 amplified to -0.225 -> 0.775
  approx(amped.improvementUpkeepMultiplier, 0.775, 1e-9, 'gain should amplify:');
  // cost: income stays exactly 0.95
  approx(amped.grossIncomeMultiplier, plain.grossIncomeMultiplier, 1e-9, 'cost must NOT amplify:');
});

t('amplifies the deviation, not the raw value', () => {
  // 0.92 amplified 50% must become 0.88, not 1.38.
  const r = policy.policyEffects({ economic: 'urbanisation' }, { amplification: 0.5 }).effects;
  approx(r.infraCostMultiplier, 0.88, 1e-9);
});

console.log('\n-- Cooldown --');

t('a fresh slot can be set immediately', () => {
  eq(policy.canChangePolicy('economic', null, 100).ok, true);
});

t('locked right after a change', () => {
  const r = policy.canChangePolicy('economic', 100, 110);
  eq(r.ok, false);
  if (!r.daysRemaining) throw new Error('no days remaining reported');
});

t('free again once the cooldown elapses', () => {
  const turns = C.POLICY_COOLDOWN.DOMESTIC_DAYS * C.TICK.TURNS_PER_DAY;
  eq(policy.canChangePolicy('economic', 100, 100 + turns).ok, true);
});

t('unknown slot rejected', () => {
  eq(policy.canChangePolicy('vibes', null, 100).ok, false);
});

console.log('\n-- Description --');

t('every policy renders gain and cost as readable text', () => {
  for (const key of Object.keys(policy.POLICIES)) {
    const d = policy.describePolicy(key);
    if (!d.gain.length) throw new Error(`${key}: no gain text`);
    if (!d.cost.length) throw new Error(`${key}: no cost text`);
    for (const e of [...d.gain, ...d.cost]) {
      if (!e.text || e.text.includes('undefined')) throw new Error(`${key}: bad text "${e.text}"`);
    }
  }
});

t('gains read as good, costs read as bad', () => {
  // The UI colours by this flag. If it were wrong, a penalty would show green.
  for (const key of Object.keys(policy.POLICIES)) {
    const d = policy.describePolicy(key);
    for (const e of d.gain) if (!e.good) throw new Error(`${key}: gain "${e.text}" marked bad`);
    for (const e of d.cost) if (e.good) throw new Error(`${key}: cost "${e.text}" marked good`);
  }
});

t('catalogue covers every slot and policy', () => {
  const cat = policy.catalogue();
  eq(Object.keys(cat).length, policy.SLOTS.length);
  const total = Object.values(cat).reduce((n, s) => n + s.policies.length, 0);
  eq(total, Object.keys(policy.POLICIES).length);
});

t('comparison shows what a swap would change', () => {
  const changes = policy.comparePolicies(
    { economic: 'austerity' },
    { economic: 'laissez_faire' });
  if (!changes.length) throw new Error('swap reported no changes');
  // Swapping austerity out should restore upkeep AND change income.
  const keys = changes.map(c => c.key);
  if (!keys.includes('improvementUpkeepMultiplier')) throw new Error('upkeep change missing');
  if (!keys.includes('grossIncomeMultiplier')) throw new Error('income change missing');
});

console.log('\n-- WIRED INTO THE ENGINE (not just numbers in a file) --');

t('city costs respond to policy', () => {
  const base = city.infraPurchaseCost(1000, 1100);
  const cheap = city.infraPurchaseCost(1000, 1100, { policies: { economic: 'urbanisation' } });
  const dear = city.infraPurchaseCost(1000, 1100, { policies: { economic: 'manifest_destiny' } });
  approx(cheap / base, 0.92, 0.001, 'Urbanisation:');
  approx(dear / base, 1.08, 0.001, 'Manifest Destiny raises infra cost:');
});

t('new city cost responds to policy', () => {
  const base = city.nextCityCost(5);
  const md = city.nextCityCost(5, { policies: { economic: 'manifest_destiny' } });
  approx(md / base, 0.92, 0.001);
});

t('income and upkeep respond to policy', () => {
  const c = { infrastructure: 1000, land: 2000, improvements: { bank: 5 }, continent: 'europe' };
  approx(eco.grossIncomePerDay(100000, { policies: { economic: 'laissez_faire' } }), 106000, 1);
  const base = eco.improvementUpkeepPerDay(c, {});
  const aust = eco.improvementUpkeepPerDay(c, { policies: { economic: 'austerity' } });
  approx(aust / base, 0.85, 0.001);
});

t('production responds to policy', () => {
  const c = { infrastructure: 1000, land: 2000, improvements: { coal_mine: 10 }, continent: 'europe' };
  const base = eco.rawProductionPerTurn(c, 'coal_mine', {});
  const lf = eco.rawProductionPerTurn(c, 'coal_mine', { policies: { economic: 'laissez_faire' } });
  approx(lf / base, 0.90, 0.001, 'Laissez-Faire costs you output:');
});

t('food consumption responds to policy', () => {
  const base = eco.foodConsumptionPerTurn(100000, {}, false, {});
  const rat = eco.foodConsumptionPerTurn(100000, {}, false, { policies: { social: 'rationing' } });
  approx(rat / base, 0.75, 0.001);
});

t('disease and crime respond to policy', () => {
  const c = { infrastructure: 1000, land: 2000, improvements: {} };
  const base = pop.diseaseRatePercent(c, {});
  const health = pop.diseaseRatePercent(c, { policies: { social: 'public_health' } });
  approx(health - base, -1.5, 0.001, 'Public Health:');

  const crimeBase = pop.crimeRatePercent(c, {});
  const crimePolice = pop.crimeRatePercent(c, { policies: { social: 'police_state' } });
  approx(crimePolice - crimeBase, -3, 0.001, 'Police State:');
});

t('combat responds to BOTH sides\' policy', () => {
  const base = cbt.resolveModifiers({ warType: 'ordinary' });
  const blitz = cbt.resolveModifiers({ warType: 'ordinary', attackerPolicy: 'blitzkrieg' });
  const fort = cbt.resolveModifiers({ warType: 'ordinary', defenderPolicy: 'fortress_doctrine' });
  const both = cbt.resolveModifiers({
    warType: 'ordinary', attackerPolicy: 'blitzkrieg', defenderPolicy: 'fortress_doctrine' });

  approx(blitz.infraDamage / base.infraDamage, 1.12, 0.001, 'Blitzkrieg attack:');
  approx(fort.infraDamage / base.infraDamage, 0.88, 0.001, 'Fortress defence:');
  approx(both.infraDamage / base.infraDamage, 1.12 * 0.88, 0.001, 'both applied:');
});

t('loot responds to policy', () => {
  const base = cbt.resolveModifiers({ warType: 'raid' });
  const priv = cbt.resolveModifiers({ warType: 'raid', attackerPolicy: 'privateering' });
  approx(priv.loot / base.loot, 1.25, 0.001);
  // and it costs damage
  if (!(priv.infraDamage < base.infraDamage)) throw new Error('Privateering should reduce damage');
});

console.log('\n-- Balance sanity --');

t('no single policy is strictly better than another in its slot', () => {
  // Every policy touches at least one lever no other policy in the slot
  // improves, so none is dominated outright.
  for (const slot of policy.SLOTS) {
    const inSlot = Object.entries(policy.POLICIES).filter(([, p]) => p.slot === slot);
    for (const [key, p] of inSlot) {
      const gains = Object.keys(p.gain);
      const unique = gains.some(g =>
        !inSlot.some(([k2, p2]) => k2 !== key && p2.gain[g] !== undefined));
      if (!unique && inSlot.length > 1) {
        // Not fatal on its own, but every gain overlapping means the policy
        // needs a reason to exist.
        const better = inSlot.some(([k2, p2]) => k2 !== key &&
          gains.every(g => p2.gain[g] !== undefined));
        if (better) throw new Error(`${key} may be dominated by another ${slot} policy`);
      }
    }
  }
});

t('no policy gains and loses on the same lever', () => {
  for (const [key, p] of Object.entries(policy.POLICIES)) {
    for (const g of Object.keys(p.gain)) {
      if (p.cost[g] !== undefined) {
        throw new Error(`${key} both gains and costs "${g}" — the effects cancel`);
      }
    }
  }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
