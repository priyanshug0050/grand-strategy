/**
 * ============================================================================
 *  src/market/service.js — transactional market actions
 * ============================================================================
 *
 *  Everything the exchange does lives in this folder. Nothing in the rest of
 *  the game imports from here — the market is an ADD-ON, and the game runs
 *  perfectly well with it unplugged (comment out the two lines in server.js
 *  that mount ./src/market/routes and it disappears).
 *
 *  What it DOES depend on is the game's own money and resource tables. That is
 *  deliberate and non-negotiable: a trade must move goods and money in ONE
 *  transaction, or a network blip leaves someone paid but not delivered. Two
 *  separate databases could not give that guarantee without distributed-
 *  transaction machinery far heavier than this game needs.
 *
 *  So: separate CODE, shared DATABASE, one transaction per fill.
 * ============================================================================
 */

'use strict';

const db = require('../data/db');
const repo = require('../data/repository');
const market = require('./engine');
const C = require('../engine/constants');

/** Thrown for player-facing rule violations — becomes a 400, not a 500. */
class GameError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GameError';
    this.isPlayerError = true;
    this.details = details;
  }
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
function round4(n) { return Math.round((n + Number.EPSILON) * 10000) / 10000; }

/**
 * Place an order and match it against the book.
 *
 * THE LOCKING PROBLEM
 * --------------------------------------------------------------------------
 * A trade moves value between two nations, so both rows must be locked. But
 * which nations are involved is only known AFTER matching — and matching needs
 * the book, which needs a query.
 *
 * Doing it naively (read book, then lock) is a TOCTOU race: another order can
 * consume the same resting quantity between the two steps, and both fills
 * succeed against goods that only exist once.
 *
 * The fix is to lock the ORDER ROWS as we read them (`FOR UPDATE`), not just
 * the nations. A resting order can then only be consumed by one transaction at
 * a time, and the second waits and re-reads the true remaining quantity.
 */
async function placeOrder(nationId, { resource, side, price, quantity }) {
  return db.withTransaction(async (tx) => {
    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { lock: true, currentTurn: gs.turn });
    if (!nation) throw new GameError('Nation not found');

    const check = market.validateOrder({ resource, side, price, quantity }, nation);
    if (!check.ok) throw new GameError(check.reason, check);

    // A blockade is the naval win condition: it stops the target moving money
    // or resources in or out. Enforced here, not in the engine, because it is
    // a relationship between two nations rather than a rule about one.
    const { rows: blockade } = await tx.query(
      `SELECT 1 FROM wars
        WHERE ended_turn IS NULL
          AND ((defender_id = $1 AND attacker_control_state = 'blockade')
            OR (attacker_id = $1 AND defender_control_state = 'blockade'))
        LIMIT 1`,
      [nationId]
    );
    if (blockade.length > 0) {
      throw new GameError('You are under naval blockade — no resources or money can move in or out.');
    }

    const oppositeSide = side === 'buy' ? 'sell' : 'buy';
    const priceOrder = side === 'buy' ? 'ASC' : 'DESC';   // best price for the taker

    // FOR UPDATE is the load-bearing part. Without it two buyers can both read
    // the same resting sell order as available and both fill against it.
    const { rows: bookRows } = await tx.query(
      `SELECT * FROM market_orders
        WHERE resource = $1 AND side = $2 AND is_open = TRUE
          AND nation_id <> $3
        ORDER BY price ${priceOrder}, created_at ASC
        LIMIT 50
        FOR UPDATE`,
      [resource, oppositeSide, nationId]
    );

    const book = market.sortBook(bookRows, oppositeSide);
    const result = market.matchOrder({ resource, side, price, quantity, nationId }, book);

    // Recent prices for the wash-trade check — read once, used for every fill.
    const { rows: recent } = await tx.query(
      `SELECT price FROM trades WHERE resource = $1 ORDER BY executed_at DESC LIMIT 20`,
      [resource]
    );
    const recentPrices = recent.map(r => db.num(r.price));

    // ---- Apply the fills ----
    const counterparties = [...new Set(result.fills.map(f => f.counterpartyId))];
    if (counterparties.length > 0) {
      // Sorted lock order, so two trades between the same pair queue instead
      // of deadlocking.
      await db.lockNations(tx, [nationId, ...counterparties]);
    }

    const executed = [];
    for (const fill of result.fills) {
      const flagged = market.isSuspiciousPrice(fill.price, recentPrices);

      // Move goods and money.
      if (side === 'buy') {
        nation.money -= fill.value;
        nation.stockpile[resource] = (nation.stockpile[resource] || 0) + fill.quantity;
        await tx.query(
          `UPDATE nations SET money = money + $2 WHERE id = $1`,
          [fill.counterpartyId, fill.value]
        );
        // The seller's goods were already escrowed when they posted the order.
      } else {
        nation.money += fill.value;
        nation.stockpile[resource] -= fill.quantity;
        await tx.query(
          `INSERT INTO nation_resources (nation_id, resource, amount) VALUES ($1,$2,$3)
           ON CONFLICT (nation_id, resource) DO UPDATE SET amount = nation_resources.amount + $3`,
          [fill.counterpartyId, resource, fill.quantity]
        );
        // The buyer's money was already escrowed when they posted the order.
      }

      await tx.query(
        `UPDATE market_orders SET filled = filled + $2,
                is_open = (filled + $2) < quantity
          WHERE id = $1`,
        [fill.orderId, fill.quantity]
      );

      const { rows: tradeRow } = await tx.query(
        `INSERT INTO trades (resource, buyer_id, seller_id, price, quantity, flagged, turn)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [resource, fill.buyerId, fill.sellerId, fill.price, fill.quantity, flagged, gs.turn]
      );

      executed.push({ ...fill, flagged, tradeId: Number(tradeRow[0].id) });

      await repo.recordEvents(tx, fill.counterpartyId, [{
        turn: gs.turn, type: 'trade_filled',
        message: `Your ${oppositeSide} order filled: ${round2(fill.quantity)} ${resource} at ${round2(fill.price)}.`,
        resource, quantity: fill.quantity, price: fill.price,
      }]);
    }

    // ---- Rest the remainder on the book ----
    let restingOrderId = null;
    if (result.remaining > 0) {
      // Escrow up front. A resting order the placer can no longer honour is
      // worse than no order at all — whoever crosses it eats the failure.
      if (side === 'buy') {
        const escrow = round2(result.remaining * price);
        if (nation.money < escrow) throw new GameError('Not enough money left to rest the remainder');
        nation.money -= escrow;
      } else {
        if ((nation.stockpile[resource] || 0) < result.remaining) {
          throw new GameError(`Not enough ${resource} left to rest the remainder`);
        }
        nation.stockpile[resource] -= result.remaining;
      }

      const { rows } = await tx.query(
        `INSERT INTO market_orders (nation_id, resource, side, price, quantity)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [nationId, resource, side, price, result.remaining]
      );
      restingOrderId = Number(rows[0].id);
    }

    await repo.saveNation(tx, nation);

    return {
      filled: result.filled,
      remaining: result.remaining,
      spent: result.spent,
      received: result.received,
      fills: executed,
      restingOrderId,
      averagePrice: result.filled > 0
        ? round2((result.spent || result.received) / result.filled) : null,
    };
  });
}

