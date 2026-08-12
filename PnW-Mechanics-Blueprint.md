# Politics & War — Complete Mechanics Blueprint

Reference document for reimplementation in **Grand Strategy** (Node/Express/PostgreSQL PBBG).

Every formula below is the live P&W formula as documented by the game and its wikis. Notes marked
**[ADAPT]** flag where our design (Force/Magnetism axis, 4-layer tick engine) diverges or where the
formula needs a change to fit our schema.

---

## 0. Design philosophy — read this first

P&W is **not** an agent-based simulation. It is roughly **15 closed-form formulas evaluated on a
fixed tick**, with randomness confined to a narrow band and outcomes bucketed into 4 discrete tiers.

That is the entire reason it runs 40,000+ players on modest hardware. Three properties make it work:

1. **State is derived, not accumulated.** Population is *recomputed* from infra/land/age every tick,
   not incremented. There is no drift, no desync, no need for event replay.
2. **Nonlinearity is concentrated.** Exactly three things are nonlinear (infra cost, city cost,
   disease density). Everything else is linear. All strategic depth comes from those three curves.
3. **Randomness is bounded and bucketed.** Combat rolls in a 40–100% band, then collapses to 4
   outcome tiers. Players can reason about odds; the server does 6 RNG calls per battle.

**[ADAPT]** Our L2 standard tick should follow rule 1 — recompute, don't accumulate. Accumulating
resource state across ticks is where TOCTOU bugs and duping exploits live.

---

## 1. Tick architecture

| Layer | Cadence | What happens |
|---|---|---|
| Turn | every 2 hours (12/day) | Resource production, resource consumption, alliance tax collection, MAP regeneration |
| Day change | 00:00 server time | Tax income, unit upkeep, unit recruitment caps reset, city age +1 |

Notable consequence: the day/turn split creates the **"double buy"** exploit-adjacent tactic —
players buy their full daily unit allowance just before 00:00 and again just after, effectively
doubling military in minutes.

**[ADAPT]** Our four layers map cleanly:

| Our layer | Dev interval | Should own |
|---|---|---|
| L1 micro | 10s | Market order matching, combat resolution, MAP regen |
| L2 standard | 30s | Production, consumption, upkeep, treasury |
| L3 macro | 120s | Population recompute, disease/crime, tech, city age |
| L4 epoch | 600s | Rankings, score recompute, cartel detection |

Put population recompute on **L3, not L2**. It's the most expensive query and it doesn't need to be
fast. Guard the double-buy hole by rate-limiting recruitment on a rolling window, not a calendar day.

---

## 2. The city model

A city is exactly three numbers plus a bag of improvements:

- **Infrastructure** — drives population and improvement slots
- **Land** — drives density (→ disease) and farm yield
- **Improvements** — the buildings; capped by infra

```
improvementSlots = floor(infrastructure / 50)
```

New cities start at **10 infra, 250 land**.

### 2.1 Cost curves — the three nonlinearities

**Infrastructure** (per-unit marginal cost, integrate over the purchase range):

```js
function infraUnitCost(currentInfra) {
  return 300 + Math.pow(currentInfra - 10, 2.2) / 710;
}
```

Exponent 2.2 is gentle enough that infra stays buyable for a long time but eventually dominates
the budget. Quirk worth preserving: the cheapest infra is **not** at zero, because of the `-10`.

**Land** — exponential, base cost 50/unit, and the game buys it in **500-unit brackets**
(first bracket is 250, since cities spawn with 250). Buying 700 land is charged as two transactions.
This bracketing is a UX decision that prevents micro-optimisation exploits.

**New city** — cubic, the hardest wall in the game:

```js
function nextCityCost(currentCityCount) {
  const X = currentCityCount;
  return 50000 * Math.pow(X - 1, 3) + 150000 * X + 75000;
}
```

City 2 costs $225,000. The cubic term means city 30 costs tens of billions. This is the primary
long-game money sink and the reason the economy doesn't hyperinflate.

