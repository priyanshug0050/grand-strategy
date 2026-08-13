const eco = require('../src/engine/economy');
const pop = require('../src/engine/population');
const C = require('../src/engine/constants');

let pass=0, fail=0;
function t(n,f){ try{f();console.log('  PASS '+n);pass++;}catch(e){console.log('  FAIL '+n+' -> '+e.message);fail++;} }
function eq(a,b,m){ if(a!==b) throw new Error(`${m||''} expected ${b}, got ${a}`); }
function approx(a,b,tol,m){ if(Math.abs(a-b)>tol) throw new Error(`${m||''} expected ~${b}, got ${a}`); }

const city = (infra, land, imps={}, continent='europe') =>
  ({ infrastructure: infra, land, improvements: imps, continent });

console.log('\n-- Unit conversion --');
t('12 turns per day', () => eq(C.TICK.TURNS_PER_DAY, 12));
t('roundtrip is identity', () => approx(eco.turnsToDays(eco.daysToTurns(120)), 120, 1e-9));

console.log('\n-- THE 1000x TRAP --');
t('income uses 0.725, not 725', () => {
  // 1 citizen, 0 commerce -> $0.725/day. If someone grabs MINIMUM_WAGE it is $725.
  approx(eco.averageIncomePerDay(0), 0.725, 1e-9);
});
t('commerce 50 doubles per-capita income', () => {
  approx(eco.averageIncomePerDay(50), 1.45, 1e-9);
});
t('100k citizens at commerce 100 = ~$217,500/day', () => {
  approx(eco.cityIncomePerDay(city(1000,2000), 100000, {commerce:100}), 217500, 1);
});

console.log('\n-- Stacking bonuses --');
t('1 improvement = no bonus', () => eq(eco.stackingBonus(1,'steel_mill'), 0));
t('manufacturing +12.5% per extra (VERIFIED)', () => {
  approx(eco.stackingBonus(2,'steel_mill'), 0.125, 1e-9);
  approx(eco.stackingBonus(3,'steel_mill'), 0.25, 1e-9);
  approx(eco.stackingBonus(5,'steel_mill'), 0.50, 1e-9);
});
t('manufacturing caps at +50%', () => approx(eco.stackingBonus(99,'steel_mill'), 0.5, 1e-9));
t('raw hits +50% at limit (10 mines)', () => approx(eco.stackingBonus(10,'coal_mine'), 0.5, 1e-9));

console.log('\n-- Power (the hard threshold) --');
t('1 coal plant covers 500 infra', () => eq(eco.powerCapacity(city(500,1000,{coal_power:1})), 500));
t('500 infra + 1 plant = powered', () => eq(eco.isPowered(city(500,1000,{coal_power:1})), true));
t('501 infra + 1 plant = NOT powered (the classic trap)', () =>
  eq(eco.isPowered(city(501,1000,{coal_power:1})), false));
t('2 plants cover it', () => eq(eco.isPowered(city(501,1000,{coal_power:2})), true));
t('fuel burn = 0.1/turn per 100 infra', () => {
  const f = eco.fuelConsumptionPerTurn(city(500,1000,{coal_power:1}));
  approx(f.coal, 0.5, 1e-9);
});
t('excess capacity does not waste fuel', () => {
  const f = eco.fuelConsumptionPerTurn(city(100,1000,{coal_power:5}));
  approx(f.coal, 0.1, 1e-9);
});

console.log('\n-- Raw production --');
t('1 coal mine = 0.25/turn (3/day)', () => {
  approx(eco.rawProductionPerTurn(city(500,1000,{coal_mine:1}),'coal_mine'), 0.25, 1e-9);
});
t('10 mines = 10x base + 50% bonus', () => {
  approx(eco.rawProductionPerTurn(city(500,1000,{coal_mine:10}),'coal_mine'), 0.25*10*1.5, 1e-9);
});
t('mines work WITHOUT power', () => {
  const unpowered = city(500,1000,{coal_mine:5});
  eq(eco.isPowered(unpowered), false);
  if (eco.rawProductionPerTurn(unpowered,'coal_mine') <= 0) throw new Error('mines need power?');
});