/**
 * Cancel a resting order and return the escrowed money or goods.
 */
async function cancelOrder(nationId, orderId) {
  return db.withTransaction(async (tx) => {
    const { rows } = await tx.query(
      `SELECT * FROM market_orders WHERE id = $1 AND is_open = TRUE FOR UPDATE`,
      [orderId]
    );
    if (rows.length === 0) throw new GameError('Order not found or already closed');
    const order = rows[0];

    if (Number(order.nation_id) !== Number(nationId)) {
      throw new GameError('That is not your order');
    }

    const gs = await repo.loadGameState(tx);
    const nation = await repo.loadNation(tx, nationId, { lock: true, currentTurn: gs.turn });

    // Refund only what is still resting — the filled part is already settled.
    const unfilled = db.num(order.quantity) - db.num(order.filled);
    if (order.side === 'buy') {
      nation.money += round2(unfilled * db.num(order.price));
    } else {
      nation.stockpile[order.resource] = (nation.stockpile[order.resource] || 0) + unfilled;
    }

    await tx.query('UPDATE market_orders SET is_open = FALSE WHERE id = $1', [orderId]);
    await repo.saveNation(tx, nation);

    return {
      cancelled: orderId,
      refunded: order.side === 'buy'
        ? { money: round2(unfilled * db.num(order.price)) }
        : { [order.resource]: round4(unfilled) },
    };
  });
}