**Discount stacking order matters** and is a real source of bugs:
1. Apply flat project discounts first (Urban Planning $50M, Advanced $100M, Metropolitan $150M — these stack)
2. Then apply Manifest Destiny policy −5% (−7.5% with Government Support Agency)
3. Floor the result at $1

**Additional gate:** past 10 cities, you must wait **120 turns (10 days)** between city purchases.

---

## 3. Population simulation

This is the most important subsystem to get right. It is where P&W's strategic depth actually lives.

### 3.1 Base population

```js
basePopulation = (infra * 100) + (infra / 1000) * (100 * cityAgeInDays / 3);
```

### 3.2 Disease rate

```js
function diseaseRate(infra, land, hospitals, pollution) {
  const density = (infra * 100) / (land + 0.001);
  let d = ((0.01 * density * density - 25) / 100)
        + (infra / 1000)
        - (hospitals * 2.5)
        + (pollution * 0.05);
  return Math.min(Math.max(d, 0), 1.0);   // clamp 0–100%
}

peopleKilledByDisease = diseaseRate * infra * 100;
```

**The squared density term is the single most load-bearing line in the whole game.** It creates:
- the "never let infra exceed land" rule every new-player guide leads with
- the entire land-purchase economy
- meaningful opportunity cost on improvement slots (hospitals vs. factories)
- pollution as a real cost rather than flavour text

At 100% disease a city collapses to a floor population of **10**. That hard failure state is a
deliberate teaching mechanism — new players blow up one city, learn density, never forget.

### 3.3 The feedback-loop break — critical implementation note

> Density for disease purposes is computed from **base** population, not displayed population.

If you use displayed population, disease reduces population → reduces density → reduces disease →
oscillates or converges wrongly. **Compute against base pop.** We will hit this exact bug in the L3
demographics layer if we're not deliberate about it.

### 3.4 Crime

Mirror image of disease: rises with base population, falls with commerce and police stations.
Applied to final population at roughly **4× weight** relative to disease losses.

### 3.5 Age bonus

```js
ageMultiplier = 1 + Math.log(cityAgeInDays) / 15;
```

Logarithmic — negligible below ~200 days, then a meaningful reward for not deleting cities.
This is the game's retention mechanic expressed as a formula.

### 3.6 Assembled

```js
population = (basePop - diseaseLosses - crimeLosses * 4) * ageMultiplier;
```

---

## 4. Commerce and income

```js
minimumWage   = 725;
averageIncome = ((commerce / 50) * minimumWage) + minimumWage;
cityIncome    = averageIncome * population;      // daily, pre-tax
```

Commerce comes from commerce improvements (banks, malls, stadiums, subways). Note it's **linear** —
all the curvature is upstream in population. Multiplicative modifiers on gross income:

| Modifier | Effect |
|---|---|
| Open Markets domestic policy | ×1.01 |
| **Out of food** | **×0.67** |
| Color trade bloc bonus | flat per-turn addition |
| Treasures (nation or alliance) | percentage bonus |

The out-of-food penalty is how food becomes strategically load-bearing rather than a nuisance
resource — and it's why blockades matter.

**[ADAPT]** This is exactly where our Force/Magnetism axis attaches:

```js
tradeFriction     = (force / 100) * 0.20;   // reduces market/trade income
efficiencyPenalty = (force / 100) * 0.25;   // reduces factory output
grossIncome = cityIncome * (1 - tradeFriction) * policyModifiers;
```

Keep the two mirrored in `server.js` and `nation-creation.html` — already a known drift risk.

---

## 5. Resource economy

### 5.1 Resource graph

**Raw (7):** Coal, Oil, Iron, Bauxite, Lead, Uranium, Food
**Manufactured (4):** Steel, Aluminum, Gasoline, Munitions
**Special (2):** Money, Credits

