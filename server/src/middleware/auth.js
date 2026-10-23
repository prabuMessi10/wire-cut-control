import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.JWT_SECRET || JWT_SECRET === 'dev-secret-change-me')
) {
  throw new Error(
    '[auth] JWT_SECRET is not set. Set a strong random JWT_SECRET in server/.env before deploying.'
  );
}
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

/**
 * Revoked-token blacklist (in-memory, keyed by subject + expiry) so that
 * logging out invalidates the issued JWT immediately instead of leaving a
 * replayable token valid until it expires. Cleared on server restart.
 */
const revokedTokens = new Set();

const revokeKey = (payload) => (payload?.exp ? `${payload.sub}:${payload.exp}` : null);

export function revokeToken(token) {
  try {
    const payload = jwt.decode(token);
    const key = revokeKey(payload);
    if (key) revokedTokens.add(key);
  } catch {
    /* token was already invalid */
  }
}

export function signToken(user) {
  return jwt.sign({ sub: user._id.toString(), role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

/** Store the JWT in an httpOnly cookie (never exposed to client JS). */
export function setAuthCookie(res, token) {
  const decoded = jwt.decode(token) || {};
  const maxAge = decoded.exp ? decoded.exp * 1000 - Date.now() : 12 * 3600 * 1000;
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
    path: '/',
  });
}

export function clearAuthCookie(res) {
  res.clearCookie('token', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

function respond(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

/**
 * Protect a route. Reads the token from the httpOnly cookie first and falls
 * back to an Authorization: Bearer header (useful for API tooling/tests).
 */
export async function requireAuth(req, res, next) {
  let token = req.cookies?.token || null;
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  }
  if (!token) {
    return respond(res, 401, 'UNAUTHORIZED', 'Authentication required.');
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return respond(res, 401, 'INVALID_TOKEN', 'Your session has expired. Please sign in again.');
  }
  if (revokedTokens.has(revokeKey(payload))) {
    return respond(res, 401, 'INVALID_TOKEN', 'Your session has expired. Please sign in again.');
  }

  let user;
  try {
    user = await User.findById(payload.sub);
  } catch (err) {
    // A DB hiccup is a server problem, not a session problem - surface it as
    // a 500 instead of pretending the token expired.
    return next(err);
  }
  if (!user) {
    return respond(res, 401, 'UNAUTHORIZED', 'Your account no longer exists.');
  }
  if (user.status !== 'approved') {
    return respond(res, 403, 'ACCOUNT_NOT_APPROVED', 'Your account is not approved yet.');
  }
  req.user = user;
  return next();
}

/** Role guard: only allow the listed roles through. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return respond(res, 403, 'FORBIDDEN', 'You do not have permission to perform this action.');
    }
    return next();
  };
}