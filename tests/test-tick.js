const tick = require('../src/engine/tick');
const mod = require('../src/engine/modifiers');
const C = require('../src/engine/constants');

let pass=0, fail=0;
function t(n,f){ try{f();console.log('  PASS '+n);pass++;}catch(e){console.log('  FAIL '+n+' -> '+e.message);fail++;} }
function eq(a,b,m){ if(a!==b) throw new Error(`${m||''} expected ${b}, got ${a}`); }
function approx(a,b,tol,m){ if(Math.abs(a-b)>tol) throw new Error(`${m||''} expected ~${b}, got ${a}`); }

console.log('\n-- Espionage --');
t('odds formula', () => {
  // (2*25) + (50*100)/((20*3)+1) = 50 + 5000/61 = 131.97 -> clamped 100
  const raw = 50 + 5000/61;
  approx(mod.espionageOdds(50,20,2,'gather_intelligence'), Math.min(raw,100), 0.01);
});
t('operation modifier divides odds', () => {
  const gather = mod.espionageOdds(10,20,1,'gather_intelligence');
  const nuke = mod.espionageOdds(10,20,1,'sabotage_nuke');
  approx(gather/nuke, 5, 0.01);
});
t('enemy spies weighted 3x (defence is cheap)', () => {
  // use values that stay under the 100% clamp so the ratio is meaningful
  const undefended = mod.espionageOdds(2,0,1,'sabotage_nuke');
  const defended   = mod.espionageOdds(2,30,1,'sabotage_nuke');
  console.log(`      undefended ${undefended.toFixed(1)}% vs defended ${defended.toFixed(1)}%`);
  if (!(defended < undefended/2)) throw new Error(`defence weak: ${defended} vs ${undefended}`);
});
t('higher safety = better odds', () => {
  const lo = mod.espionageOdds(5,50,1,'sabotage_nuke');
  const hi = mod.espionageOdds(5,50,3,'sabotage_nuke');
  if (!(hi > lo)) throw new Error('safety did nothing');
});
t('clamped to 0-100', () => {
  const o = mod.espionageOdds(100000,0,3,'gather_intelligence');
  eq(o, 100);
});
t('unknown operation rejected', () => {
  try { mod.espionageOdds(10,10,1,'mind_control'); throw new Error('should throw'); }
  catch(e){ if(!e.message.includes('Unknown espionage')) throw e; }
});
t('resolution is deterministic with seeded rng', () => {
  const combat = require('../src/engine/combat');
  const a = mod.resolveEspionage(20,10,2,'sabotage_tanks',{rng:combat.makeRng(5)});
  const b = mod.resolveEspionage(20,10,2,'sabotage_tanks',{rng:combat.makeRng(5)});
  eq(JSON.stringify(a), JSON.stringify(b));
});

console.log('\n-- Project aggregation --');
const eff = mod.aggregateProjectEffects(['ironworks','mass_irrigation','center_for_civil_engineering','urban_planning','pirate_economy']);
t('production bonuses collected', () => approx(eff.productionBonus.steel, 0.36, 1e-9));
t('infra cost multiplier applied', () => approx(eff.infraCostMultiplier, 0.95, 1e-9));
t('city discounts summed', () => eq(eff.cityCostDiscount, 50000000));

t('mass irrigation improves farm divisor', () => {
  eq(eff.farmLandDivisor, C.FARM.LAND_DIVISOR_IRRIGATED);
  if (!(C.FARM.LAND_DIVISOR_IRRIGATED < C.FARM.LAND_DIVISOR_PER_TURN)) {
    throw new Error('irrigated divisor must be smaller than normal');
  }
});
t('pirate economy adds war slot', () => eq(eff.offensiveWarSlots, 6));
t('unknown projects flagged not crashed', () => {
  const e = mod.aggregateProjectEffects(['ironworks','death_ray']);
  eq(e.unknown.length, 1); eq(e.unknown[0], 'death_ray');
});
t('projects are permanent (no rebuild)', () => {
  const r = mod.canBuildProject({projects:['ironworks']}, 'ironworks', {money:1e12});
  eq(r.ok, false);
  if (!r.reason.includes('permanent')) throw new Error(r.reason);
});

console.log('\n-- Policies --');
t('Manifest Destiny -5%', () => {
  approx(mod.domesticPolicyEffects('manifest_destiny').cityCostMultiplier, 0.95, 1e-9);
});
t('Govt Support Agency amplifies to -7.5%', () => {
  const e = mod.domesticPolicyEffects('manifest_destiny', ['government_support_agency']);
  approx(e.cityCostMultiplier, 0.925, 1e-9);
});
t('war policy cooldown = 5 days = 60 turns', () => {
  eq(mod.canChangePolicy('war', 100, 130).ok, false);
  eq(mod.canChangePolicy('war', 100, 160).ok, true);
});