console.log('\n-- Farms (land-driven) --');
t('farm output = land/LAND_DIVISOR_PER_TURN', () => {
  // Read the divisor from constants rather than hardcoding 500, so tuning it
  // in constants.js (a normal balance change) doesn't also require editing
  // this test every time — only actually breaking the formula should.
  approx(eco.farmProductionPerTurn(city(500,2000,{farm:1})), 2000/C.FARM.LAND_DIVISOR_PER_TURN, 1e-9);
});
t('Mass Irrigation improves the divisor (irrigated < normal)', () => {
  const a = eco.farmProductionPerTurn(city(500,2000,{farm:1}));
  const b = eco.farmProductionPerTurn(city(500,2000,{farm:1}), {projects:['mass_irrigation']});
  approx(b/a, C.FARM.LAND_DIVISOR_PER_TURN / C.FARM.LAND_DIVISOR_IRRIGATED, 1e-9);
  if (!(C.FARM.LAND_DIVISOR_IRRIGATED < C.FARM.LAND_DIVISOR_PER_TURN)) {
    throw new Error('irrigated divisor should be smaller (= more food) than normal');
  }
});
t('Antarctica halves food', () => {
  const nrm = eco.farmProductionPerTurn(city(500,2000,{farm:1},'europe'));
  const ant = eco.farmProductionPerTurn(city(500,2000,{farm:1},'antarctica'));
  approx(ant/nrm, 0.5, 1e-9);
});

console.log('\n-- Manufacturing --');
const mill = city(1000,2000,{steel_mill:1, coal_power:2});
t('steel mill: 3+3 in -> 9 out per day', () => {
  const r = eco.manufacturingPerTurn(mill,'steel');
  approx(eco.turnsToDays(r.outputs.steel), 9, 1e-6);
  approx(eco.turnsToDays(r.inputs.iron), 3, 1e-6);
  approx(eco.turnsToDays(r.inputs.coal), 3, 1e-6);
});
t('UNPOWERED manufacturing produces nothing', () => {
  const r = eco.manufacturingPerTurn(city(1000,2000,{steel_mill:1}),'steel');
  eq(r.outputs.steel, undefined);
  eq(r.limitedBy, 'power');
});
t('5 mills = 5x throughput + 50%', () => {
  const c = city(1000,2000,{steel_mill:5, coal_power:2});
  const one = eco.manufacturingPerTurn(mill,'steel').outputs.steel;
  const five = eco.manufacturingPerTurn(c,'steel').outputs.steel;
  approx(five/one, 5*1.5, 1e-9);
});
t('input consumption scales with output (ratio fixed)', () => {
  const c = city(1000,2000,{steel_mill:5, coal_power:2});
  const r = eco.manufacturingPerTurn(c,'steel');
  approx(r.outputs.steel/r.inputs.iron, 3, 1e-9);
});
t('throttles when inputs run short', () => {
  const r = eco.manufacturingPerTurn(mill,'steel',{available:{iron:0.1,coal:99}});
  eq(r.throttled, true);
  eq(r.limitedBy, 'iron');
});
t('zero inputs -> zero output, not NaN', () => {
  const r = eco.manufacturingPerTurn(mill,'steel',{available:{iron:0,coal:0}});
  eq(r.outputs.steel, 0);
});

