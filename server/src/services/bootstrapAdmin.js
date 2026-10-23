import bcrypt from 'bcryptjs';
import User from '../models/User.js';

const SALT_ROUNDS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Idempotently ensure a bootstrap admin exists using ADMIN_NAME / ADMIN_EMAIL
 * / ADMIN_PASSWORD from the environment.
 *
 * Used by:
 *  - the seed script (server/seed/createAdmin.js) against a real MongoDB;
 *  - the server itself when running with MONGODB_MEMORY=true, where the
 *    database is ephemeral so a separate seed process could not persist it.
 */
export async function ensureBootstrapAdmin() {
  const name = (process.env.ADMIN_NAME || 'System Administrator').trim() || 'System Administrator';
  const email = (process.env.ADMIN_EMAIL || 'admin@wirecut.local').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'AdminPass123!';

  const existing = await User.findOne({ role: 'admin' });
  if (existing) return { created: false, admin: existing };

  if (!EMAIL_RE.test(email)) {
    throw new Error('ADMIN_EMAIL is not a valid email address.');
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters long.');
  }

  const admin = await User.create({
    name,
    email,
    passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
    role: 'admin',
    status: 'approved',
  });
  return { created: true, admin };
}