const cbt = require('../src/engine/combat');
const mil = require('../src/engine/military');
const C = require('../src/engine/constants');

let pass=0, fail=0;
function t(n,f){ try{f();console.log('  PASS '+n);pass++;}catch(e){console.log('  FAIL '+n+' -> '+e.message);fail++;} }
function eq(a,b,m){ if(a!==b) throw new Error(`${m||''} expected ${b}, got ${a}`); }
function approx(a,b,tol,m){ if(Math.abs(a-b)>tol) throw new Error(`${m||''} expected ~${b}, got ${a}`); }

const city = (name, infra, land, imps={}) => ({name, infrastructure:infra, land, improvements:imps});

console.log('\n-- Determinism --');
t('same seed = identical battle', () => {
  const a = cbt.rollBattle(1000, 800, cbt.makeRng(42));
  const b = cbt.rollBattle(1000, 800, cbt.makeRng(42));
  eq(JSON.stringify(a), JSON.stringify(b));
});
t('different seed = different battle', () => {
  const a = cbt.rollBattle(1000, 1000, cbt.makeRng(1));
  const b = cbt.rollBattle(1000, 1000, cbt.makeRng(999));
  if (JSON.stringify(a) === JSON.stringify(b)) throw new Error('seeds not independent');
});
t('always exactly 3 rolls', () => eq(cbt.rollBattle(500,500,cbt.makeRng(7)).rolls.length, 3));

console.log('\n-- THE 40-100% BAND (master tuning knob) --');
const ratios = [0.5, 0.8, 1.0, 1.5, 2.0, 2.5, 3.0];
console.log('    ratio | UF    PV    MS    IT    | any win');
for (const r of ratios) {
  const o = cbt.battleOdds(1000*r, 1000, 20000);
  console.log(`    ${r.toFixed(1)}x  | ${(o.utterFailure*100).toFixed(1)}% ${(o.pyrrhicVictory*100).toFixed(1)}% ${(o.moderateSuccess*100).toFixed(1)}% ${(o.immenseTriumph*100).toFixed(1)}% | ${(o.anyVictory*100).toFixed(1)}%`);
}
t('even match is symmetric and uncertain', () => {
  const o = cbt.battleOdds(1000,1000,20000);
  // "any victory" = winning at least 1 of 3 rolls, which at even odds is
  // 1 - 0.5^3 = 87.5%. The meaningful symmetry check is that a total sweep
  // and a total loss are equally likely.
  approx(o.immenseTriumph, o.utterFailure, 0.02, 'IT vs UF symmetry:');
  approx(o.moderateSuccess, o.pyrrhicVictory, 0.02, 'MS vs PV symmetry:');
  approx(o.expectedVictoryType, 1.5, 0.05, 'expected tier should be dead centre:');
  if (o.immenseTriumph > 0.20) throw new Error('even match too decisive: IT ' + o.immenseTriumph);
});
t('2.5x is a near-guaranteed sweep', () => {
  const o = cbt.battleOdds(2500,1000,20000);
  if (o.immenseTriumph < 0.85) throw new Error('2.5x only sweeps ' + (o.immenseTriumph*100).toFixed(1) + '%');
});
t('underdog can still win (upsets exist)', () => {
  const o = cbt.battleOdds(800,1000,20000);
  if (o.anyVictory < 0.15) throw new Error('no upset potential: ' + o.anyVictory);
});
t('odds are monotonic in ratio', () => {
  let prev = -1;
  for (const r of ratios) {
    const o = cbt.battleOdds(1000*r,1000,20000);
    if (o.anyVictory < prev) throw new Error('non-monotonic at ' + r);
    prev = o.anyVictory;
  }
});

console.log('\n-- Damage cap (prevents one-shot kills) --');
t('cap = infra*0.5 + 100', () => eq(cbt.infraDamageCap(2000), 1100));
t('overwhelming force cannot exceed cap', () => {
  const dmg = cbt.groundInfraDamage(
    {soldiers:10000000, tanks:1000000}, {soldiers:0, tanks:0},
    3, 2000, cbt.makeRng(5));
  if (dmg > cbt.infraDamageCap(2000)) throw new Error(`${dmg} exceeded cap`);
});
t('no city dies in one hit', () => {
  const infra = 1000;
  const dmg = cbt.groundInfraDamage({soldiers:1e9,tanks:1e9},{soldiers:0,tanks:0},3,infra,cbt.makeRng(3));
  if (dmg >= infra) throw new Error('city wiped in one battle');
});
t('damage never negative (defender stronger)', () => {
  const dmg = cbt.groundInfraDamage({soldiers:10,tanks:0},{soldiers:100000,tanks:5000},3,1000,cbt.makeRng(9));
  eq(dmg, 0);
});