```
Coal + Iron  → Steel        (Steel Mill)
Bauxite      → Aluminum     (Aluminum Refinery)
Oil          → Gasoline     (Oil Refinery)
Lead         → Munitions    (Munitions Factory)
Coal | Oil | Uranium        → Power (plants)
Land         → Food         (Farms)
```

Raw resource availability is **gated by continent**. Food is available everywhere (Antarctica takes
a 50% penalty). This is what forces inter-player trade — no nation can be self-sufficient.

### 5.2 Production rates

| Improvement | Output | Notes |
|---|---|---|
| Coal Mine / Oil Well | 3 tons/day (0.25/turn) | No power needed |
| Farm | `land/500` tons/turn (`land*3/125` per day) | `land/400` with Mass Irrigation |
| Oil Refinery | 3 tons in → 6 tons out per day | Requires power |
| Steel Mill | 3 + 3 tons in → 9 tons out per day | Requires power |

Manufacturing improvements: **$45,000 build, $4,000/day upkeep ($334/turn), +32 pollution, max 5/city.**

### 5.3 Stacking bonuses

- **Raw:** more mines of one type → up to **+50%** at the build limit
- **Manufacturing:** **+12.5%** for the 2nd/3rd/4th/5th matching improvement → **+50%** at 5

Both reward specialisation, which is the mechanism that creates distinct nation archetypes
(raw exporter → refiner → developed consumer) without any explicit class system. Elegant: an
emergent economic tier structure from one bonus curve.

**Build limits per city:** 10 mines, 20 farms, 5 uranium mines, 5 of each manufacturing type.

### 5.4 Power

Power plants burn **0.1 tons/turn per 100 infrastructure**. Each plant powers up to **500 infra**;
at 501 you need a second one. Cleanliness ladder: **Wind → Nuclear → Oil → Coal**.

Only manufacturing, civil, and commerce improvements need power. Raw extraction does not — which is
why the correct opening is always mines-first.

---

## 6. Pollution and radiation

- Most improvements generate pollution; manufacturing and farms are the worst offenders
- Each pollution point adds **+0.05%** to disease rate
- Recycling Centers and Subways reduce the pollution index
- **Green Technologies** project: −25% manufacturing pollution, −50% farm pollution, +25 subway
  effectiveness, −10% resource upkeep

**Radiation** (nuclear weapons): +5 Roentgen to the continent, +1 to the world per detonation.
Raises disease and cuts food production globally. Dissipates over **100 turns**.

Radiation is a genuinely clever bit of design — it makes nuclear war a **tragedy of the commons**.
The whole world pays for your nuke, which creates real diplomatic pressure against their use.
Worth stealing wholesale.

---

## 7. Score and matchmaking

```js
nationScore =
    (cityCount - 1) * 100
  + (totalInfra / 40)
  + (projectCount * 20)
  + militaryScore
  + 10;

militaryScore =
    soldiers * 0.0004
  + tanks    * 0.025
  + aircraft * 0.3
  + ships     * 1
  + missiles  * 5      // capped at 50 total
  + nukes     * 15;    // capped at 50 total
```

```js
warRangeMin = score * 0.75;   // 25% below
warRangeMax = score * 1.75;   // 75% above
```

The asymmetry (−25%/+75%) means you can always be attacked by someone meaningfully bigger, but never
by someone overwhelmingly bigger. It's the anti-griefing backbone.

**Second-order effect worth understanding:** score inflation is a *cost*. Ships add 1.0 score each,
which is why they're a trap — building them pushes you into the down-declare range of larger
nations. Players actively manage score downward. Any unit-score coefficient you pick is
simultaneously a balance lever and a matchmaking lever.

Espionage uses its own, separate range.

---

## 8. Military units

| Unit | Build cost | Peace upkeep/day | War upkeep/day | Per-battle consumption |
|---|---|---|---|---|
| Soldier | $ + food | $1.25 + 1 food/750 | $1.88 + 1 food/500 | munitions (optional, big damage boost) |
| Tank | $60 + 0.5 steel | $50 | $75 | 1 munitions + 1 gasoline per 100 |
| Aircraft | $4,000 + 5 aluminum | $500 | $750 | 0.25 gas + 0.25 munitions each |
| Ship | $ + steel | $3,750 | $5,625 | gas + munitions |

