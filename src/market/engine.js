/**
 * ============================================================================
 *  market.js — order book matching
 * ============================================================================
 *  Pure functions. No database, no side effects. The service layer applies the
 *  fills this module describes, inside a transaction.
 *
 *  ---------------------------------------------------------------------------
 *  PRICE-TIME PRIORITY
 *  ---------------------------------------------------------------------------
 *  Orders match best-price-first, then oldest-first at equal price. That
 *  ordering is not cosmetic: without a deterministic tie-break, two players
 *  posting the same price get filled in whatever order the database happened
 *  to return, which players correctly read as the game cheating them.
 *
 *  ---------------------------------------------------------------------------
 *  THE MAKER'S PRICE WINS
 *  ---------------------------------------------------------------------------
 *  When a buy at $120 crosses a sell at $100, the trade executes at $100 — the
 *  price of the order that was resting on the book. The taker gets the better
 *  deal, never worse than they asked for.
 *
 *  This matters because the alternative (taker's price) lets someone post an
 *  absurd bid to move the public price without paying for it. Anchoring to the
 *  resting order means the price history reflects what people actually agreed
 *  to trade at.
 *
 *  ---------------------------------------------------------------------------
 *  NO NPC FLOOR OR CEILING
 *  ---------------------------------------------------------------------------
 *  P&W's market is pure player supply and demand, and that absence is exactly
 *  why prices stay volatile and the economy feels alive. Resist adding a
 *  stabiliser — a market that cannot crash is a market nobody has to think
 *  about.
 * ============================================================================
 */

'use strict';

const C = require('../engine/constants');

function assertNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got: ${value}`);
  }
  if (value < 0) throw new RangeError(`${name} must be >= 0, got: ${value}`);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Resource quantities carry 4 decimals — production rates are fractional. */
function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Can this order be placed at all?
 *
 * Note what is checked here and what is NOT: this validates the ORDER's shape
 * and the placer's ability to cover it. Whether the two nations are allowed to
 * trade with each other (embargoes, linked accounts) is a relationship
 * question and belongs in the service layer, where the database lives.
 */
function validateOrder({ resource, side, price, quantity }, nation) {
  if (!C.MARKET.TRADEABLE.includes(resource)) {
    return { ok: false, reason: `${resource} cannot be traded` };
  }
  if (side !== 'buy' && side !== 'sell') {
    return { ok: false, reason: 'Side must be buy or sell' };
  }
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, reason: 'Price must be above zero' };
  }
  if (price < C.MARKET.MIN_PRICE || price > C.MARKET.MAX_PRICE) {
    return { ok: false, reason: `Price must be between ${C.MARKET.MIN_PRICE} and ${C.MARKET.MAX_PRICE}` };
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, reason: 'Quantity must be above zero' };
  }

  // A buy order must be funded up front, and a sell order must be backed by
  // real goods. Otherwise the book fills with orders that cannot settle, and
  // whoever crosses them eats the failure.
  if (side === 'buy') {
    const cost = price * quantity;
    if ((nation.money || 0) < cost) {
      return {
        ok: false,
        reason: `Needs ${round2(cost)} to cover this bid, you have ${round2(nation.money || 0)}`,
        required: round2(cost),
      };
    }
  } else {
    const have = (nation.stockpile && nation.stockpile[resource]) || 0;
    if (have < quantity) {
      return {
        ok: false,
        reason: `You have ${round4(have)} ${resource}, tried to sell ${quantity}`,
        available: round4(have),
      };
    }
  }

  return { ok: true };
}

// ============================================================================
// MATCHING
// ============================================================================

/**
 * Match an incoming order against the resting book.
 *
 * @param {Object} incoming  { resource, side, price, quantity, nationId }
 * @param {Array}  book      resting opposite-side orders, ALREADY SORTED by
 *                           price-time priority (best price first, then oldest)
 * @returns {{fills: Array, filled: number, remaining: number, spent: number, received: number}}
 *
 * Returns a DESCRIPTION of what should happen. Nothing is mutated — the
 * service layer applies it in one transaction so a partial fill can never be
 * half-committed.
 */
function matchOrder(incoming, book) {
  assertNonNegative(incoming.quantity, 'quantity');
  assertNonNegative(incoming.price, 'price');

  const fills = [];
  let remaining = incoming.quantity;
  let spent = 0;      // money the buyer pays
  let received = 0;   // money the seller receives

  for (const resting of book) {
    if (remaining <= 0) break;

    // A nation crossing its own order would be a free way to fake volume and
    // move the public price at zero cost. Skip, don't error — the rest of the
    // book is still perfectly valid to trade against.
    if (Number(resting.nation_id ?? resting.nationId) === Number(incoming.nationId)) continue;

    const restingPrice = Number(resting.price);

    // Do the prices actually cross?
    const crosses = incoming.side === 'buy'
      ? incoming.price >= restingPrice
      : incoming.price <= restingPrice;
    if (!crosses) break;   // book is sorted, so nothing further can cross either

    const restingRemaining = Number(resting.quantity) - Number(resting.filled || 0);
    if (restingRemaining <= 0) continue;

    const qty = Math.min(remaining, restingRemaining);
    // The resting order's price wins — see the header comment.
    const value = round2(qty * restingPrice);

    fills.push({
      orderId: resting.id,
      counterpartyId: Number(resting.nation_id ?? resting.nationId),
      price: restingPrice,
      quantity: round4(qty),
      value,
      // Who is who, from the incoming order's point of view.
      buyerId: incoming.side === 'buy' ? incoming.nationId : Number(resting.nation_id ?? resting.nationId),
      sellerId: incoming.side === 'buy' ? Number(resting.nation_id ?? resting.nationId) : incoming.nationId,
      fullyFills: qty >= restingRemaining,
    });

    remaining = round4(remaining - qty);
    if (incoming.side === 'buy') spent = round2(spent + value);
    else received = round2(received + value);
  }

  return {
    fills,
    filled: round4(incoming.quantity - remaining),
    remaining,
    spent,
    received,
    fullyFilled: remaining <= 0,
  };
}

/**
 * Sort a raw book into price-time priority for the given side.
 *
 * For BUY orders resting on the book, best = highest price (a seller wants the
 * most money). For SELL orders, best = lowest price. Ties break by age.
 *
 * The database index already returns rows in this order, but sorting here too
 * means matchOrder() is safe to call with any array — including in tests.
 */
function sortBook(orders, restingSide) {
  const dir = restingSide === 'buy' ? -1 : 1;   // buy: high→low, sell: low→high
  return [...orders].sort((a, b) => {
    const pa = Number(a.price), pb = Number(b.price);
    if (pa !== pb) return (pa - pb) * dir;
    return new Date(a.created_at || 0) - new Date(b.created_at || 0);
  });
}

// ============================================================================
// BOOK SUMMARY
// ============================================================================

/**
 * Aggregate a book into price levels for display.
 *
 * Players need to see depth — how much is available near the top — not a list
 * of individual orders. Two sells of 50 at $100 should read as one level of
 * 100, the way a real exchange shows it.
 */
function aggregateBook(orders, side, levels = 10) {
  const byPrice = new Map();

  for (const o of orders) {
    const price = Number(o.price);
    const remaining = Number(o.quantity) - Number(o.filled || 0);
    if (remaining <= 0) continue;
    byPrice.set(price, round4((byPrice.get(price) || 0) + remaining));
  }

  const dir = side === 'buy' ? -1 : 1;
  return [...byPrice.entries()]
    .sort((a, b) => (a[0] - b[0]) * dir)
    .slice(0, levels)
    .map(([price, quantity]) => ({ price, quantity, value: round2(price * quantity) }));
}

/**
 * Best bid, best ask, and the spread between them.
 * A wide spread means an illiquid market — worth surfacing, because it tells a
 * player their order probably will not fill quickly.
 */
function topOfBook(buyOrders, sellOrders) {
  const bids = aggregateBook(buyOrders, 'buy', 1);
  const asks = aggregateBook(sellOrders, 'sell', 1);

  const bid = bids[0]?.price ?? null;
  const ask = asks[0]?.price ?? null;

  return {
    bid, ask,
    spread: (bid !== null && ask !== null) ? round2(ask - bid) : null,
    spreadPercent: (bid !== null && ask !== null && bid > 0)
      ? round2(((ask - bid) / bid) * 100) : null,
    // If these cross, an order was left unmatched — a matching bug, not a
    // market condition. Worth flagging loudly rather than rendering quietly.
    crossed: (bid !== null && ask !== null) ? bid >= ask : false,
  };
}

// ============================================================================
// WASH-TRADE DETECTION
// ============================================================================

/**
 * Is this trade priced far enough from the recent median to be suspicious?
 *
 * Row-level locking defends against MECHANICAL duping — two requests racing on
 * one balance. It does nothing against the SOCIAL exploit: two accounts owned
 * by one person trading at $1 or $100,000 to move value between them.
 *
 * This never blocks a trade. Players legitimately overpay when they are
 * desperate, and a false block on a real trade is worse than a flag on a fake
 * one. It marks the row so an admin can look.
 */
function isSuspiciousPrice(price, recentPrices) {
  if (!recentPrices || recentPrices.length < 5) return false;   // no baseline yet

  const sorted = [...recentPrices].map(Number).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!median || median <= 0) return false;

  const deviation = Math.abs(price - median) / median;
  return deviation > C.ANTI_ABUSE.SWEETHEART_TRADE_DEVIATION_THRESHOLD;
}

/** Median of recent trade prices — the reference the UI shows. */
function medianPrice(prices) {
  if (!prices || prices.length === 0) return null;
  const sorted = [...prices].map(Number).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round2((sorted[mid - 1] + sorted[mid]) / 2)
    : round2(sorted[mid]);
}

/**
 * Turn a raw trade list into evenly-spaced price points for a chart.
 *
 * Trades arrive irregularly — twenty in one minute, none for an hour. Plotting
 * them raw makes a chart that lies about time: a flat busy period looks
 * identical to a quiet one. Bucketing by turn fixes that, and gives one point
 * per turn regardless of how many trades landed in it.
 *
 * Each bucket carries open/high/low/close and volume, so the same data can
 * drive a line chart now and a candlestick later without an API change.
 *
 * @param {Array} trades  newest-first, each { price, quantity, turn }
 * @param {number} buckets  how many turns to cover
 */
function priceHistory(trades, buckets = 24) {
  if (!trades || trades.length === 0) return [];

  // Oldest first, so open/close mean what they say.
  const ordered = [...trades].reverse();

  const byTurn = new Map();
  for (const t of ordered) {
    const turn = Number(t.turn);
    const price = Number(t.price);
    const qty = Number(t.quantity) || 0;

    const b = byTurn.get(turn);
    if (!b) {
      byTurn.set(turn, { turn, open: price, high: price, low: price, close: price, volume: qty, trades: 1 });
    } else {
      b.high = Math.max(b.high, price);
      b.low = Math.min(b.low, price);
      b.close = price;
      b.volume = round4(b.volume + qty);
      b.trades += 1;
    }
  }

  const points = [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  return points.slice(-buckets);
}

/**
 * How has the price moved since the start of the window?
 *
 * Compares the median of the OLDEST third against the median of the NEWEST
 * third, rather than first-trade vs last-trade. Two single trades are far too
 * easy to cherry-pick — one lucky fill at a silly price would show a fake
 * +400% move on the ticker.
 */
function priceChange(trades) {
  if (!trades || trades.length < 2) {
    return { current: trades?.length ? Number(trades[0].price) : null, change: null, changePercent: null, direction: 'flat' };
  }

  const ordered = [...trades].reverse();          // oldest first
  const third = Math.max(1, Math.floor(ordered.length / 3));

  // medianPrice takes PRICES, not trade objects. Passing objects returns NaN
  // silently, which showed as changePercent: null and a wrong direction — the
  // price had risen 47% and the ticker said "down".
  const oldMedian = medianPrice(ordered.slice(0, third).map(t => Number(t.price)));
  const newMedian = medianPrice(ordered.slice(-third).map(t => Number(t.price)));
  const current = Number(ordered[ordered.length - 1].price);

  if (oldMedian === null || newMedian === null || oldMedian <= 0) {
    return { current, change: null, changePercent: null, direction: 'flat' };
  }

  const change = round2(newMedian - oldMedian);
  const changePercent = round2((change / oldMedian) * 100);

  return {
    current,
    change,
    changePercent,
    // A sub-1% wobble is noise, not a trend. Calling it "up" would make the
    // ticker flicker constantly and mean nothing.
    direction: Math.abs(changePercent) < 1 ? 'flat' : changePercent > 0 ? 'up' : 'down',
  };
}

/** High, low, and total volume across a trade window. */
function priceStats(trades) {
  if (!trades || trades.length === 0) {
    return { high: null, low: null, volume: 0, tradeCount: 0, averagePrice: null };
  }
  const prices = trades.map(t => Number(t.price));
  const volume = trades.reduce((sum, t) => sum + (Number(t.quantity) || 0), 0);
  const value = trades.reduce((sum, t) => sum + Number(t.price) * (Number(t.quantity) || 0), 0);

  return {
    high: Math.max(...prices),
    low: Math.min(...prices),
    volume: round4(volume),
    tradeCount: trades.length,
    // Volume-weighted, not a plain mean: a 1000-unit trade should count for
    // more than a 1-unit one when describing "what it actually costs".
    averagePrice: volume > 0 ? round2(value / volume) : null,
  };
}

module.exports = {
  priceHistory,
  priceChange,
  priceStats,
  validateOrder,
  matchOrder,
  sortBook,
  aggregateBook,
  topOfBook,
  isSuspiciousPrice,
  medianPrice,
  _round2: round2,
  _round4: round4,
};
