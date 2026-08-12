const mil = require('../src/engine/military');
const C = require('../src/engine/constants');

let pass=0, fail=0;
function t(n,f){ try{f();console.log('  PASS '+n);pass++;}catch(e){console.log('  FAIL '+n+' -> '+e.message);fail++;} }
function eq(a,b,m){ if(a!==b) throw new Error(`${m||''} expected ${b}, got ${a}`); }
function approx(a,b,tol,m){ if(Math.abs(a-b)>tol) throw new Error(`${m||''} expected ~${b}, got ${a}`); }

const city = (infra, land, imps={}) => ({infrastructure:infra, land, improvements:imps});

console.log('\n-- Military score --');
t('empty army = 0', () => eq(mil.militaryScore({}), 0));
t('coefficients applied', () => {
  approx(mil.militaryScore({soldiers:10000, tanks:1000, aircraft:100, ships:10}),
         10000*0.0004 + 1000*0.025 + 100*0.3 + 10*1, 1e-9);
});
t('missiles capped at 50', () => {
  eq(mil.militaryScore({missiles:1000}), 50);
  approx(mil.militaryScore({missiles:5}), 25, 1e-9);
});
t('nukes capped at 50', () => eq(mil.militaryScore({nukes:1000}), 50));
t('caps are independent (100 total max)', () => eq(mil.militaryScore({missiles:99, nukes:99}), 100));

console.log('\n-- SHIPS ARE A TRAP (score efficiency) --');
const tankEff = mil.scoreEfficiency('tanks');
const soldEff = mil.scoreEfficiency('soldiers');
console.log(`    tank:    ${tankEff.scorePerUnit} score / ${tankEff.armyValuePerUnit} army value = ${tankEff.scorePerArmyValue.toFixed(6)}`);
console.log(`    soldier: ${soldEff.scorePerUnit} score / ${soldEff.armyValuePerUnit} army value = ${soldEff.scorePerArmyValue.toFixed(6)}`);
t('soldiers are more score-efficient than tanks', () => {
  if (!(soldEff.scorePerArmyValue < tankEff.scorePerArmyValue))
    throw new Error('expected soldiers to be cheaper per army value');
});

console.log('\n-- Nation score --');
const nation = {
  cities: [city(2000,4000), city(1500,3000), city(1000,2000)],
  projects: ['ironworks','mass_irrigation'],
  units: {soldiers:50000, tanks:2000, aircraft:200},
};
const sb = mil.scoreBreakdown(nation);
console.log(`    total score: ${sb.total}`);
console.log(`      base ${sb.components.base}, cities ${sb.components.cities}, infra ${sb.components.infrastructure}, projects ${sb.components.projects}`);
console.log(`      soldiers ${sb.components.soldiers}, tanks ${sb.components.tanks}, aircraft ${sb.components.aircraft}`);
t('breakdown sums to total', () => {
  const sum = Object.values(sb.components).reduce((a,b)=>a+b,0);
  approx(sum, sb.total, 0.01);
});
t('matches nationScore()', () => approx(mil.nationScore(nation), sb.total, 0.01));
t('3 cities contribute 200 (cityCount-1)', () => eq(sb.components.cities, 200));
t('rejects nation with no cities', () => {
  try { mil.nationScore({cities:[]}); throw new Error('should throw'); }
  catch(e){ if(!(e instanceof RangeError)) throw e; }
});

console.log('\n-- War range (asymmetry) --');
const r = mil.warRange(1000);
console.log(`    score 1000 can attack: ${r.min} - ${r.max}`);
t('25% below to 75% above', () => { eq(r.min, 750); eq(r.max, 1750); });
t('can attack bigger nations', () => eq(mil.isInWarRange(1000, 1700), true));
t('cannot attack much bigger', () => eq(mil.isInWarRange(1000, 1800), false));
t('cannot attack much smaller', () => eq(mil.isInWarRange(1000, 700), false));

const v = mil.vulnerableToRange(1000);
console.log(`    score 1000 is attackable by: ${v.min.toFixed(1)} - ${v.max.toFixed(1)}`);
t('inverse range is mathematically consistent', () => {
  // anyone in my vulnerable range must be able to reach me
  eq(mil.isInWarRange(v.min, 1000), true);
  eq(mil.isInWarRange(v.max, 1000), true);
  eq(mil.isInWarRange(v.min - 1, 1000), false);
  eq(mil.isInWarRange(v.max + 1, 1000), false);
});