**Recruitment caps:** each Barracks holds 3,000 soldiers and trains 1,000/day. Similar per-building
caps exist for factories (tanks), hangars (aircraft), drydocks (ships).

> **The single best rule in the game:** unsupplied units contribute **zero** army value but **still
> take casualties.**

That one clause makes logistics mandatory without a separate logistics system. It punishes the exact
failure mode (mass units, ignore supply) with no extra UI, no extra tables, no extra explanation.
Copy this verbatim.

---

## 9. Combat resolution

### 9.1 Gating

- **MAP (Military Action Points)** accrue per turn; ground battle costs **3 MAP**, airstrike **4 MAP**
- **Resistance** starts at 100; drive it to 0 to win
- Offensive war slots: **5** (6 with Pirate Economy project). Defensive slots: **3**

### 9.2 Army value

```js
armyValue = unarmedSoldiers * 1
          + armedSoldiers   * 1.75
          + tanks           * 40;
```

A tank is worth 40 unarmed soldiers, ~23 armed ones. Defenders additionally get a civilian militia
term derived from population.

> ⚠️ **Sources disagree on the militia coefficient.** The Ground Battles wiki page states
> `population/400` (0.25%); the in-game FAQ states 0.025% (`population/4000`). Verify against the
> live game before implementing. Either way the *principle* — defenders get a population-scaled
> bonus — is the part to keep, since it makes big civilian populations defensively meaningful.

### 9.3 The 3-roll system

```js
function resolveBattle(attackerValue, defenderValue) {
  let rollsWon = 0;
  for (let i = 0; i < 3; i++) {
    const a = attackerValue * (0.4 + Math.random() * 0.6);  // 40–100%
    const d = defenderValue * (0.4 + Math.random() * 0.6);
    if (a > d) rollsWon++;
  }
  return rollsWon;  // 3=Immense Triumph, 2=Moderate Success, 1=Pyrrhic, 0=Utter Failure
}
```

| Rolls won | Result | Value | Effect |
|---|---|---|---|
| 3 | Immense Triumph | 3 | Full damage, gains control state, 10% chance to destroy an improvement |
| 2 | Moderate Success | 2 | Partial damage, nullifies enemy control state |
| 1 | Pyrrhic Victory | 1 | Minimal damage, nullifies enemy control state |
| 0 | Utter Failure | 0 | Nothing; **0 resistance removed** |

**The 40–100% band is the master tuning knob of the entire game.** Widen it and combat becomes
coin-flippy; narrow it and combat becomes pure arithmetic with no reason to ever fight an even
match. At 40–100%, roughly: >2.5× advantage is a near-guaranteed sweep, below that it's genuinely
uncertain. That uncertainty is what makes alliance warfare interesting rather than solved.

The tiers then feed damage as a simple `victoryType / 3` multiplier — one variable does
outcome *and* magnitude.

### 9.4 Control states

| Battle | On Immense Triumph | Effect |
|---|---|---|
| Ground | Ground Control | Subsequent ground battles destroy enemy aircraft, scaled by tanks sent |
| Air | Air Superiority | Enemy tank stats halved |
| Naval | Blockade | Target cannot transfer money or resources in/out |

Control states are the reason unit types aren't interchangeable — it's rock-paper-scissors expressed
as persistent debuffs rather than damage multipliers. Also note: *any* victory (even Pyrrhic)
nullifies the enemy's control state over you, but only an Immense Triumph grants you one. That
asymmetry gives losing players a cheap, achievable comeback goal.

**Fortify:** an action that makes attackers take 25% more casualties. Ends the moment you attack.

### 9.5 Damage formulas

