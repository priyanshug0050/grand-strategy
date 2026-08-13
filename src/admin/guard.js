/**
 * ============================================================================
 *  src/admin/guard.js — the security boundary
 * ============================================================================
 *
 *  Everything in this folder is behind this file. If it is wrong, nothing else
 *  in the module matters.
 *
 *  ---------------------------------------------------------------------------
 *  THE RULES, AND WHY EACH ONE EXISTS
 *  ---------------------------------------------------------------------------
 *
 *  1. ADMIN STATUS IS READ FROM THE DATABASE ON EVERY REQUEST.
 *     Not from the JWT. A token is signed but not encrypted, lives for days,
 *     and cannot be revoked — so an `isAdmin` claim inside one would keep
 *     working long after you removed the privilege. One query per request is
 *     a fair price for being able to revoke access instantly.
 *
 *  2. FAILURES RETURN 404, NOT 403.
 *     A 403 tells an attacker "this exists, keep trying". A 404 tells them
 *     nothing. The admin panel should be invisible to anyone who is not one.
 *
 *  3. THERE IS NO ENDPOINT THAT GRANTS ADMIN.
 *     Not a protected one, not an "initial setup" one, not a one-time one.
 *     Promotion happens only through direct SQL. An API that can promote can
 *     be tricked into promoting.
 *
 *  4. EVERY ACTION IS LOGGED BEFORE IT IS APPLIED, IN THE SAME TRANSACTION.
 *     If the write succeeds the log succeeds; if the log fails the write rolls
 *     back. An unlogged admin action is indistinguishable from an exploit.
 *
 *  5. THE ADMIN'S OWN NATION IS NOT SPECIAL.
 *     There is no "give myself resources" shortcut, and admin actions on your
 *     own nation are logged as loudly as any other. If you want to play, use
 *     a separate account with no admin flag — see README.md.
 *
 *  ---------------------------------------------------------------------------
 *  WHAT THIS CANNOT PROTECT AGAINST
 *  ---------------------------------------------------------------------------
 *  If someone gets your password, they are you. No layer here helps. Use a
 *  long unique password, never reuse it, and never commit .env.
 * ============================================================================
 */

'use strict';

const crypto = require('crypto');

/**
 * Middleware factory. Requires an already-authenticated request — `requireAuth`
 * must run first so `req.userId` is set.
 *
 * @param {Object} db  the data layer (injected, so this file imports nothing
 *                     from the game — same discipline as the market module)
 */
/**
 * Authenticate WITHOUT leaking that the route exists.
 *
 * The game's own `requireAuth` returns 401 to anonymous callers — correct
 * everywhere else, but here it confirms an endpoint is there and worth
 * attacking. This wrapper swallows that and returns the same 404 as every
 * other failure, so an unauthenticated probe and a non-admin probe are
 * indistinguishable.
 */
function quietAuth(verifyToken) {
  return function (req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    // No token, or a bad one — same 404 as a non-admin. An attacker learns
    // nothing from the difference.
    if (!token) return res.status(404).json({ error: 'Not found' });

    const payload = verifyToken(token);
    if (!payload) return res.status(404).json({ error: 'Not found' });

    req.userId = Number(payload.sub);
    next();
  };
}

function requireAdmin(db) {
  return async function (req, res, next) {
    // Not signed in at all. Same 404 as everyone else — no hint that an admin
    // area exists.
    if (!req.userId) {
      return res.status(404).json({ error: 'Not found' });
    }

    try {
      const { rows } = await db.query(
        'SELECT id, email, is_admin, is_banned FROM users WHERE id = $1',
        [req.userId]
      );

      const user = rows[0];
      if (!user || !user.is_admin || user.is_banned) {
        // Log the attempt. A non-admin hitting these routes is either a bug or
        // someone probing, and both are worth knowing about.
        console.warn(
          `[admin] denied: user ${req.userId} tried ${req.method} ${req.originalUrl}`
        );
        return res.status(404).json({ error: 'Not found' });
      }

      req.admin = { id: Number(user.id), email: user.email };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Hash an IP for the audit log.
 *
 * Stored hashed rather than raw so the log is not itself a privacy liability —
 * we only ever need to compare, never to read.
 */
function hashIp(ip, salt = process.env.LINK_SALT || 'default-salt') {
  if (!ip) return null;
  return crypto.createHash('sha256').update(salt + ip).digest('hex').slice(0, 32);
}

/**
 * Write an audit entry.
 *
 * MUST be called with the same `tx` as the change it describes, so the two
 * commit or roll back together. Called outside a transaction, a failed write
 * would leave a log entry claiming something happened that did not.
 */
async function logAction(tx, admin, entry) {
  await tx.query(
    `INSERT INTO admin_log
       (admin_id, admin_email, action, target_type, target_id, target_name,
        before_value, after_value, reason, ip_hash, turn)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      admin.id,
      admin.email,
      entry.action,
      entry.targetType || null,
      entry.targetId || null,
      entry.targetName || null,
      entry.before !== undefined ? JSON.stringify(entry.before) : null,
      entry.after !== undefined ? JSON.stringify(entry.after) : null,
      entry.reason || null,
      entry.ipHash || null,
      entry.turn ?? null,
    ]
  );
}

module.exports = { requireAdmin, quietAuth, hashIp, logAction };
