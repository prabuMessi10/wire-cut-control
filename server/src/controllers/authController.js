import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import { signToken, setAuthCookie, clearAuthCookie, revokeToken } from '../middleware/auth.js';
import { badRequest, isEmail } from '../middleware/validate.js';

const SALT_ROUNDS = 10;

/** Employee self-registration -> creates a "pending" account that cannot log in yet. */
export async function register(req, res, next) {
  try {
    const { name, email, password } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) {
      return badRequest(res, 'Please provide your full name (1-80 characters).');
    }
    if (!isEmail(email)) return badRequest(res, 'Please provide a valid email address.');
    if (typeof password !== 'string' || password.length < 8) {
      return badRequest(res, 'Password must be at least 8 characters long.');
    }

    const existing = await User.findOne({ email: email.trim().toLowerCase() });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists.' },
      });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
      role: 'employee',
      status: 'pending',
    });

    return res.status(201).json({
      success: true,
      data: {
        user: user.toSafeJSON(),
        message: 'Your account is awaiting admin approval.',
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** Log in. Blocks pending and rejected accounts; approves admin/approved users. */
export async function login(req, res, next) {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
      return badRequest(res, 'Email and password are required.');
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      });
    }

    if (user.status === 'pending') {
      return res.status(403).json({
        success: false,
        error: { code: 'PENDING', message: 'Your account is awaiting admin approval.' },
      });
    }
    if (user.status === 'rejected') {
      return res.status(403).json({
        success: false,
        error: {
          code: 'REJECTED',
          message: 'Your account was rejected. Contact an administrator.',
        },
      });
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = signToken(user);
    setAuthCookie(res, token);

    return res.json({ success: true, data: { user: user.toSafeJSON() } });
  } catch (err) {
    return next(err);
  }
}

/** Clear the auth cookie and revoke the token server-side. */
export function logout(req, res) {
  const token = req.cookies?.token || null;
  if (token) revokeToken(token);
  clearAuthCookie(res);
  return res.json({ success: true, data: { message: 'Signed out.' } });
}

/** Return the currently authenticated user (used to restore sessions on refresh). */
export async function me(req, res) {
  return res.json({ success: true, data: { user: req.user.toSafeJSON() } });
}