Ground:
```js
infraDestroyed = Math.max(
  Math.min(
    ((attackSoldiers - defendSoldiers * 0.5) * 0.000606061
      + (attackTanks - defendTanks * 0.5) * 0.01)
    * rand(0.85, 1.05)
    * (victoryType / 3),
    cityInfra * 0.5 + 100        // per-battle cap
  ), 0);
```

Air:
```js
infraDestroyed = Math.max(
  Math.min(
    (attackAircraft - defendAircraft * 0.5) * 0.35353535
    * rand(0.85, 1.05)
    * (victoryType / 3),
    cityInfra * 0.5 + 100
  ), 0);
```

Non-"Target Infrastructure" airstrike types deal **1/3** of the calculated infra damage.

Note the shape shared by both: `(attacker − defender×0.5) × constant × jitter × tier`, clamped by a
per-city cap of `infra × 0.5 + 100`. **The cap is essential** — it guarantees no city dies in one
hit, which is what makes wars multi-day affairs instead of instant knockouts.

Damage always lands on the defender's **highest-infrastructure city**.

Loot:
```js
loot = Math.min(
  (attackSoldiers * rand(0.5, 1) + attackTanks * rand(7, 13)) * victoryType,
  defenderMoney * 0.75,
  defenderMoney - 1000000
);
```

The `defenderMoney - 1,000,000` floor means you can never be looted to zero. Small mercy that keeps
beaten players in the game.

### 9.6 War types (chosen at declaration)

| Type | Attacker infra damage | Attacker loot |
|---|---|---|
| Attrition | 100% | 25% |
| Ordinary | 50% | 50% |
| Raid | 25% | 100% |

Declaring your damage/profit tradeoff up front is a very cheap design lever with big strategic
consequences — raiders and warmongers become distinguishable player types with one enum field.

### 9.7 Victory and beige

Reduce resistance to 0 → defender goes **beige**. Fastest known route: 5 naval + 3 ground
Immense Triumphs.

Losing nation:
- Turns **beige for 2 days** (stacks per war lost) — immune to *new* declarations, existing wars continue
- Loses **10% of money and 10% of every resource** (credits are safe)
- Loses up to **4% of infra in every city**
- Their **alliance bank** is looted too

All modified by war type and war policy. The alliance-bank loot is what makes wars matter
politically rather than just individually — it means your alliance has a stake in your fights.

---

## 10. Espionage

```js
odds = (safetyLevel * 25) + (yourSpies * 100) / ((enemySpies * 3) + 1);
finalOdds = odds / operationModifier;
```

`safetyLevel`: 1 = Quick and Dirty, 2 = Normal Precautions, 3 = Extremely Covert.

| Operation | Modifier |
|---|---|
| Gather Intelligence | 1 |
| Assassinate Spies | 1.5 |
| Sabotage Tanks | 1.5 |
| Sabotage Aircraft | 2 |
| Sabotage Ships | 3 |
| Sabotage Missile | 4 |
| Sabotage Nuclear Weapon | 5 |

Clean opposed-check design: your strength over 3× theirs, plus a caution bonus, divided by target
value. Drops straight into our covert-ops layer with no modification.

---

## 11. Projects (national, one-time, permanent)

Projects are the tech tree. They cost money + resources, are permanent, and each adds **+20 score**.

**Production boosters (6):** Arms Stockpile (munitions), Bauxiteworks (aluminum), Emergency Gasoline
Reserve (gasoline), Ironworks (steel), Mass Irrigation (food), Uranium Enrichment Program (uranium)

**Cost reducers:** Center for Civil Engineering (−5% infra), Urban Planning / Advanced Urban Planning
/ Metropolitan Planning (−$50M / −$100M / −$150M city cost, stacking)

**Mitigation:** Green Technologies, Recycling Initiative, Clinical Research Center (disease),
Fallout Shelter (−10% nuke damage, −25% fallout duration, caps radiation effect on food)

**Military:** Iron Dome (missile defence), Intelligence Agency (spies), Military Salvage (5% steel and
aluminum refunded after victories), Missile Launch Pad, Nuclear Research Facility, Pirate Economy
(+1 offensive war slot)