console.log('\n-- Color blocs --');
t('matching alliance color pays', () => {
  if (!(mod.colorBlocBonus('blue','blue') > 0)) throw new Error('no bonus');
});
t('mismatch pays nothing', () => eq(mod.colorBlocBonus('blue','red'), 0));
t('unaligned pays nothing', () => eq(mod.colorBlocBonus('blue',null), 0));
t('beige pays regardless of alliance', () => {
  eq(mod.colorBlocBonus('beige',null), C.COLORS.BEIGE.perTurnBonus);
});
t('gray pays nothing', () => eq(mod.colorBlocBonus('gray','gray'), 0));
t('beige is immune to new declarations', () => {
  const s = mod.resolveColorState({beigeUntilTurn:200}, 100);
  eq(s.color,'beige'); eq(s.immuneToNewDeclarations, true);
});
t('inactivity -> gray after 5 days', () => {
  const s = mod.resolveColorState({color:'blue', lastActiveTurn:0}, 61);
  eq(s.color,'gray'); eq(s.reason,'inactive');
});
t('gray excluded from total score', () => {
  eq(mod.resolveColorState({color:'blue', lastActiveTurn:0}, 100).countsTowardTotalScore, false);
});

console.log('\n-- Alliance tax --');
t('seniority required (2 days)', () => {
  const r = mod.collectAllianceTax({joinedAllianceTurn:0}, {money:0.25}, {currentTurn:10, incomeThisTurn:10000});
  eq(r.exempt, true);
});
t('collects after seniority', () => {
  const r = mod.collectAllianceTax({joinedAllianceTurn:0}, {money:0.25},
    {currentTurn:100, incomeThisTurn:10000, productionThisTurn:{steel:10}});
  eq(r.exempt, false); eq(r.money, 2500);
});
t('beige exempt from tax', () => {
  const r = mod.collectAllianceTax({joinedAllianceTurn:0, beigeUntilTurn:500}, {money:0.25},
    {currentTurn:100, incomeThisTurn:10000});
  eq(r.exempt, true);
});
t('credits never taxed', () => {
  const r = mod.collectAllianceTax({joinedAllianceTurn:0}, {money:0.25, resources:0.5},
    {currentTurn:100, productionThisTurn:{credits:100, steel:10}});
  eq(r.resources.credits, undefined);
});

console.log('\n-- Radiation --');
t('decays over 100 turns', () => {
  let r = 5;
  for (let i=0;i<100;i++) r = mod.decayRadiation(r,1);
  approx(r, 0, 0.01);
});
t('never negative', () => eq(mod.decayRadiation(0.01, 100), 0));
t('nuke adds to continent AND world', () => {
  const r = mod.addNukeRadiation(0,0);
  eq(r.continent, 5); eq(r.global, 1);
});

console.log('\n========== FULL ENGINE INTEGRATION ==========');
const nation = tick.createNation('Testland','europe',0,{startingMoney:50000000, startingFood:5000});
nation.cities[0].infrastructure = 1000;
nation.cities[0].land = 2000;
nation.cities[0].improvements = {
  coal_mine:5, iron_mine:5, farm:10, coal_power:2,
  steel_mill:3, bank:5, supermarket:4, hospital:2,
};
nation.units = {soldiers:20000, tanks:500, aircraft:20, ships:0, missiles:0, nukes:0};
nation.stockpile.coal = 500; nation.stockpile.iron = 500;

let state = tick.createGameState(nation, 0);

console.log('\n-- Snapshot --');
const snap = tick.snapshot(state.nation, 0);
console.log(`    score:      ${snap.score}`);
console.log(`    population: ${snap.totalPopulation.toLocaleString()}`);
console.log(`    war range:  ${snap.warRange.min.toFixed(0)} - ${snap.warRange.max.toFixed(0)}`);
console.log(`    net income: $${snap.revenue.netIncomePerDay.toLocaleString()}/day`);
console.log(`    powered:    ${snap.perCity[0].powered}`);
t('snapshot is complete', () => {
  for (const k of ['score','totalPopulation','revenue','colorState','warRange']) {
    if (snap[k] === undefined) throw new Error(`missing ${k}`);
  }
});
t('derived, not stored: no population field on the nation', () => {
  if (state.nation.population !== undefined) throw new Error('population was stored');
});

console.log('\n-- Running 24 turns (2 days) --');
const run = tick.processTurns(state, 24, {});
const after = run.state;
const dayChanges = run.events.filter(e => e.type === 'day_change');
const incomeEvents = run.events.filter(e => e.type === 'daily_income');

