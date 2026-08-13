/**
 * ============================================================================
 *  src/market/routes.js — the market's only connection to the game
 * ============================================================================
 *
 *  THIS IS THE PLUG.
 *
 *  server.js mounts the market with two lines:
 *
 *      const marketRoutes = require('./src/market/routes');
 *      app.use(marketRoutes.mount({ protect, touchActivity, wrap }));
 *
 *  Comment those out and the market is gone — no other file in the game
 *  references anything in src/market/. The rest of the game does not know the
 *  exchange exists.
 *
 *  The auth middleware is INJECTED rather than imported. That keeps the
 *  dependency arrow pointing one way: server.js knows about the market, the
 *  market does not know about server.js. It also means these routes can be
 *  mounted in a test harness with fake middleware, or in a separate process
 *  later, without editing this file.
 * ============================================================================
 */

'use strict';

const express = require('express');
const service = require('./service');

/**
 * @param {Object} middleware
 *   protect       — array/handler that authenticates and sets req.nationId
 *   touchActivity — marks the player active (keeps them out of inactive gray)
 *   wrap          — turns a rejected promise into a 500 instead of a hang
 */
function mount({ protect, touchActivity, wrap }) {
  const router = express.Router();

  // Identity always comes from the token via `protect`, never from the body.
  // A route that accepted nationId as "who is trading" would let any player
  // spend anyone's money.

  router.get('/api/market', protect, wrap(async (req, res) => {
    res.json(await service.getMarketOverview());
  }));

  router.get('/api/market/:resource', protect, wrap(async (req, res) => {
    res.json(await service.getMarket(req.params.resource, req.nationId));
  }));

  router.post('/api/market/order', protect, touchActivity, wrap(async (req, res) => {
    const { resource, side, price, quantity } = req.body || {};
    if (!resource || !side) {
      return res.status(400).json({ error: 'resource and side required' });
    }

    const p = Number(price);
    const q = Number(quantity);
    if (!Number.isFinite(p) || p <= 0) {
      return res.status(400).json({ error: 'price must be a positive number' });
    }
    if (!Number.isFinite(q) || q <= 0) {
      return res.status(400).json({ error: 'quantity must be a positive number' });
    }

    res.json(await service.placeOrder(req.nationId, { resource, side, price: p, quantity: q }));
  }));

  router.delete('/api/market/order/:orderId', protect, wrap(async (req, res) => {
    const id = Number(req.params.orderId);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid order id' });
    }
    res.json(await service.cancelOrder(req.nationId, id));
  }));

  return router;
}

module.exports = { mount, service };