**Prestige:** Moon Landing, Mars Landing, International Trade Center

Design note: projects are almost all **percentage modifiers on existing formulas**, not new systems.
That's why the game can have ~30 of them without the codebase exploding. Follow this rule strictly —
every project should be a coefficient, not a new table.

---

## 12. Policies

### Domestic (6, changeable, cooldown applies)
Manifest Destiny (−5% city cost), Urbanization (−5% infra cost), Technological Advancement,
Open Markets (+1% gross income), Imperialism, and one more.

### War (change once per 5 days)

| Policy | Effect |
|---|---|
| Attrition | +10% infra damage dealt, −20% loot received |
| Turtle | −10% infra damage taken, +20% loot lost |
| Blitzkrieg | +10% damage and casualties for 12 turns after switching |
| Moneybags | −40% loot stolen from you, +5% infra damage taken |
| Pirate | Raiding-focused (loot bonuses) |
| Fortress / Guardian / others | Defensive variants |

Every one of these is a **strict tradeoff, never a pure buff** — this is the discipline that keeps
the meta from collapsing onto one dominant policy. Moneybags specifically exists as a counter to
Pirate, which is a nice piece of intentional meta-design: a policy whose purpose is to make a
playstyle unprofitable to use against you.

**[ADAPT]** Our Force/Magnetism slider is a continuous version of this same idea. The lesson from
P&W is that our slider must be a **genuine tradeoff at every position** — if any point on the axis
strictly dominates, the mechanic is dead.

---

## 13. Color trade blocs

Nations and alliances pick a color. **Match your alliance's color → per-turn gross income bonus.**
Mismatch → you pay alliance taxes instead of getting the bonus.

Two special colors you cannot choose:

- **Beige** — invulnerable to *new* war declarations. 14 days on nation creation; 2 days per war
  lost (stacks). Flat per-turn bonus regardless of alliance. Once you leave, you can't return.
  (The bonus figure has been changed over the game's life — sources cite $50,000 and $85,000 per
  turn at different times. Pick your own number.)
- **Gray** — assigned after beige expires or after 5 days of inactivity. No bonus, exempt from taxes,
  excluded from total-score calculations. Makes inactive nations juicy raid targets on purpose.

Color bloc locked for **60 turns (5 days)** after changing, unless forced off by losing a war,
beige expiry, or inactivity.

This system is doing something subtle and clever: it's a **coordination bonus** that gives alliances
a purely economic reason to exist beyond mutual defence, and it makes the political map visible at a
glance. Low implementation cost, high metagame payoff.

---

## 14. Alliances

- **Bank** — shared treasury for money and every resource. Used for member grants, loans, and war
  funding. Looted by the winner when a member loses a war.
- **Taxes** — set per bracket, collected **every turn**, on both income and resource production.
  Requires 2 days of alliance seniority; gray and beige nations are exempt.
- **Treaties** — MDP, MDoAP, ODP, NAP, protectorate. Three or more signatories forms a bloc.
- **Treasures** — spawn on nations meeting color/score conditions; grant income bonuses; can be
  taken by conquest. Deliberate conflict generators.

The bank + tax system is what makes alliances *institutions* rather than chat groups — there are
real assets to steward, real defection risk, real internal politics. It's also the #1 abuse surface
(see below).

---

## 15. Market

Pure player-driven order book. Buy offers and sell offers per resource; matching is instant on
crossing. **No NPC price floor or ceiling** — which is why prices are genuinely volatile and why
"treat it like a stock market" is the standard advice.

Embargoes let nations and alliances block trade with specific targets — economic warfare without
combat.

**[ADAPT]** Our `/api/market/*` order book already matches this shape. Two things to carry over:
per-resource order books (not a single unified book), and instant matching on cross rather than
periodic clearing. Instant matching is what makes the market feel alive on a 2-hour tick.

---