console.log(`    turns processed:  ${after.turn}`);
console.log(`    day changes:      ${dayChanges.length}`);
console.log(`    money: $${nation.money.toLocaleString()} -> $${after.nation.money.toLocaleString()}`);
console.log(`    coal:  ${nation.stockpile.coal} -> ${after.nation.stockpile.coal.toFixed(1)}`);
console.log(`    steel: 0 -> ${after.nation.stockpile.steel.toFixed(1)}`);
console.log(`    food:  ${nation.stockpile.food} -> ${after.nation.stockpile.food.toFixed(1)}`);
console.log(`    MAP:   0 -> ${after.nation.map}`);

t('advanced exactly 24 turns', () => eq(after.turn, 24));
t('exactly 2 day-changes in 24 turns', () => eq(dayChanges.length, 2));
t('income paid on day changes only', () => eq(incomeEvents.length, 2));
t('MAP capped', () => eq(after.nation.map, C.COMBAT.MAP_MAX));
t('steel was manufactured', () => {
  if (!(after.nation.stockpile.steel > 0)) throw new Error('no steel produced');
});
t('coal consumed by mills and power', () => {
  if (!(after.nation.stockpile.coal !== 500)) throw new Error('coal unchanged');
});
t('ORIGINAL STATE NOT MUTATED', () => {
  eq(state.turn, 0);
  eq(state.nation.map, 0);
});
t('stockpiles never go negative', () => {
  for (const [r,v] of Object.entries(after.nation.stockpile)) {
    if (v < 0) throw new Error(`${r} = ${v}`);
  }
});

console.log('\n-- Beige protection --');
t('new nations start beige for 14 days', () => {
  const s = mod.resolveColorState(after.nation, after.turn);
  eq(s.color, 'beige');
  eq(s.immuneToNewDeclarations, true);
});
t('beige expires and emits an event', () => {
  const long = tick.processTurns(tick.createGameState(tick.createNation('X','europe',0), 0), 200, {});
  const expired = long.events.filter(e => e.type === 'beige_expired');
  eq(expired.length, 1);
});

console.log('\n-- Actions (validate, describe, do not apply) --');
const buy = tick.actions.buyInfrastructure(after, {cityIndex:0, targetInfra:1100});
console.log(`    buy 100 infra: $${buy.cost.toLocaleString()}, efficient: ${buy.efficient}`);
t('returns cost and changes, applies nothing', () => {
  eq(buy.ok, true);
  eq(after.nation.cities[0].infrastructure, 1000);
});
t('rejects unaffordable', () => {
  const poor = JSON.parse(JSON.stringify(after));
  poor.nation.money = 100;
  eq(tick.actions.buyInfrastructure(poor, {cityIndex:0, targetInfra:2000}).ok, false);
});
t('flags inefficient purchases', () => {
  eq(tick.actions.buyInfrastructure(after,{cityIndex:0,targetInfra:1050}).efficient, false);
});
t('city cooldown enforced past 10 cities', () => {
  const big = JSON.parse(JSON.stringify(after));
  big.nation.cities = Array(12).fill(null).map((_,i) => ({
    name:'C'+i, infrastructure:500, land:1000, improvements:{}, foundedTurn:0, continent:'europe'}));
  big.nation.lastCityTurn = big.turn - 10;
  big.nation.money = 1e12;
  eq(tick.actions.foundCity(big,{name:'New',continent:'europe'}).ok, false);
});
t('recruit respects daily cap', () => {
  const r = tick.actions.recruit(after, {unitKey:'soldiers', count:999999});
  eq(r.ok, false);
});

console.log('\n-- Bankruptcy --');
const broke = JSON.parse(JSON.stringify(after));
broke.nation.money = 0;
broke.nation.units = {soldiers:500000, tanks:50000, aircraft:5000, ships:0, missiles:0, nukes:0};
const brokeRun = tick.processTurns(broke, 12, {});
const bankruptcy = brokeRun.events.filter(e => e.type === 'bankruptcy');
t('bankruptcy triggers on unpayable upkeep', () => {
  if (bankruptcy.length === 0) throw new Error('no bankruptcy despite huge upkeep');
});
t('units desert (upkeep is a REAL constraint)', () => {
  const deserted = bankruptcy[0].deserted;
  if (!deserted.tanks || deserted.tanks <= 0) throw new Error('no desertion: ' + JSON.stringify(deserted));
  console.log(`      deserted: ${JSON.stringify(deserted)}`);
});
t('money floors at 0', () => {
  if (brokeRun.state.nation.money < 0) throw new Error('negative money');
});

console.log('\n-- Guards --');
t('refuses runaway batch processing', () => {
  try { tick.processTurns(state, 5000, {}); throw new Error('should throw'); }
  catch(e){ if(!(e instanceof RangeError)) throw e; }
});
t('layer cadence defined for all 4 layers', () => {
  eq(Object.keys(tick.LAYER_CADENCE).length, 4);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail>0?1:0);
