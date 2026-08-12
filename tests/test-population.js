const pop = require('../src/engine/population');
const C = require('../src/engine/constants');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  PASS ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + ' -> ' + e.message); fail++; }
}
function eq(a,b,m){ if(a!==b) throw new Error(`${m||''} expected ${b}, got ${a}`); }
function approx(a,b,tol,m){ if(Math.abs(a-b)>tol) throw new Error(`${m||''} expected ~${b}, got ${a}`); }

const city = (infra, land, imps = {}) => ({ infrastructure: infra, land, improvements: imps });

console.log('\n-- Base population --');
t('infra 1000 -> 100,000 base at age 0', () => eq(pop.basePopulation(1000, 0), 100000));
t('age adds a slow drift', () => {
  const young = pop.basePopulation(2000, 0);
  const old   = pop.basePopulation(2000, 365);
  approx(old - young, 2000/1000 * (100*365/3), 0.01);
});

console.log('\n-- DISEASE CURVE (the sanity anchors) --');
// density = infra*100/land. Pick land so density hits the target exactly.
function atDensity(d, infra = 1000) { return city(infra, (infra*100)/d); }
const anchors = [[100, 0.75], [200, 3.75], [500, 24.75], [1000, 99.75]];
for (const [d, expectedPct] of anchors) {
  t(`density ${d} -> ${expectedPct}% (density term only)`, () => {
    const c = atDensity(d, 1000);
    // isolate the density term by removing the infra/1000 contribution
    const got = pop.diseaseRatePercent(c) - (1000/1000);
    approx(got, expectedPct, 0.01);
  });
}

console.log('\n-- Disease clamping --');
t('never negative', () => {
  const c = city(100, 100000, { hospital: 5 });
  eq(pop.diseaseRate(c), 0);
});
t('never above 1.0', () => {
  const c = city(2000, 50);
  eq(pop.diseaseRate(c), 1.0);
});
t('hospitals reduce 2.5% each', () => {
  const a = pop.diseaseRatePercent(city(1000, 500));
  const b = pop.diseaseRatePercent(city(1000, 500, { hospital: 4 }));
  approx(a - b, 10, 0.001);
});
t('pollution adds 0.05% per point', () => {
  const a = pop.diseaseRatePercent(city(1000, 500), { pollution: 0 });
  const b = pop.diseaseRatePercent(city(1000, 500), { pollution: 100 });
  approx(b - a, 5, 0.001);
});

console.log('\n-- THE FEEDBACK-LOOP BREAK --');
t('density ignores live population entirely', () => {
  // Two cities, identical shape. If density leaked from live pop, adding
  // hospitals (which raises live pop) would change density. It must not.
  const bare = city(1000, 500);
  const withHosp = city(1000, 500, { hospital: 3 });
  eq(pop.populationDensity(bare.infrastructure, bare.land),
     pop.populationDensity(withHosp.infrastructure, withHosp.land));
});
t('repeated evaluation is stable (no oscillation)', () => {
  const c = city(1500, 800);
  const runs = [];
  for (let i = 0; i < 10; i++) runs.push(pop.computePopulation(c, { cityAgeDays: 100 }));
  if (new Set(runs).size !== 1) throw new Error('population drifted across evaluations: ' + runs.join(','));
});

console.log('\n-- Collapse floor --');
t('100% disease floors at 10, not 0 or negative', () => {
  const c = city(2000, 50);
  const b = pop.populationBreakdown(c, { cityAgeDays: 500 });
  eq(b.population, 10);
  eq(b.collapsed, true);
});

console.log('\n-- Age multiplier --');
t('day 1 = 1.0x', () => approx(pop.ageMultiplier(1), 1.0, 1e-9));
t('day 0 does not blow up (ln(0) guard)', () => {
  const m = pop.ageMultiplier(0);
  if (!Number.isFinite(m)) throw new Error('got ' + m);
  approx(m, 1.0, 1e-9);
});
t('day 200 ~ +35%', () => approx(pop.ageMultiplier(200), 1 + Math.log(200)/15, 1e-9));
t('logarithmic, not linear', () => {
  const d100 = pop.ageMultiplier(100) - 1;
  const d200 = pop.ageMultiplier(200) - 1;
  if (d200 >= d100 * 2) throw new Error('growing linearly or faster');
});

