import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import CutJob from '../models/CutJob.js';
import { badRequest, notFound, isEmail } from '../middleware/validate.js';

const SALT_ROUNDS = 10;

function safeUser(u) {
  return {
    id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    approvedAt: u.approvedAt,
    lastLoginAt: u.lastLoginAt,
    approvedByName: u.approvedBy?.name || null,
  };
}

/** Admin: pending employee registration requests. */
export async function getPending(req, res, next) {
  try {
    const users = await User.find({ role: 'employee', status: 'pending' })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, data: { users: users.map(safeUser) } });
  } catch (err) {
    return next(err);
  }
}

/** Admin: approve a pending employee -> allowed to log in. */
export async function approveUser(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, 'User not found.');
    if (user.role !== 'employee') return badRequest(res, 'Only employee accounts can be approved.');

    // Atomic: only transition pending -> approved. A concurrent reject or a
    // double-click on Approve is a clean no-op on the second request instead
    // of both writes racing to complete.
    const updated = await User.findOneAndUpdate(
      { _id: user._id, status: 'pending' },
      { $set: { status: 'approved', approvedBy: req.user._id, approvedAt: new Date() } },
      { new: true }
    );
    if (!updated) return badRequest(res, 'This request was already decided by an admin.');

    return res.json({ success: true, data: { user: updated.toSafeJSON() } });
  } catch (err) {
    return next(err);
  }
}

/** Admin: reject a pending employee. */
export async function rejectUser(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, 'User not found.');
    if (user.role !== 'employee') return badRequest(res, 'Only employee accounts can be rejected.');

    // Atomic: only transition pending -> rejected (see approveUser).
    const updated = await User.findOneAndUpdate(
      { _id: user._id, status: 'pending' },
      { $set: { status: 'rejected', approvedBy: req.user._id, approvedAt: new Date() } },
      { new: true }
    );
    if (!updated) return badRequest(res, 'This request was already decided by an admin.');

    return res.json({ success: true, data: { user: updated.toSafeJSON() } });
  } catch (err) {
    return next(err);
  }
}

/** Admin: create an employee account directly (skips the pending-request flow). */
export async function createEmployee(req, res, next) {
  try {
    const { name, email, password } = req.body || {};

    if (!name || typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) {
      return badRequest(res, 'Please provide the employee name (1-80 characters).');
    }
    if (!isEmail(email)) return badRequest(res, 'Please provide a valid email address.');
    if (typeof password !== 'string' || password.length < 8) {
      return badRequest(res, 'Temporary password must be at least 8 characters long.');
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
      status: 'approved',
      approvedBy: req.user._id,
      approvedAt: new Date(),
    });

    return res.status(201).json({
      success: true,
      data: {
        user: user.toSafeJSON(),
        message: `Employee "${user.name}" created. Share the temporary password with them securely.`,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/** Admin: list all employees with status + last login. */
export async function listEmployees(req, res, next) {
  try {
    const users = await User.find({ role: 'employee' })
      .sort({ createdAt: -1 })
      .populate('approvedBy', 'name')
      .lean();
    return res.json({ success: true, data: { users: users.map(safeUser) } });
  } catch (err) {
    return next(err);
  }
}

/** Admin: delete an employee account entirely (with their job history). */
export async function deleteEmployee(req, res, next) {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return notFound(res, 'User not found.');
    if (user.role === 'admin') return badRequest(res, 'Admin accounts cannot be deleted.');
    if (user._id.equals(req.user._id)) {
      return badRequest(res, 'You cannot delete your own account.');
    }

    await CutJob.deleteMany({ requestedBy: user._id });
    await User.deleteOne({ _id: user._id });

    return res.json({ success: true, data: { message: `Employee "${user.name}" removed.` } });
  } catch (err) {
    return next(err);
  }
}