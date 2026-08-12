/**
 * ============================================================================
 *  auth.js — Password hashing, tokens, and request authentication
 * ============================================================================
 *
 *  Uses bcryptjs, not bcrypt. bcrypt is a native module that needs a C++
 *  toolchain to compile — on Windows that means Visual Studio Build Tools and
 *  a long detour. bcryptjs is pure JavaScript, marginally slower, and installs
 *  everywhere without ceremony. For a login endpoint that runs a few times per
 *  user per week, the speed difference is irrelevant.
 *
 *  THE SECRET COMES FROM THE ENVIRONMENT AND THE SERVER REFUSES TO START
 *  WITHOUT IT. A default fallback secret is worse than no auth at all, because
 *  it looks like security while every deployment shares the same key.
 * ============================================================================
 */

'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = '7d';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'JWT_SECRET missing or too short. Set a random 32+ character string in .env.\n' +
      'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  return secret;
}

async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

function issueToken(user) {
  return jwt.sign(
    { sub: String(user.id), email: user.email },
    getSecret(),
    { expiresIn: TOKEN_EXPIRY }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch {
    return null;
  }
}

/**
 * Attaches req.userId when a valid token is present.
 *
 * Note it reads the token from an Authorization header, not a cookie. That
 * sidesteps CSRF entirely — a cross-site form post cannot set a custom header.
 * The tradeoff is the frontend must store the token and attach it manually.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.userId = Number(payload.sub);
  next();
}

/**
 * Loads the caller's nation id and attaches it as req.nationId.
 *
 * Every game action derives the acting nation from the TOKEN, never from the
 * request body. If a route ever accepts a nationId parameter for "who is
 * acting", that is an authorisation hole: a player could act as anyone.
 */
function requireNation(repo, db) {
  return async function (req, res, next) {
    try {
      const { rows } = await db.query(
        'SELECT id FROM nations WHERE user_id = $1 AND is_deleted = FALSE LIMIT 1',
        [req.userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'No nation found. Create one first.' });
      }
      req.nationId = Number(rows[0].id);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Hash an IP for the anti-multi-accounting table.
 * Hashed rather than stored raw so the linkage data is not itself a privacy
 * liability — we only ever need to know whether two nations MATCH.
 */
function hashIdentifier(value, salt = process.env.LINK_SALT || 'default-salt') {
  if (!value) return null;
  return require('crypto').createHash('sha256').update(salt + value).digest('hex').slice(0, 32);
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  requireAuth,
  requireNation,
  hashIdentifier,
  getSecret,
};