console.log('\n-- Recruitment --');
const cities = [city(1000,2000,{barracks:5, factory:5}), city(1000,2000,{barracks:5})];
t('barracks capacity 3000 each', () => eq(mil.unitCapacity(cities,'soldiers'), 10*3000));
t('daily cap 1000 per barracks', () => eq(mil.dailyRecruitmentCap(cities,'soldiers'), 10*1000));
t('Propaganda Bureau +10%', () => {
  eq(mil.dailyRecruitmentCap(cities,'soldiers',{projects:['propaganda_bureau']}), 11000);
});
t('capacity ceiling enforced', () => {
  const r = mil.canRecruit({cities, units:{soldiers:29500}}, 'soldiers', 1000);
  eq(r.ok, false); eq(r.maxPossible, 500);
});
t('daily rate enforced separately from capacity', () => {
  const r = mil.canRecruit({cities, units:{soldiers:0}}, 'soldiers', 5000, {recruitedToday:8000});
  eq(r.ok, false); eq(r.maxPossible, 2000);
});
t('nukes need the project', () => {
  const r = mil.canRecruit({cities, units:{}, projects:[]}, 'nukes', 1);
  eq(r.ok, false);
  if (!r.reason.includes('nuclear_research_facility')) throw new Error(r.reason);
});
t('nukes allowed with project', () => {
  const r = mil.canRecruit({cities, units:{}, projects:['nuclear_research_facility']}, 'nukes', 1);
  if (!r.ok) throw new Error(r.reason);
});
t('resource shortfall reported', () => {
  const r = mil.canRecruit({cities, units:{}}, 'tanks', 100, {stockpile:{money:100, steel:0}});
  eq(r.ok, false);
  if (!r.reason.includes('steel')) throw new Error(r.reason);
});

console.log('\n-- THE SUPPLY RULE --');
const army = {soldiers:10000, tanks:1000, aircraft:100, ships:0};

const full = mil.computeSupply(army, {munitions:10000, gasoline:10000});
t('fully supplied when stocked', () => {
  eq(full.fullySupplied, true);
  eq(full.suppliedTanks, 1000);
  eq(full.armedSoldiers, 10000);
});
console.log(`    full supply consumes ${full.consumption.munitions.toFixed(2)} munitions, ${full.consumption.gasoline.toFixed(2)} gasoline`);

const dry = mil.computeSupply(army, {munitions:0, gasoline:0});
t('ZERO supply: tanks contribute nothing', () => eq(dry.suppliedTanks, 0));
t('ZERO supply: but tanks still exist (will take casualties)', () => eq(dry.unsuppliedTanks, 1000));
t('ZERO supply: soldiers still fight, unarmed', () => eq(dry.unarmedSoldiers, 10000));

const dryValue = mil.armyValue(dry);
const fullValue = mil.armyValue(full);
console.log(`    supplied army value:   ${fullValue.toLocaleString()}`);
console.log(`    unsupplied army value: ${dryValue.toLocaleString()}  (${((1-dryValue/fullValue)*100).toFixed(1)}% loss)`);
t('unsupplied army is catastrophically weaker', () => {
  if (!(dryValue < fullValue * 0.3)) throw new Error(`only lost ${(1-dryValue/fullValue)*100}%`);
});

