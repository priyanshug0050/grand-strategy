/**
 * ============================================================================
 *  src/admin/routes.js — the admin module's only connection to the game
 * ============================================================================
 *
 *  Mounted by two lines in server.js:
 *
 *      const adminRoutes = require('./src/admin/routes');
 *      app.use(adminRoutes.mount({ requireAuth, wrap, db }));
 *
 *  Comment those out and the entire admin surface is gone — not disabled,
 *  gone. Nothing else in the game imports from this folder.
 *
 *  ---------------------------------------------------------------------------
 *  EVERY ROUTE IS BEHIND TWO GATES
 *  ---------------------------------------------------------------------------
 *      requireAuth   — you are signed in
 *      requireAdmin  — the DATABASE says you are an admin, checked per request
 *
 *  Failures return 404, not 403, so the admin area is invisible to anyone who
 *  is not one. There is no route that grants admin, by design.
 * ============================================================================
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const service = require('./service');
const { requireAdmin, quietAuth } = require('./guard');

function mount({ verifyToken, wrap, db }) {
  const router = express.Router();

  // quietAuth, not the game's requireAuth: the standard one returns 401 to an
  // anonymous caller, which confirms the route exists. Here everything fails
  // the same way — 404 — whether you are signed out, signed in, or probing.
  const admin = [quietAuth(verifyToken), requireAdmin(db)];

  // Tighter than the game's own limiter. Even if an account is compromised,
  // this bounds how much damage can be done per minute — and a burst of admin
  // calls is itself a signal something is wrong.
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'Not found' },   // stay quiet even when limiting
  });

  // The admin HTML page is served from public/ like any other file, so it is
  // technically readable by anyone. That is fine: it contains no data, and
  // every call it makes 404s unless the database says you are an admin.
  // Hiding the page would be security theatre; gating the DATA is what counts.

  // ---- Read ----

  router.get('/api/admin/whoami', ...admin, limiter, wrap(async (req, res) => {
    res.json({ ok: true, email: req.admin.email });
  }));

  router.get('/api/admin/nations', ...admin, limiter, wrap(async (req, res) => {
    res.json({ nations: await service.listNations({ search: req.query.q }) });
  }));

  router.get('/api/admin/nation/:id', ...admin, limiter, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid nation id' });
    }
    res.json(await service.inspectNation(id));
  }));

  router.get('/api/admin/suspected-links', ...admin, limiter, wrap(async (req, res) => {
    res.json({ links: await service.suspectedLinks() });
  }));

  router.get('/api/admin/flagged-trades', ...admin, limiter, wrap(async (req, res) => {
    res.json({ trades: await service.flaggedTrades(Number(req.query.limit) || 50) });
  }));

  router.get('/api/admin/log', ...admin, limiter, wrap(async (req, res) => {
    res.json({ entries: await service.auditLog(Number(req.query.limit) || 100) });
  }));

  // ---- Mutations ----
  //
  // Every one requires a reason. That is enforced in the service layer rather
  // than here, so it cannot be bypassed by a future caller that skips routing.

  router.post('/api/admin/nation/:id/money', ...admin, limiter, wrap(async (req, res) => {
    const { amount, reason } = req.body || {};
    res.json(await service.setMoney(req.admin, Number(req.params.id), Number(amount), reason, req));
  }));

  router.post('/api/admin/nation/:id/resource', ...admin, limiter, wrap(async (req, res) => {
    const { resource, amount, reason } = req.body || {};
    res.json(await service.setResource(
      req.admin, Number(req.params.id), resource, Number(amount), reason, req));
  }));

  router.post('/api/admin/nation/:id/grant', ...admin, limiter, wrap(async (req, res) => {
    const { grant, reason } = req.body || {};
    res.json(await service.grantPackage(req.admin, Number(req.params.id), grant, reason, req));
  }));

  router.post('/api/admin/nation/:id/beige', ...admin, limiter, wrap(async (req, res) => {
    const { turns, reason } = req.body || {};
    res.json(await service.setBeige(req.admin, Number(req.params.id), Number(turns) || 0, reason, req));
  }));

  router.post('/api/admin/war/:id/end', ...admin, limiter, wrap(async (req, res) => {
    const { reason } = req.body || {};
    res.json(await service.endWar(req.admin, Number(req.params.id), reason, req));
  }));

  router.post('/api/admin/user/:id/ban', ...admin, limiter, wrap(async (req, res) => {
    const { banned, reason } = req.body || {};
    res.json(await service.setBanned(req.admin, Number(req.params.id), !!banned, reason, req));
  }));

  return router;
}

module.exports = { mount, service };