console.log('\n-- FREE ELECTRICITY (the same exploit, in power) --');
t('plants with NO fuel do not power the city', () => {
  const c = city(1000,2000,{coal_power:2, steel_mill:3});
  const p = eco.cityProductionPerTurn(c, {stockpile:{}});
  eq(p.powered, false, 'unfuelled plants reported as powered:');
  eq(p.power.reason, 'fuel');
});
t('unfuelled plants burn NOTHING (no negative coal)', () => {
  const c = city(1000,2000,{coal_power:2});
  const p = eco.cityProductionPerTurn(c, {stockpile:{}});
  if (p.net.coal < -1e-9) throw new Error(`burned ${-p.net.coal} coal it did not have`);
});
t('and everything downstream of power goes idle', () => {
  const c = city(1000,2000,{coal_power:2, steel_mill:3});
  const p = eco.cityProductionPerTurn(c, {stockpile:{iron:100}});
  eq(p.gross.steel, 0, 'mills ran without power:');
  eq(p.manufacturing.steel.limitedBy, 'power');
});
t('mines CAN fuel plants in the same turn', () => {
  const c = city(1000,2000,{coal_power:2, coal_mine:10, steel_mill:3, iron_mine:10});
  const p = eco.cityProductionPerTurn(c, {stockpile:{}});
  eq(p.powered, true, 'same-turn extraction should fuel the plants:');
  if (!(p.gross.steel > 0)) throw new Error('mills idle despite fuelled plants');
});
t('but not if the mines produce too little', () => {
  const c = city(1000,2000,{coal_power:2, coal_mine:1, steel_mill:3, iron_mine:10});
  eq(eco.cityProductionPerTurn(c, {stockpile:{}}).powered, false);
});
t('EVERY plant type refuses to run without its fuel', () => {
  // The fix must be generic, not coal-specific. Each plant is given a city
  // exactly its own capacity so it is the only thing keeping the lights on.
  for (const [key, def] of Object.entries(C.IMPROVEMENTS)) {
    if (def.category !== 'power' || !def.fuel) continue;
    const c = city(def.infraCapacity, 4000, {[key]:1, bank:1});
    const dry = eco.cityProductionPerTurn(c, {stockpile:{}});
    if (dry.powered) throw new Error(`${key} ran with no ${def.fuel}`);
    if (dry.power.reason !== 'fuel') throw new Error(`${key} gave reason "${dry.power.reason}"`);
    if (dry.net[def.fuel] < -1e-9) throw new Error(`${key} burned ${def.fuel} it did not have`);

    const stocked = eco.cityProductionPerTurn(c, {stockpile:{[def.fuel]: 1000}});
    if (!stocked.powered) throw new Error(`${key} would not run WITH ${def.fuel}`);
    if (!(stocked.consumed[def.fuel] > 0)) throw new Error(`${key} burned no ${def.fuel}`);
  }
});
t('wind power needs no fuel at all', () => {
  const c = city(250,1000,{wind_power:1, bank:2});
  eq(eco.cityProductionPerTurn(c, {stockpile:{}}).powered, true);
});
t('MIXED plants: one unfuelled type blacks out the city', () => {
  const c = city(1000,4000,{coal_power:1, oil_power:1, bank:2});
  eq(eco.cityProductionPerTurn(c, {stockpile:{coal:100, oil:100}}).powered, true);
  const noOil = eco.cityProductionPerTurn(c, {stockpile:{coal:100, oil:0}});
  eq(noOil.powered, false, 'city ran with one fuel type missing:');
  eq(noOil.power.resource, 'oil', 'named the wrong missing fuel:');
});
t('wind can cover part of the load, but the rest still needs fuel', () => {
  const c = city(750,4000,{wind_power:1, coal_power:1, bank:2});
  eq(eco.cityProductionPerTurn(c, {stockpile:{coal:0}}).powered, false);
  eq(eco.cityProductionPerTurn(c, {stockpile:{coal:100}}).powered, true);
  // All-wind needs nothing at all.
  eq(eco.cityProductionPerTurn(city(750,4000,{wind_power:3, bank:2}), {stockpile:{}}).powered, true);
});
t('a plant can burn fuel the city mines that same turn', () => {
  const enough = city(2000,4000,{nuclear_power:1, uranium_mine:5, bank:2});
  // 5 uranium mines yield less than a 2000-infra nuclear plant burns.
  eq(eco.cityProductionPerTurn(enough, {stockpile:{}}).powered, false,
     'mines should NOT cover this plant:');
  // Top it up from stock and it runs.
  eq(eco.cityProductionPerTurn(enough, {stockpile:{uranium:10}}).powered, true);
});
t('powerStatus explains WHICH problem it is', () => {
  const noCapacity = eco.powerStatus(city(1000,2000,{coal_power:1}), {stockpile:{coal:100}});
  eq(noCapacity.reason, 'capacity');
  const noFuel = eco.powerStatus(city(1000,2000,{coal_power:2}), {stockpile:{}});
  eq(noFuel.reason, 'fuel');
  if (!noFuel.message.includes('coal')) throw new Error('fuel message should name the resource');
});

