import CutJob from '../models/CutJob.js';
import { relayCutJob } from '../services/esp32.js';
import { getSettings } from '../services/settings.js';
import { badRequest, GAUGES } from '../middleware/validate.js';

function toJobJSON(job) {
  const requester = job.requestedBy;
  // requestBy is a populated doc in the list routes, but a bare ObjectId in
  // the createJob response - normalise both so the client always gets an id.
  const requesterId = requester && (requester._id || requester);
  return {
    id: job._id,
    lengthMm: job.lengthMm,
    qty: job.qty,
    gauge: job.gauge,
    ref: job.ref,
    status: job.status,
    esp32Response: job.esp32Response ?? null,
    createdAt: job.createdAt,
    requestedBy: requesterId
      ? {
          id: requesterId.toString(),
          name: requester?.name || null,
          email: requester?.email || null,
        }
      : null,
  };
}

/**
 * Employee: submit a cut job.
 *
 * The browser only ever talks to THIS backend. The backend relays the job to
 * the ESP32 (POST http://<ip>/cut), polls /status until done/error, stores the
 * full record in MongoDB and returns the outcome so the client can animate the
 * step progress.
 */
export async function createJob(req, res, next) {
  try {
    const { length_mm, qty, gauge, ref } = req.body || {};

    if (typeof length_mm !== 'number' || !Number.isFinite(length_mm) || length_mm <= 0) {
      return badRequest(res, 'Length must be a number greater than zero.');
    }
    if (length_mm > 100000) return badRequest(res, 'Length is unreasonably large.');

    const settings = await getSettings();
    if (length_mm > settings.maxLenMm) {
      return badRequest(
        res,
        `Length exceeds the configured maximum of ${settings.maxLenMm} mm.`
      );
    }

    const qtyNum = Number(qty);
    if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 200) {
      return badRequest(res, 'Quantity must be a whole number between 1 and 200.');
    }
    if (!GAUGES.includes(gauge)) {
      return badRequest(res, 'Please pick a valid wire gauge.');
    }
    if (ref !== undefined && (typeof ref !== 'string' || ref.length > 200)) {
      return badRequest(res, 'Job reference must be text no longer than 200 characters.');
    }

    const refStr = ref ? ref.trim() : '';

    // Relay to ESP32 (or run the demo sim). All outcomes are recorded below.
    let response;
    let status;
    try {
      response = await relayCutJob({ lengthMm: length_mm, qty: qtyNum, gauge, ref: refStr });
      status = 'done';
    } catch (err) {
      status = 'error';
      response = { error: err.message };
    }

    const job = await CutJob.create({
      requestedBy: req.user._id,
      lengthMm: length_mm,
      qty: qtyNum,
      gauge,
      ref: refStr,
      status,
      esp32Response: response,
    });

    return res.json({
      success: true,
      data: { job: toJobJSON(job), result: response },
    });
  } catch (err) {
    return next(err);
  }
}

/** Employee: their own job history (newest first). */
export async function myJobs(req, res, next) {
  try {
    const jobs = await CutJob.find({ requestedBy: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('requestedBy', 'name email');
    return res.json({ success: true, data: { jobs: jobs.map(toJobJSON) } });
  } catch (err) {
    return next(err);
  }
}

/** Admin: full job history across all employees, with filters. */
export async function allJobs(req, res, next) {
  try {
    const { employeeId, from, to, status } = req.query;
    const filter = {};

    if (employeeId) {
      if (!/^[0-9a-fA-F]{24}$/.test(employeeId)) {
        return badRequest(res, 'Invalid employee id filter.');
      }
      filter.requestedBy = employeeId;
    }
    if (status) {
      if (!['done', 'error'].includes(status)) return badRequest(res, 'Invalid status filter.');
      filter.status = status;
    }
    if (from || to) {
      filter.createdAt = {};
      if (from && !Number.isNaN(Date.parse(from))) {
        filter.createdAt.$gte = new Date(from);
      }
      if (to && !Number.isNaN(Date.parse(to))) {
        // Date-only values ("2026-09-24") should include the whole day.
        const end = new Date(to);
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) end.setUTCHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const jobs = await CutJob.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('requestedBy', 'name email');

    return res.json({ success: true, data: { jobs: jobs.map(toJobJSON) } });
  } catch (err) {
    return next(err);
  }
}