/** The public order book for one resource, plus recent trades. */
async function getMarket(resource, nationId) {
  if (!C.MARKET.TRADEABLE.includes(resource)) {
    throw new GameError(`${resource} cannot be traded`);
  }

  // The nation name is joined in because the book is public and NAMED. Who is
  // bidding is part of the market's information, the same way the price is —
  // see the note on the return value below.
  const BOOK_SELECT = `SELECT o.*, n.name AS nation_name
                         FROM market_orders o
                         JOIN nations n ON n.id = o.nation_id`;

  const [buys, sells, trades, mine] = await Promise.all([
    db.query(`${BOOK_SELECT} WHERE o.resource=$1 AND o.side='buy' AND o.is_open=TRUE
              ORDER BY o.price DESC, o.created_at ASC LIMIT 100`, [resource]),
    db.query(`${BOOK_SELECT} WHERE o.resource=$1 AND o.side='sell' AND o.is_open=TRUE
              ORDER BY o.price ASC, o.created_at ASC LIMIT 100`, [resource]),
    // 200 rows so the chart has real history, not just the last few fills.
    db.query(`SELECT price, quantity, executed_at, turn, flagged FROM trades
              WHERE resource=$1 ORDER BY executed_at DESC LIMIT 200`, [resource]),
    nationId
      ? db.query(`SELECT * FROM market_orders WHERE nation_id=$1 AND is_open=TRUE
                  ORDER BY created_at DESC`, [nationId])
      : Promise.resolve({ rows: [] }),
  ]);

  const prices = trades.rows.map(t => db.num(t.price));

  // NOTE the absence of buyer_id and seller_id. The book names who is OFFERING;
  // a completed trade stays anonymous. Naming both sides of every fill would
  // turn the trade log into a permanent public record of who supplies whom,
  // which is a relationship players should have to discover, not read off a
  // table. The query above does not select them, so they cannot leak by
  // accident later.
  const tradeList = trades.rows.map(t => ({
    price: db.num(t.price),
    quantity: db.num(t.quantity),
    turn: Number(t.turn),
    at: t.executed_at,
    flagged: t.flagged,
  }));

  // Two views of the same orders, both returned every time so the page can
  // toggle without a second request.
  //
  // THE BOOK IS NAMED, AND THAT IS A GAME DECISION, NOT AN OVERSIGHT.
  // A market where you can see who is buying 10,000 munitions is a market that
  // leaks war preparation, which is deliberate: it makes trade a place where
  // players watch each other. It does NOT make espionage redundant — the book
  // shows FLOWS (what someone is moving right now), espionage shows STOCKS
  // (what they actually have). It also means alt-farming happens in public,
  // where other players can see the same pair trading with itself all day.
  const stamp = (o) => ({ ...o, isMine: nationId ? o.nationId === Number(nationId) : false });

  return {
    resource,
    bids: market.aggregateBook(buys.rows, 'buy', 12),
    asks: market.aggregateBook(sells.rows, 'sell', 12),
    bidOrders: market.orderList(buys.rows, 'buy', 25).map(stamp),
    askOrders: market.orderList(sells.rows, 'sell', 25).map(stamp),
    ...market.topOfBook(buys.rows, sells.rows),
    medianPrice: market.medianPrice(prices),

    // Chart + ticker data. Computed server-side from the same trade rows the
    // table shows, so the graph can never disagree with the numbers under it.
    history: market.priceHistory(tradeList, 30),
    ...market.priceChange(tradeList),
    stats: market.priceStats(tradeList),

    recentTrades: tradeList.slice(0, 15),
    myOrders: mine.rows.map(o => ({
      id: Number(o.id),
      resource: o.resource,
      side: o.side,
      price: db.num(o.price),
      quantity: db.num(o.quantity),
      filled: db.num(o.filled),
      remaining: round4(db.num(o.quantity) - db.num(o.filled)),
    })),
  };
}

/** One-line summary per resource, for the market overview. */
async function getMarketOverview() {
  const out = [];
  for (const resource of C.MARKET.TRADEABLE) {
    const [buys, sells, trades] = await Promise.all([
      db.query(`SELECT price, quantity, filled FROM market_orders
                WHERE resource=$1 AND side='buy' AND is_open=TRUE ORDER BY price DESC LIMIT 20`, [resource]),
      db.query(`SELECT price, quantity, filled FROM market_orders
                WHERE resource=$1 AND side='sell' AND is_open=TRUE ORDER BY price ASC LIMIT 20`, [resource]),
      db.query(`SELECT price, quantity, turn FROM trades
                WHERE resource=$1 ORDER BY executed_at DESC LIMIT 60`, [resource]),
    ]);

    const tradeList = trades.rows.map(t => ({
      price: db.num(t.price), quantity: db.num(t.quantity), turn: Number(t.turn),
    }));

    const top = market.topOfBook(buys.rows, sells.rows);
    out.push({
      resource,
      ...top,
      medianPrice: market.medianPrice(tradeList.map(t => t.price)),
      tradeCount: tradeList.length,
      // Ticker needs direction; the sparkline needs the shape.
      ...market.priceChange(tradeList),
      spark: market.priceHistory(tradeList, 20).map(p => p.close),
      stats: market.priceStats(tradeList),
    });
  }
  return { resources: out };
}
module.exports = {
  GameError,
  placeOrder,
  cancelOrder,
  getMarket,
  getMarketOverview,
};