console.log('\n-- Victory scaling --');
t('Utter Failure does zero damage', () => {
  eq(cbt.groundInfraDamage({soldiers:50000,tanks:2000},{soldiers:0,tanks:0},0,2000,cbt.makeRng(1)), 0);
});
t('damage scales with tier', () => {
  const d = [1,2,3].map(vt =>
    cbt.groundInfraDamage({soldiers:50000,tanks:1000},{soldiers:0,tanks:0},vt,5000,cbt.makeRng(11)));
  if (!(d[0] < d[1] && d[1] < d[2])) throw new Error('not scaling: ' + d.join(','));
  approx(d[2]/d[0], 3, 0.01, 'IT should be 3x Pyrrhic:');
});
t('Utter Failure removes ZERO resistance', () => eq(cbt.resistanceLoss('ground_battle',0), 0));
t('Immense Triumph removes full 10', () => eq(cbt.resistanceLoss('ground_battle',3), 10));

console.log('\n-- Loot --');
t('$1M floor: nobody looted to zero', () => {
  const loot = cbt.computeLoot({soldiers:1e6, tanks:1e5}, 1500000, 3, cbt.makeRng(2));
  if (1500000 - loot < 1000000) throw new Error(`left only ${1500000-loot}`);
});
t('75% cap respected', () => {
  const money = 100000000;
  const loot = cbt.computeLoot({soldiers:1e7, tanks:1e6}, money, 3, cbt.makeRng(4));
  if (loot > money*0.75) throw new Error('exceeded 75%');
});
t('defeat with <$1M loots nothing', () => eq(cbt.computeLoot({soldiers:1e6}, 500000, 3, cbt.makeRng(6)), 0));
t('Utter Failure loots nothing', () => eq(cbt.computeLoot({soldiers:1e5,tanks:1e4}, 1e9, 0, cbt.makeRng(8)), 0));

console.log('\n-- War types --');
const wt = ['attrition','ordinary','raid'].map(w => ({w, m: cbt.resolveModifiers({warType:w})}));
wt.forEach(({w,m}) => console.log(`    ${w.padEnd(9)} infra x${m.infraDamage.toFixed(2)}  loot x${m.loot.toFixed(2)}`));
t('attrition maximises damage, minimises loot', () => {
  eq(wt[0].m.infraDamage, 1.0); eq(wt[0].m.loot, 0.25);
});
t('raid is the inverse', () => { eq(wt[2].m.infraDamage, 0.25); eq(wt[2].m.loot, 1.0); });

console.log('\n-- War policies (strict tradeoffs) --');
t('Attrition policy: +10% damage, -20% loot', () => {
  const m = cbt.resolveModifiers({warType:'ordinary', attackerPolicy:'attrition'});
  approx(m.infraDamage, 0.5*1.1, 1e-9);
  approx(m.loot, 0.5*0.8, 1e-9);
});
t('Turtle: -10% damage taken, +20% loot lost', () => {
  const m = cbt.resolveModifiers({warType:'ordinary', defenderPolicy:'turtle'});
  approx(m.infraDamage, 0.5*0.9, 1e-9);
  approx(m.loot, 0.5*1.2, 1e-9);
});
t('Moneybags: -40% loot lost, +5% damage taken', () => {
  const m = cbt.resolveModifiers({warType:'ordinary', defenderPolicy:'moneybags'});
  approx(m.loot, 0.5*0.6, 1e-9);
  approx(m.infraDamage, 0.5*1.05, 1e-9);
});
t('Moneybags counters Pirate', () => {
  const vsNormal = cbt.resolveModifiers({warType:'raid', attackerPolicy:'pirate'});
  const vsMoneybags = cbt.resolveModifiers({warType:'raid', attackerPolicy:'pirate', defenderPolicy:'moneybags'});
  if (!(vsMoneybags.loot < vsNormal.loot)) throw new Error('moneybags did not reduce pirate loot');
});
t('Fortify raises attacker casualties 25%', () => {
  const m = cbt.resolveModifiers({defenderFortified:true});
  approx(m.casualtiesTaken, 1.25, 1e-9);
});

console.log('\n-- Control states (the asymmetry) --');
t('Immense Triumph GRANTS control', () => eq(cbt.resolveControlState('ground_battle',3,null).gained, 'ground_control'));
t('Moderate Success does NOT grant', () => eq(cbt.resolveControlState('ground_battle',2,null).gained, null));
t('but ANY win nullifies enemy control (comeback path)', () => {
  eq(cbt.resolveControlState('ground_battle',1,'ground_control').nullified, 'ground_control');
  eq(cbt.resolveControlState('ground_battle',2,'ground_control').nullified, 'ground_control');
});
t('Utter Failure nullifies nothing', () => eq(cbt.resolveControlState('ground_battle',0,'ground_control').nullified, null));
t('airstrike -> air superiority, naval -> blockade', () => {
  eq(cbt.resolveControlState('airstrike',3,null).gained, 'air_superiority');
  eq(cbt.resolveControlState('naval_battle',3,null).gained, 'blockade');
});