console.log('\n-- FREE RESOURCES (the exploit) --');
t('steel mill with NO inputs produces NOTHING', () => {
  // Give it fuel so this isolates the INPUT shortage rather than the power
  // shortage — with no coal at all the mill would stop for lack of power first.
  const c = city(1000,2000,{steel_mill:3, coal_power:2});
  const p = eco.cityProductionPerTurn(c, {stockpile:{coal:100}});
  eq(p.powered, true, 'should be powered with coal in stock:');
  eq(p.gross.steel, 0, 'steel from nothing:');
  eq(p.manufacturing.steel.limitedBy, 'iron');
});
t('and it never drives an input negative', () => {
  const c = city(1000,2000,{steel_mill:3, coal_power:2});
  const p = eco.cityProductionPerTurn(c, {stockpile:{coal:100}});
  for (const [r,v] of Object.entries(p.net)) {
    if (r === 'coal') continue;   // power plants legitimately burn fuel
    if (v < -1e-9) throw new Error(`${r} went negative (${v}) with an empty stockpile`);
  }
});
t('mines can feed mills in the SAME turn', () => {
  const c = city(1000,2000,{steel_mill:3, coal_power:2, coal_mine:10, iron_mine:10});
  const p = eco.cityProductionPerTurn(c, {stockpile:{}});
  if (!(p.gross.steel > 0)) throw new Error('same-turn extraction should feed manufacturing');
  if (p.net.iron < 0) throw new Error('iron should not go negative when mines cover the mills');
});
t('cities do NOT double-spend one national stockpile', () => {
  const mill = () => city(1000,2000,{steel_mill:3, coal_power:2});
  const r = eco.nationRevenue([mill(),mill(),mill()],[1e5,1e5,1e5],{stockpile:{iron:1, coal:50}});
  // 1 iron cannot support three cities each needing 0.9375.
  const ironUsed = r.perCity.reduce((s,c) => s + (c.consumedResourcesPerTurn.iron||0), 0);
  if (ironUsed > 1.0001) throw new Error(`consumed ${ironUsed} iron from a stockpile of 1`);
});

console.log('\n-- Pollution --');
t('manufacturing pollutes +32 each', () => {
  approx(eco.pollutionIndex(city(1000,2000,{steel_mill:2})), 64, 1e-9);
});
t('recycling centers reduce', () => {
  const dirty = eco.pollutionIndex(city(1000,2000,{steel_mill:3}));
  const clean = eco.pollutionIndex(city(1000,2000,{steel_mill:3, recycling_center:1}));
  approx(dirty-clean, 70, 1e-9);
});
t('Green Technologies cuts manufacturing pollution 25%', () => {
  const a = eco.pollutionIndex(city(1000,2000,{steel_mill:4}));
  const b = eco.pollutionIndex(city(1000,2000,{steel_mill:4}),{projects:['green_technologies']});
  approx(b/a, 0.75, 1e-9);
});
t('never negative', () => {
  eq(eco.pollutionIndex(city(1000,2000,{recycling_center:3})), 0);
});