console.log('\n-- Assembled population --');
const healthy = city(1000, 2000, { hospital: 1 });
const bh = pop.populationBreakdown(healthy, { cityAgeDays: 365, commerce: 50 });
console.log(`    healthy city (1000 infra / 2000 land, age 365):`);
console.log(`      base ${bh.basePopulation.toLocaleString()}, density ${bh.density.toFixed(1)}`);
console.log(`      disease ${bh.diseaseRatePercent.toFixed(2)}% -> ${bh.diseaseDeaths.toLocaleString()} dead`);
console.log(`      crime   ${bh.crimeRatePercent.toFixed(2)}% -> ${bh.crimeDeaths.toLocaleString()} dead (4x weighted)`);
console.log(`      age x${bh.ageMultiplier.toFixed(3)}`);
console.log(`      FINAL ${bh.population.toLocaleString()}`);

const cramped = city(1000, 300);
const bc = pop.populationBreakdown(cramped, { cityAgeDays: 365 });
console.log(`    cramped city (1000 infra / 300 land, age 365):`);
console.log(`      density ${bc.density.toFixed(1)}, disease ${bc.diseaseRatePercent.toFixed(2)}%`);
console.log(`      FINAL ${bc.population.toLocaleString()}`);

t('land is strictly better for population', () => {
  if (!(bh.population > bc.population)) throw new Error('cramped city outperformed spacious one');
});
t('breakdown population is an integer', () => eq(Number.isInteger(bh.population), true));

console.log('\n-- Solvers --');
const small = city(200, 400);
const ln = pop.landNeededForZeroDisease(small);
console.log(`    200 infra: needs ${ln.toLocaleString()} land for 0% disease`);
t('land solver actually zeroes disease', () => {
  const pct = pop.diseaseRatePercent(city(200, ln));
  if (pct > 0.01) throw new Error(`still ${pct.toFixed(3)}%`);
});

const big = city(2000, 400);
const floorPct = pop.minimumAchievableDiseasePercent(big);
console.log(`    2000 infra: land-only floor is ${floorPct.toFixed(2)}% disease`);
t('big city: 0% unreachable with land alone', () => eq(pop.landNeededForZeroDisease(big), null));
t('but the achievable floor IS reachable', () => {
  const l = pop.landNeededForDisease(big, floorPct + 0.5);
  if (l === null) throw new Error('should be reachable');
  const pct = pop.diseaseRatePercent(city(2000, l));
  approx(pct, floorPct + 0.5, 0.05);
});
t('hospitals lower the floor', () => {
  const withHosp = city(2000, 400, { hospital: 3 });
  if (!(pop.minimumAchievableDiseasePercent(withHosp) < floorPct - 7)) {
    throw new Error('hospitals did not lower the floor');
  }
});
t('returns null when pollution swamps it', () => {
  eq(pop.landNeededForZeroDisease(city(1000, 500), { pollution: 100000 }), null);
});
const hosp = pop.hospitalsNeededForZeroDisease(city(1000, 400));
console.log(`    1000 infra / 400 land: ${hosp} hospitals for 0% disease`);
t('hospital solver works', () => {
  const fixed = city(1000, 400, { hospital: hosp });
  if (pop.diseaseRatePercent(fixed) > 0.01) throw new Error('insufficient');
});

console.log('\n-- Nation totals --');
t('sums across cities', () => {
  const cities = [city(1000,2000), city(500,1000), city(200,500)];
  const total = pop.nationPopulation(cities, () => ({ cityAgeDays: 100 }));
  const manual = cities.reduce((s,c) => s + pop.computePopulation(c, {cityAgeDays:100}), 0);
  eq(total, manual);
});

console.log('\n-- Guards --');
t('rejects negative infra', () => {
  try { pop.basePopulation(-1, 0); throw new Error('should throw'); }
  catch(e){ if(!(e instanceof RangeError)) throw e; }
});
t('rejects NaN age', () => {
  try { pop.ageMultiplier(NaN); throw new Error('should throw'); }
  catch(e){ if(!(e instanceof TypeError)) throw e; }
});
t('land=0 does not divide by zero', () => {
  const d = pop.populationDensity(100, 0);
  if (!Number.isFinite(d)) throw new Error('got ' + d);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail > 0 ? 1 : 0);