console.log('\n-- THE SUPPLY RULE IN COMBAT --');
const attacker = {
  units:{soldiers:50000, tanks:2000, aircraft:100, ships:0},
  stockpile:{munitions:1000, gasoline:1000},
};
const starving = {
  units:{soldiers:50000, tanks:2000, aircraft:100, ships:0},
  stockpile:{munitions:0, gasoline:0},
};
const defender = {
  units:{soldiers:30000, tanks:1000, aircraft:50, ships:0},
  stockpile:{munitions:1000, gasoline:1000},
  cities:[city('Capital',2000,4000,{bank:3}), city('Second',1000,2000)],
  money:50000000, population:200000,
};
const supplied = cbt.groundBattle({attacker, defender, opts:{rng:cbt.makeRng(100), warType:'ordinary'}});
const unsupplied = cbt.groundBattle({attacker:starving, defender, opts:{rng:cbt.makeRng(100), warType:'ordinary'}});
console.log(`    supplied:   value ${supplied.attackerValue.toLocaleString()} -> ${supplied.victoryName}`);
console.log(`    unsupplied: value ${unsupplied.attackerValue.toLocaleString()} -> ${unsupplied.victoryName}`);
t('unsupplied army is far weaker', () => {
  if (!(unsupplied.attackerValue < supplied.attackerValue * 0.4)) throw new Error('not weak enough');
});
t('unsupplied tanks STILL take casualties', () => {
  if (unsupplied.attackerCasualties.tanks <= 0) throw new Error('ghost tanks took no losses - rule broken');
});
console.log(`    unsupplied army lost ${unsupplied.attackerCasualties.tanks} tanks that contributed NOTHING`);

console.log('\n-- Full ground battle --');
console.log(`    ${supplied.victoryName} (${supplied.victoryType}/3 rolls)`);
console.log(`    target: ${supplied.targetCity}, infra destroyed: ${supplied.infraDestroyed}`);
console.log(`    resistance removed: ${supplied.resistanceLoss}`);
console.log(`    loot: $${supplied.loot.toLocaleString()}`);
console.log(`    attacker lost: ${JSON.stringify(supplied.attackerCasualties)}`);
console.log(`    defender lost: ${JSON.stringify(supplied.defenderCasualties)}`);
t('targets highest-infra city', () => eq(supplied.targetCity, 'Capital'));
t('costs 3 MAP', () => eq(supplied.mapCost, 3));
t('blocked without MAP', () => {
  const r = cbt.groundBattle({attacker, defender, opts:{currentMap:1, rng:cbt.makeRng(1)}});
  eq(r.ok, false);
});
t('reports consumption to deduct', () => {
  if (!(supplied.consumption.attacker.munitions > 0)) throw new Error('no munitions consumed');
});
t('does not mutate inputs', () => {
  eq(defender.cities[0].infrastructure, 2000);
  eq(attacker.units.tanks, 2000);
});

console.log('\n-- Airstrike & naval --');
const air = cbt.airStrike({attacker, defender, opts:{rng:cbt.makeRng(55)}});
t('airstrike costs 4 MAP', () => eq(air.mapCost, 4));
t('airstrike loots nothing', () => eq(air.loot, 0));
t('unit-targeted strike destroys units + 1/3 collateral', () => {
  const a = cbt.airStrike({attacker, defender, opts:{rng:cbt.makeRng(77), target:'infrastructure'}});
  const b = cbt.airStrike({attacker, defender, opts:{rng:cbt.makeRng(77), target:'tanks'}});
  approx(b.infraDestroyed/a.infraDestroyed, 1/3, 0.01);
  if (!(b.unitsDestroyed.tanks > 0)) throw new Error('no tanks destroyed');
});
const nav = cbt.navalBattle({attacker:{...attacker, units:{...attacker.units, ships:20}},
  defender:{...defender, units:{...defender.units, ships:5}}, opts:{rng:cbt.makeRng(88)}});
t('naval grants blockade on IT', () => {
  if (nav.victoryType === 3 && nav.control.gained !== 'blockade') throw new Error('no blockade');
});

console.log('\n-- Resistance & defeat --');
t('resistance floors at 0', () => {
  const r = cbt.applyResistance(5, 10);
  eq(r.resistance, 0); eq(r.defeated, true);
});
t('not defeated above 0', () => eq(cbt.applyResistance(100, 10).defeated, false));
t('5 naval + 3 ground IT reaches zero (documented fastest route)', () => {
  let res = C.COMBAT.RESISTANCE_START;
  for (let i=0;i<5;i++) res = cbt.applyResistance(res, cbt.resistanceLoss('naval_battle',3)).resistance;
  for (let i=0;i<3;i++) res = cbt.applyResistance(res, cbt.resistanceLoss('ground_battle',3)).resistance;
  eq(res, 0);
});

const defeat = cbt.applyDefeat({money:100000000, stockpile:{steel:1000, credits:50}, cities:defender.cities}, {warType:'ordinary'});
console.log(`    beige ${defeat.beigeDays} days, money lost $${defeat.moneyLost.toLocaleString()}, steel lost ${defeat.resourcesLost.steel}`);
t('credits are NOT lootable', () => eq(defeat.resourcesLost.credits, undefined));
t('alliance bank is looted', () => eq(defeat.allianceBankLooted, true));
t('infra lost from every city', () => eq(defeat.infraLost.length, 2));
t('beige stacks per war lost', () => {
  eq(cbt.beigeTurnsRemaining(1), 24);
  eq(cbt.beigeTurnsRemaining(3), 72);
});

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log('='.repeat(50));
process.exit(fail>0?1:0);