## 16. Anti-abuse — learn from their scar tissue

P&W has been exploited repeatedly. Their countermeasures, all worth copying:

- **Network/IP fingerprinting.** Multi-accounting is detected via unique codes generated from IP.
  Multiple nations per IP allowed, but they cannot war the same targets, trade with each other,
  make sweetheart trades, or route funds through an intermediary.
- **Alliance bank protection abuse is explicitly banned** — parking a bank in a new nation's 14-day
  beige immunity. Penalty: bank returned with 20% deleted.
- **Trade restrictions between linked accounts**, enforced at the transaction layer.
- **Mandatory exploit reporting** in the game rules.
- **Credit purchase caps** (20/month) to bound pay-to-win.

**[ADAPT]** Our `withTransaction()` + `SELECT ... FOR UPDATE` row-lock discipline addresses the
*mechanical* duping vector (TOCTOU on money/resource mutation). It does **not** address the *social*
vector — multi-accounting and wash trading. That needs:
- an account-linkage table (IP/device fingerprint hash)
- a trade-price sanity check (flag transactions >N% off the rolling market median)
- an audit log on every alliance bank withdrawal

Worth building before we have players, not after.

---

## 17. Implementation order for our build

Mapped against our current rebuild priority (`index.html → industries + cities → military →
global-trade → governance → supply-chain`):

| Phase | Formulas to land | Our page |
|---|---|---|
| 1 | Infra/land/city cost curves, improvement slots | `cities.html` |
| 2 | Base pop, disease (squared density), crime, age bonus | `index.html` + L3 tick |
| 3 | Commerce → income → tax, food penalty | `index.html`, `governance.html` |
| 4 | Production rates, stacking bonuses, power consumption | `industries.html` |
| 5 | Score + war range | `military.html` |
| 6 | Army value, 3-roll resolution, MAP, resistance, control states | `military.html` |
| 7 | Damage + loot formulas, victory/beige | `military.html` |
| 8 | Order book | `global-trade.html` |
| 9 | Espionage odds | covert ops |
| 10 | Projects as coefficients, policies as tradeoffs | `governance.html` |

**Start with phase 2.** The population model is the load-bearing wall — every other number in the
game is downstream of it. Getting the squared density term and the base-pop feedback break right on
day one saves a rewrite later.

---

## 18. What NOT to copy

Honest assessment — these are P&W's known weak points, and we have the chance to not inherit them:

- **Diplomacy happens entirely on Discord.** The game has no in-game alliance forum, negotiation
  tools, or treaty UI worth using. This is the most-cited player complaint and the biggest open
  design opportunity in the genre.
- **Thin roleplay layer.** Players consistently ask for more RP/worldbuilding tools than exist.
- **Ships are a near-dead unit class** — score-inflating, expensive, air-vulnerable, narrow use.
  A cautionary tale about unit-score coefficients doubling as matchmaking weights.
- **The 2-hour tick punishes casual players** who can't align to turn changes; the double-buy
  tactic makes this worse.
- **Beige-stacking** can make persistent attackers unable to finish a target.
- **Formula opacity.** Almost none of this is in-game; it all lives on wikis. Surfacing the actual
  numbers in-game would be a real differentiator.

---

## 19. Source verification checklist

Formulas here are drawn from the P&W wikis, in-game pwpedia, and player documentation, current as of
this document's writing. Before shipping, re-verify against the live game:

- [ ] Defender militia coefficient (`pop/400` vs `pop/4000` — sources conflict)
- [ ] Beige per-turn bonus (has changed over time; $50k and $85k both documented)
- [ ] Exact list and effects of all 6 domestic policies
- [ ] Current soldier build cost and munitions damage multiplier
- [ ] Current project cost tables (rebalanced periodically)
- [ ] Whether the 2.2 infra exponent and 710 divisor are still current

P&W exposes a **public GraphQL API** — the fastest way to verify any of these is to query live
nation data and fit against it, rather than trusting wiki text.