console.log('\n-- Income modifiers --');
const base = 100000;
t('out of food = -33% (the big one)', () => {
  approx(eco.grossIncomePerDay(base,{outOfFood:true}), 67000, 1);
});
t('Laissez-Faire = +6% income (and costs output elsewhere)', () => {
  approx(eco.grossIncomePerDay(base,{policies:{economic:'laissez_faire'}}), 106000, 1);
});
t('modifiers compound multiplicatively', () => {
  const r = eco.grossIncomePerDay(base,{outOfFood:true, policies:{economic:'laissez_faire'}});
  approx(r, 100000*1.06*0.67, 1);
});
t('color bonus is flat per TURN, converted to daily', () => {
  const r = eco.grossIncomePerDay(base,{colorBonusPerTurn:50000});
  approx(r, base + 50000*12, 1);
});

console.log('\n-- Upkeep --');
t('war upkeep is higher than peace', () => {
  const units = {soldiers:10000, tanks:500, aircraft:50};
  const p = eco.unitUpkeepPerDay(units,false);
  const w = eco.unitUpkeepPerDay(units,true);
  if (!(w > p)) throw new Error(`war ${w} not > peace ${p}`);
  console.log(`      peace $${p.toLocaleString()}/day -> war $${w.toLocaleString()}/day`);
});
t('soldiers eat more at war', () => {
  const p = eco.foodConsumptionPerTurn(0,{soldiers:15000},false);
  const w = eco.foodConsumptionPerTurn(0,{soldiers:15000},true);
  approx(p, 15000/750/12, 1e-9);
  approx(w, 15000/500/12, 1e-9);
});

console.log('\n-- Full nation rollup --');
const cities = [
  city(1500,3000,{coal_mine:5, iron_mine:5, coal_power:3, bank:5, supermarket:4}),
  city(1000,2000,{steel_mill:5, coal_power:2, shopping_mall:4}),
];
const pops = cities.map(c => pop.computePopulation(c,{cityAgeDays:200}));
const rev = eco.nationRevenue(cities, pops, {
  units:{soldiers:20000, tanks:1000},
  atWar:false,
  stockpile:{food:5000},
  projects:['ironworks'],
});
console.log(`    population:      ${rev.totalPopulation.toLocaleString()}`);
console.log(`    gross income:    $${rev.grossIncomePerDay.toLocaleString()}/day`);
console.log(`    improvement upk: $${rev.improvementUpkeepPerDay.toLocaleString()}/day`);
console.log(`    unit upkeep:     $${rev.unitUpkeepPerDay.toLocaleString()}/day`);
console.log(`    NET:             $${rev.netIncomePerDay.toLocaleString()}/day`);
console.log(`    steel/turn:      ${rev.resourcesPerTurn.steel.toFixed(3)}`);
console.log(`    food/turn:       ${rev.resourcesPerTurn.food.toFixed(3)}`);
console.log(`    warnings:`);
rev.perCity.forEach((c,i) => c.warnings.forEach(w => console.log(`      city${i+1}: ${w}`)));

t('rollup produces finite numbers', () => {
  for (const k of ['grossIncomePerDay','netIncomePerDay','netIncomePerTurn']) {
    if (!Number.isFinite(rev[k])) throw new Error(`${k} = ${rev[k]}`);
  }
});
t('all resources present in ledger', () => {
  for (const r of C.ALL_RESOURCES) {
    if (typeof rev.resourcesPerTurn[r] !== 'number') throw new Error(`missing ${r}`);
  }
});
t('detects negative net resources', () => {
  const hasWarn = rev.perCity.some(c => c.warnings.some(w => w.includes('negative')));
  if (!hasWarn) throw new Error('no negative-resource warning despite no farms');
});
t('mismatched array lengths rejected', () => {
  try { eco.nationRevenue(cities,[1]); throw new Error('should throw'); }
  catch(e){ if(!(e instanceof TypeError)) throw e; }
});

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail>0?1:0);
