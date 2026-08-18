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
t('Blitzkrieg: +12% damage, +15% own casualties', () => {
  const m = cbt.resolveModifiers({warType:'ordinary', attackerPolicy:'blitzkrieg'});
  approx(m.infraDamage, 0.5*1.12, 1e-9);
  approx(m.casualtiesTaken, 1.15, 1e-9);
});
t('Fortress Doctrine: -12% damage taken, -10% dealt', () => {
  const m = cbt.resolveModifiers({warType:'ordinary', defenderPolicy:'fortress_doctrine'});
  approx(m.infraDamage, 0.5*0.88, 1e-9);
  // The defender's own offence suffers too — but that shows on THEIR attacks.
  const asAttacker = cbt.resolveModifiers({warType:'ordinary', attackerPolicy:'fortress_doctrine'});
  approx(asAttacker.infraDamage, 0.5*0.90, 1e-9);
});
t('Privateering: +25% loot, -15% damage dealt', () => {
  const m = cbt.resolveModifiers({warType:'raid', attackerPolicy:'privateering'});
  approx(m.loot, 1.0*1.25, 1e-9);
  approx(m.infraDamage, 0.25*0.85, 1e-9);
});
t('BOTH sides\' doctrine applies at once', () => {
  const both = cbt.resolveModifiers({
    warType:'ordinary', attackerPolicy:'blitzkrieg', defenderPolicy:'fortress_doctrine'});
  approx(both.infraDamage, 0.5*1.12*0.88, 1e-9);
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

console.log('\n-- Missiles & nuclear weapons --');

const strikeCity = { id: 1, name: 'Capital', continent: 'europe', infrastructure: 2000,
                     improvements: { coal_mine: 4, bank: 2, hospital: 1 } };
const strikeParams = (projects = [], units = { missiles: 3, nukes: 2 }, seed = 11) => ({
  attacker: { units, projects: [] },
  defender: { cities: [strikeCity], projects },
  opts: { currentMap: 12, rng: cbt.makeRng(seed) },
});

t('a launch does NOT roll — no victory type, no dice', () => {
  const r = cbt.nuclearAttack(strikeParams());
  if (r.victoryType !== undefined) throw new Error('a launch produced a victory type');
  if (r.rolls !== undefined) throw new Error('a launch rolled dice');
  // Full resistance loss: there was no contest to scale by.
  eq(r.resistanceLoss, C.COMBAT.RESISTANCE_LOSS.nuclear_attack, 'nuke resistance:');
});

t('NO CITY DIES IN ONE HIT — at any city size', () => {
  // The per-battle cap is infra*0.5 + 100. On a small city that flat term is
  // larger than the city, so the cap alone let a nuke erase it outright.
  for (const infra of [50, 100, 250, 1000, 3000]) {
    const city = { id: 9, name: 'T', continent: 'asia', infrastructure: infra, improvements: {} };
    const r = cbt.nuclearAttack({
      attacker: { units: { nukes: 1 } }, defender: { cities: [city], projects: [] },
      opts: { currentMap: 12, rng: cbt.makeRng(3) },
    });
    if (r.infraDestroyed >= infra) {
      throw new Error(`a nuke erased a ${infra}-infra city completely`);
    }
    const share = r.infraDestroyed / infra;
    if (share > C.COMBAT.STRIKE_MAX_FRACTION_OF_CITY + 0.001) {
      throw new Error(`took ${Math.round(share * 100)}% of a ${infra}-infra city`);
    }
  }
});

t('a nuke hurts more than a missile', () => {
  const m = cbt.missileStrike(strikeParams());
  const n = cbt.nuclearAttack(strikeParams());
  if (!(n.infraDestroyed > m.infraDestroyed)) throw new Error('nuke did not out-damage a missile');
  if (!(n.resistanceLoss > m.resistanceLoss)) throw new Error('nuke removes no more resistance');
});

t('missiles level ground; nukes take buildings with them', () => {
  eq(cbt.missileStrike(strikeParams()).improvementsDestroyed.length, 0, 'missile improvements:');
  const n = cbt.nuclearAttack(strikeParams());
  eq(n.improvementsDestroyed.length, C.COMBAT.NUKE.IMPROVEMENTS_DESTROYED, 'nuke improvements:');
  for (const key of n.improvementsDestroyed) {
    if (!strikeCity.improvements[key]) throw new Error(`destroyed ${key}, which the city never had`);
  }
});

t('INTERCEPTION STILL COSTS THE ATTACKER THE WEAPON', () => {
  // If interception refunded the weapon, the defence project would buy delay
  // rather than safety and the attacker would simply fire again next turn.
  let sawIntercept = false;
  for (let seed = 1; seed <= 60 && !sawIntercept; seed++) {
    const r = cbt.nuclearAttack({
      attacker: { units: { nukes: 1 } },
      defender: { cities: [strikeCity], projects: ['vital_defense_system'] },
      opts: { currentMap: 12, rng: cbt.makeRng(seed) },
    });
    if (!r.intercepted) continue;
    sawIntercept = true;
    eq(r.infraDestroyed, 0, 'intercepted damage:');
    eq(r.resistanceLoss, 0, 'intercepted resistance:');
    eq(r.radiation, null, 'intercepted radiation:');
    eq(r.consumed.nukes, 1, 'intercepted weapon must still be spent:');
  }
  if (!sawIntercept) throw new Error('never intercepted in 60 seeds — check the chance');
});

t('interception happens at roughly the project rate', () => {
  let stopped = 0;
  const N = 400;
  for (let seed = 1; seed <= N; seed++) {
    const r = cbt.nuclearAttack({
      attacker: { units: { nukes: 1 } },
      defender: { cities: [strikeCity], projects: ['vital_defense_system'] },
      opts: { currentMap: 12, rng: cbt.makeRng(seed) },
    });
    if (r.intercepted) stopped++;
  }
  const rate = stopped / N;
  const want = C.PROJECTS.vital_defense_system.effect.nukeInterceptChance;
  if (Math.abs(rate - want) > 0.08) {
    throw new Error(`intercepted ${(rate * 100).toFixed(1)}%, expected about ${want * 100}%`);
  }
});

t('without the project, nothing is ever intercepted', () => {
  for (let seed = 1; seed <= 50; seed++) {
    if (cbt.nuclearAttack(strikeParams([], { nukes: 1 }, seed)).intercepted) {
      throw new Error('intercepted a nuke with no Vital Defense System');
    }
  }
});

t('RADIATION HITS THE CONTINENT AND THE WORLD', () => {
  // The mechanic that makes nuclear war a diplomatic problem rather than
  // merely an expensive one: nations with no part in the war pay for it too.
  const n = cbt.nuclearAttack(strikeParams());
  if (!n.radiation) throw new Error('a nuke produced no radiation');
  eq(n.radiation.continent, 'europe', 'continent:');
  eq(n.radiation.continentAmount, C.RADIATION.PER_NUKE_CONTINENT, 'continent roentgen:');
  eq(n.radiation.worldAmount, C.RADIATION.PER_NUKE_GLOBAL, 'world roentgen:');

  if (cbt.missileStrike(strikeParams()).radiation !== null) {
    throw new Error('a conventional missile produced fallout');
  }
});

t('Fallout Shelter cuts the blast AND shortens the fallout', () => {
  const bare = cbt.nuclearAttack(strikeParams([]));
  const shelt = cbt.nuclearAttack(strikeParams(['fallout_shelter']));
  if (!(shelt.infraDestroyed < bare.infraDestroyed)) throw new Error('shelter did not reduce damage');
  if (!(shelt.radiation.dissipationTurns < bare.radiation.dissipationTurns)) {
    throw new Error('shelter did not shorten the fallout');
  }
});

t('a launch refuses without the weapon or the action points', () => {
  const noWeapon = cbt.nuclearAttack({
    attacker: { units: {} }, defender: { cities: [strikeCity] }, opts: { currentMap: 12 } });
  if (noWeapon.ok) throw new Error('launched with no nukes');

  const noMap = cbt.nuclearAttack({
    attacker: { units: { nukes: 1 } }, defender: { cities: [strikeCity] }, opts: { currentMap: 2 } });
  if (noMap.ok) throw new Error('launched without the action points');
  if (!/MAP/.test(noMap.reason)) throw new Error('unclear reason: ' + noMap.reason);
});

t('a launch against a nation with no cities is refused, not a crash', () => {
  const r = cbt.nuclearAttack({
    attacker: { units: { nukes: 1 } }, defender: { cities: [] }, opts: { currentMap: 12 } });
  if (r.ok) throw new Error('launched at nothing');
});

t('launches are deterministic from their seed, like every other battle', () => {
  const a = cbt.nuclearAttack(strikeParams([], { nukes: 1 }, 77));
  const b = cbt.nuclearAttack(strikeParams([], { nukes: 1 }, 77));
  eq(JSON.stringify(a), JSON.stringify(b), 'same seed, same result:');
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
