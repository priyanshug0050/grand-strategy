const C = require('../src/engine/constants');
const city = require('../src/engine/city');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); fail++; }
}
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} expected ${b}, got ${a}`); }
function approx(a, b, tol, msg) { if (Math.abs(a-b) > tol) throw new Error(`${msg||''} expected ~${b}, got ${a}`); }

console.log('\n-- Improvement slots --');
t('50 infra = 1 slot', () => eq(city.improvementSlots(50), 1));
t('999 infra = 19 slots', () => eq(city.improvementSlots(999), 19));
t('10 infra (starting) = 0 slots', () => eq(city.improvementSlots(10), 0));

console.log('\n-- Infra unit cost --');
t('cheapest is NOT at zero', () => {
  if (!(city.infraUnitCost(10) <= city.infraUnitCost(0))) throw new Error('offset quirk lost');
});
t('base cost at offset = 300', () => eq(city.infraUnitCost(10), 300));
t('rises with level', () => {
  if (!(city.infraUnitCost(2000) > city.infraUnitCost(1000))) throw new Error('not monotonic');
});

console.log('\n-- Infra purchase --');
const i1 = city.infraPurchaseCost(0, 100);
const i2 = city.infraPurchaseCost(1000, 1100);
const i3 = city.infraPurchaseCost(3000, 3100);
console.log(`    0->100: $${i1.toLocaleString()}`);
console.log(` 1000->1100: $${i2.toLocaleString()}`);
console.log(` 3000->3100: $${i3.toLocaleString()}`);
t('later infra costs more', () => { if (!(i3 > i2 && i2 > i1)) throw new Error('curve not rising'); });
t('no-op purchase is free', () => eq(city.infraPurchaseCost(500, 500), 0));
t('backwards purchase is free', () => eq(city.infraPurchaseCost(500, 200), 0));

console.log('\n-- Infra discounts --');
const plain = city.infraPurchaseCost(1000, 1100);
const disc = city.infraPurchaseCost(1000, 1100, {
  projects: ['center_for_civil_engineering'], policies: { economic: 'urbanisation' }
});
console.log(`    plain $${plain.toLocaleString()} -> both discounts $${disc.toLocaleString()}`);
t('project and policy discounts are multiplicative', () => {
  // Center for Civil Engineering (-5%) x Urbanisation (-8%) = 0.874
  approx(disc/plain, 0.95 * 0.92, 0.0001);
});

console.log('\n-- Land --');
console.log(`    unit cost @250 land: $${city.landUnitCost(250).toFixed(2)}`);
console.log(`    unit cost @2000 land: $${city.landUnitCost(2000).toFixed(2)}`);
t('land ladder: 250 -> 500', () => eq(city.nextLandBracketBoundary(250), 500));
t('land ladder: 100 -> 250', () => eq(city.nextLandBracketBoundary(100), 250));
t('land ladder: 600 -> 1000', () => eq(city.nextLandBracketBoundary(600), 1000));
const split = city.landPurchaseCost(250, 1000);
const direct = 250 * city.landUnitCost(250) + 500 * city.landUnitCost(500);
console.log(`    250->1000 bracketed: $${split.toLocaleString()}`);
t('250->1000 splits into two bracket transactions', () => approx(split, direct, 0.01));
t('bulk beats piecemeal', () => {
  const bulk = city.landPurchaseCost(500, 1000);
  const piece = city.landPurchaseCost(500, 750) + city.landPurchaseCost(750, 1000);
  if (!(bulk <= piece)) throw new Error(`bulk ${bulk} should be <= piecemeal ${piece}`);
});
t('efficiency flag catches 397', () => eq(city.isLandPurchaseEfficient(250, 397), false));
t('efficiency flag passes 1000', () => eq(city.isLandPurchaseEfficient(500, 1000), true));

console.log('\n-- City cost --');
const c2 = city.nextCityCost(1);
console.log(`    city 2:  $${c2.toLocaleString()}`);
console.log(`    city 10: $${city.nextCityCost(9).toLocaleString()}`);
console.log(`    city 30: $${city.nextCityCost(29).toLocaleString()}`);
t('city 2 = $225,000 (VERIFIED against P&W)', () => eq(c2, 225000));
t('cubic growth: doubling X ~8x the cubic term', () => {
  // Isolate the cubic term: cost(X) - linear - constant should scale as (X-1)^3
  const term = (X) => city.nextCityCost(X) - 150000 * X - 75000;
  const ratio = term(41) / term(21);   // (40/20)^3 = 8
  approx(ratio, 8, 0.01, 'cubic ratio:');
});

console.log('\n-- Discount ORDER (the bug source) --');
const base = city.nextCityCost(20);
const correct = city.nextCityCost(20, {
  projects: ['urban_planning', 'advanced_urban_planning'],
  policies: { economic: 'manifest_destiny' }
});
const wrongOrder = (base * 0.92) - 150000000;
console.log(`    base:            $${base.toLocaleString()}`);
console.log(`    correct order:   $${correct.toLocaleString()}`);
console.log(`    wrong order:     $${wrongOrder.toLocaleString()}`);
console.log(`    difference:      $${Math.abs(correct - wrongOrder).toLocaleString()}`);
t('order actually matters', () => {
  if (Math.abs(correct - wrongOrder) < 1) throw new Error('order made no difference - check logic');
});
t('flat discounts stack', () => {
  const one = city.nextCityCost(20, { projects: ['urban_planning'] });
  const two = city.nextCityCost(20, { projects: ['urban_planning','advanced_urban_planning'] });
  approx(one - two, 100000000, 1);
});
t('Govt Support Agency amplifies the policy GAIN', () => {
  // Manifest Destiny cuts city cost 8%. The project amplifies that deviation
  // by 50%, so -8% becomes -12%.
  const md = city.nextCityCost(20, { policies: { economic: 'manifest_destiny' } });
  const gsa = city.nextCityCost(20, {
    projects: ['government_support_agency'], policies: { economic: 'manifest_destiny' }
  });
  approx(md / base, 0.92, 0.0001, 'MD alone:');
  approx(gsa / base, 0.88, 0.0001, 'MD amplified:');
});
t('floors at $1, never negative', () => {
  const c = city.nextCityCost(2, {
    projects: ['urban_planning','advanced_urban_planning','metropolitan_planning']
  });
  eq(c, 1);
});

console.log('\n-- City timer --');
t('city 5 has no cooldown', () => eq(city.canPurchaseCity(5, 100, 105).ok, true));
t('city 10+ blocked inside cooldown', () => {
  const r = city.canPurchaseCity(12, 100, 150);
  eq(r.ok, false); eq(r.turnsRemaining, 70);
});
t('city 10+ allowed after 120 turns', () => eq(city.canPurchaseCity(12, 100, 220).ok, true));

console.log('\n-- Build validation --');
const c = city.createCity('Testburg', 'europe', 0);
t('new city has 0 slots', () => eq(city.availableImprovementSlots(c), 0));
t('cannot build with no slots', () => eq(city.canBuildImprovement(c, 'coal_mine').ok, false));
c.infrastructure = 1000;
t('1000 infra = 20 slots', () => eq(city.availableImprovementSlots(c), 20));
t('can build now', () => eq(city.canBuildImprovement(c, 'coal_mine', 10).ok, true));
t('per-city limit enforced (11 coal mines)', () => eq(city.canBuildImprovement(c, 'coal_mine', 11).ok, false));
t('unknown improvement rejected', () => eq(city.canBuildImprovement(c, 'death_star').ok, false));
c.improvements = { coal_mine: 10, farm: 10 };
t('slot accounting correct', () => eq(city.availableImprovementSlots(c), 0));
t('validate passes', () => eq(city.validateCity(c).valid, true));

console.log('\n-- MATERIAL COSTS --');
t('commerce/civil/military need materials', () => {
  for (const [key, def] of Object.entries(C.IMPROVEMENTS)) {
    if (!['commerce','civil','military'].includes(def.category)) continue;
    if (key === 'barracks') continue;   // deliberately material-free
    const cost = city.improvementCost(key, 1);
    if (cost.moneyOnly) throw new Error(`${key} still costs money only`);
  }
});
t('raw and manufacturing do NOT (no chicken-and-egg)', () => {
  for (const [key, def] of Object.entries(C.IMPROVEMENTS)) {
    if (!['raw','manufacturing'].includes(def.category)) continue;
    if (!city.improvementCost(key, 1).moneyOnly) {
      throw new Error(`${key} requires materials — a new player could never build it`);
    }
  }
});
t('barracks stay free of materials (last-resort defence)', () => {
  eq(city.improvementCost('barracks', 1).moneyOnly, true);
});
t('cost scales with count', () => {
  const one = city.improvementCost('bank', 1);
  const three = city.improvementCost('bank', 3);
  eq(three.money, one.money * 3);
  eq(three.materials.steel, one.materials.steel * 3);
});
t('build BLOCKED without materials, and says what is short', () => {
  const c = { infrastructure: 1000, land: 2000, improvements: {} };
  const r = city.canBuildImprovement(c, 'bank', 1, { stockpile: {} });
  eq(r.ok, false);
  if (!r.missing.steel) throw new Error('did not report missing steel');
  if (!r.reason.includes('steel')) throw new Error('reason does not name the resource');
});
t('build ALLOWED with materials', () => {
  const c = { infrastructure: 1000, land: 2000, improvements: {} };
  eq(city.canBuildImprovement(c, 'bank', 1, { stockpile: { steel: 100, aluminum: 100 } }).ok, true);
});
t('omitting the stockpile skips the material check', () => {
  // The UI calls it this way to test slot capacity alone.
  const c = { infrastructure: 1000, land: 2000, improvements: {} };
  eq(city.canBuildImprovement(c, 'bank', 1).ok, true);
});
t('slot limits still bite before materials are considered', () => {
  const c = { infrastructure: 10, land: 250, improvements: {} };
  const r = city.canBuildImprovement(c, 'bank', 1, { stockpile: { steel: 1e6, aluminum: 1e6 } });
  eq(r.ok, false);
  if (!r.reason.includes('slot')) throw new Error('should fail on slots: ' + r.reason);
});

console.log('\n-- War damage edge case --');
c.infrastructure = 100;  // nuked from 1000
const v = city.validateCity(c);
t('reports orphaned improvements, does not throw', () => {
  eq(v.valid, false);
  if (!v.errors[0].includes('exceed slot capacity')) throw new Error('wrong error: ' + v.errors[0]);
});

console.log('\n-- Input guards --');
t('rejects negative infra', () => {
  try { city.infraUnitCost(-5); throw new Error('should have thrown'); }
  catch (e) { if (!(e instanceof RangeError)) throw e; }
});
t('rejects NaN', () => {
  try { city.improvementSlots(NaN); throw new Error('should have thrown'); }
  catch (e) { if (!(e instanceof TypeError)) throw e; }
});
t('rejects city count 0', () => {
  try { city.nextCityCost(0); throw new Error('should have thrown'); }
  catch (e) { if (!(e instanceof RangeError)) throw e; }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
