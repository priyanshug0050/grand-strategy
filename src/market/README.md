# Market module

A self-contained exchange. The rest of the game does not know it exists.

## Files

    engine.js    Matching, price history, wash-trade detection. Pure functions.
    service.js   Transactional actions: place order, cancel, read the book.
    routes.js    The four HTTP endpoints. The only connection to the game.

## Plugging it in

`server.js` mounts it with two lines:

```js
const marketRoutes = require('./src/market/routes');
app.use(marketRoutes.mount({ protect, touchActivity, wrap }));
```

Comment them out and the market disappears. Every other page keeps working —
there is a test that proves this.

## The two rules that keep it separable

**1. Nothing in the game imports from `src/market/`.**
Not `cities.js`, not `combat.js`, not `tick.js`. Check with:

    grep -rn "market" src/engine/ src/api/ src/data/

That must come back empty.

**2. The market imports data access and constants, nothing else.**
It reads `src/data/db` and `src/data/repository` (shared tables) and
`src/engine/constants` (which resources are tradeable). It does not import
population, combat, or city logic — and must not start.

## Why it shares the game's database

A fill has to move goods AND money atomically:

    BEGIN
      seller's coal   -> buyer
      buyer's money   -> seller
    COMMIT

Split that across two databases and a network blip leaves someone paid but not
delivered. Fixing that properly needs distributed-transaction machinery far
heavier than this game warrants.

So: separate code, shared database, one transaction per fill. If the market
ever needs its own process, `routes.js` is the seam — it takes its middleware
as an argument rather than importing it, so it can be mounted anywhere.

## Tables it owns

    market_orders    resting orders, with escrow
    trades           execution history (drives the chart)
    embargoes        who may not trade with whom

It also WRITES to `nations.money` and `nation_resources.amount` — the game's
tables. That is the deliberate exception described above.