console.log('\n-- Supply priority (vehicles before soldiers) --');
const scarce = mil.computeSupply({soldiers:10000, tanks:100, aircraft:0, ships:0}, {munitions:1.5, gasoline:99});
t('tanks get munitions first', () => eq(scarce.suppliedTanks, 100));
t('soldiers get the leftovers', () => {
  if (scarce.armedSoldiers >= 10000) throw new Error('should be partially armed');
});
t('choosing tanks first is the better outcome (same munitions budget)', () => {
  const tanksFirst = mil.armyValue(scarce);
  // hypothetical: SAME 1.5 munitions all spent arming soldiers, no tanks supplied
  const perSoldier = C.UNITS.soldiers.battleConsumption.munitions;
  const armable = Math.min(10000, Math.floor(1.5 / perSoldier));
  const soldiersFirst = mil.armyValue({
    unarmedSoldiers: 10000 - armable, armedSoldiers: armable, suppliedTanks: 0,
  });
  console.log(`      tanks-first ${tanksFirst.toLocaleString()} vs soldiers-first ${soldiersFirst.toLocaleString()}`);
  if (!(tanksFirst > soldiersFirst)) throw new Error(`tanks-first ${tanksFirst} not better than soldiers-first ${soldiersFirst}`);
});
t('priority is DERIVED, not assumed: tanks have higher value/munition', () => {
  const tank = mil.armyValuePerMunition('tanks');
  const soldier = mil.armyValuePerMunition('soldiers');
  console.log(`      tanks ${tank.toFixed(0)}/munition vs soldiers ${soldier.toFixed(0)}/munition (margin ${((tank/soldier-1)*100).toFixed(1)}%)`);
  if (!(tank > soldier)) {
    throw new Error('PRIORITY INVERTED — constants changed, computeSupply() ordering is now wrong');
  }
});

console.log('\n-- Army value --');
t('formula: unarmed*1 + armed*1.75 + tanks*40', () => {
  const s = {unarmedSoldiers:1000, armedSoldiers:2000, suppliedTanks:50};
  approx(mil.armyValue(s), 1000*1 + 2000*1.75 + 50*40, 1e-9);
});
t('air superiority halves tank value', () => {
  const s = {unarmedSoldiers:0, armedSoldiers:0, suppliedTanks:100};
  approx(mil.armyValue(s, {airSuperiorityAgainst:true}), 100*40*0.5, 1e-9);
});
t('defender militia adds population/400', () => {
  const s = {unarmedSoldiers:0, armedSoldiers:0, suppliedTanks:0};
  approx(mil.armyValue(s, {defenderPopulation:200000}), 500, 1e-9);
});
t('effectiveArmyValue cannot skip supply', () => {
  const {value, supply} = mil.effectiveArmyValue(army, {munitions:0, gasoline:0});
  eq(supply.suppliedTanks, 0);
  eq(value, mil.armyValue(supply));
});

console.log('\n-- MAP --');
t('accrues to cap', () => eq(mil.accrueMap(0, 999), C.COMBAT.MAP_MAX));
t('ground battle costs 3', () => eq(mil.canPerformAction(5,'ground_battle').cost, 3));
t('blocks when short', () => {
  const r = mil.canPerformAction(2,'airstrike');
  eq(r.ok, false); eq(r.shortfall, 2);
});
t('unknown action rejected', () => {
  try { mil.canPerformAction(10,'space_laser'); throw new Error('should throw'); }
  catch(e){ if(!e.message.includes('Unknown action')) throw e; }
});

console.log('\n-- War declaration --');
const atk = {cities:[city(2000,4000),city(2000,4000)], projects:[], units:{tanks:1000}};
const atkScore = mil.nationScore(atk);
t('5 offensive slots, 6 with Pirate Economy', () => {
  eq(mil.offensiveWarSlots([]), 5);
  eq(mil.offensiveWarSlots(['pirate_economy']), 6);
});
t('blocked when slots full', () => {
  const r = mil.canDeclareWar(atk, {score:atkScore}, {currentOffensiveWars:5});
  eq(r.ok, false);
});
t('blocked when target has 3 defensive wars', () => {
  const r = mil.canDeclareWar(atk, {score:atkScore}, {targetDefensiveWars:3});
  eq(r.ok, false);
});
t('blocked on beige', () => {
  const r = mil.canDeclareWar(atk, {score:atkScore}, {targetOnBeige:true});
  eq(r.ok, false);
  if (!r.reason.includes('beige')) throw new Error(r.reason);
});
t('blocked out of range', () => {
  const r = mil.canDeclareWar(atk, {score: atkScore * 3});
  eq(r.ok, false);
  if (!r.reason.includes('war range')) throw new Error(r.reason);
});
t('allowed in range', () => eq(mil.canDeclareWar(atk, {score: atkScore * 1.5}).ok, true));

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail>0?1:0);
