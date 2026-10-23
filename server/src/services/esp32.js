import { getSettings, getSimState, setSimState } from './settings.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Machine timing model.
//
// A job feeds `length_mm` of wire and cuts it, once per piece in `qty`:
//   per-piece time = FEED_BASE_MS + length_mm * MS_PER_MM + CUT_MS_PER_PIECE
//
// Every timeout derived from this model (the status-poll deadline) MUST stay
// in sync with the client's copy of the model in
// client/src/pages/EmployeeDashboard.jsx (jobFetchTimeoutMs), so the browser
// never aborts a request before the backend's deadline has actually elapsed.
// ---------------------------------------------------------------------------
export const MS_PER_MM = 1.2; // feed travel time per mm of wire
export const FEED_BASE_MS = 900; // fixed per-piece feed overhead
export const CUT_MS_PER_PIECE = 500; // one cut cycle per piece
export const MIN_JOB_DEADLINE_MS = 60_000; // every job gets at least 60s…
export const MAX_JOB_DEADLINE_MS = 600_000; // …but never more than 10 minutes
const DEADLINE_SAFETY_FACTOR = 1.3; // slack over the raw estimate

/** Estimated wall-clock time for a job, based on the machine timing model. */
export function estimateJobMs(lengthMm, qty) {
  return qty * (FEED_BASE_MS + lengthMm * MS_PER_MM + CUT_MS_PER_PIECE);
}

/**
 * Dynamic deadline for a job: estimate * safety factor, clamped to sane
 * bounds. Scales with job size so a large batch is never falsely failed by a
 * short fixed timeout; the clamp is the last-resort ceiling.
 */
export function jobDeadlineMs(lengthMm, qty) {
  const estimate = estimateJobMs(lengthMm, qty);
  return Math.round(
    Math.min(MAX_JOB_DEADLINE_MS, Math.max(MIN_JOB_DEADLINE_MS, estimate * DEADLINE_SAFETY_FACTOR))
  );
}

/** ASP32 "/status" probe with one retry (matches the reference UI behaviour). */
export async function getEsp32Status() {
  const settings = await getSettings();

  if (settings.demoMode) {
    return {
      connected: true,
      mode: 'demo',
      ip: null,
      state: getSimState().state || 'idle',
    };
  }

  const ip = settings.esp32Ip;
  if (!ip) {
    return { connected: false, mode: 'live', ip: '', state: 'idle', error: 'ESP32 IP not configured' };
  }

  const probe = async () => {
    const res = await fetch(`http://${ip}/status`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  try {
    const data = await probe();
    return { connected: true, mode: 'live', ip, state: data.state || 'idle', raw: data };
  } catch (err) {
    try {
      const data = await probe(); // one retry - a dropped packet shouldn't hard-fail
      return { connected: true, mode: 'live', ip, state: data.state || 'idle', raw: data };
    } catch (err2) {
      return { connected: false, mode: 'live', ip, state: 'idle', error: err2.message };
    }
  }
}

/**
 * Relay a cut job to the ESP32 and wait for the cycle to finish.
 *
 * Demo mode:        simulate the feeding -> cutting -> done cycle server-side.
 * Live mode:        POST http://<esp32-ip>/cut, then poll /status until the
 *                   device reports "done" or "error" (up to a dynamic
 *                   job-size-derived deadline; see jobDeadlineMs).
 *
 * Resolves with the final machine response or throws on failure.
 */
export async function relayCutJob({ lengthMm, qty, gauge, ref }) {
  const settings = await getSettings();

  if (settings.demoMode) {
    const estimate = estimateJobMs(lengthMm, qty);
    // Keep the demo snappy for huge batches: cap the simulated duration at
    // 45s, but preserve the feeding/cutting split of a real cycle.
    const DEMO_CAP_MS = 45_000;
    const total = Math.min(estimate, DEMO_CAP_MS);
    const feedShare = (FEED_BASE_MS + lengthMm * MS_PER_MM) / estimate;
    setSimState('feeding');
    await wait(Math.max(100, Math.round(total * feedShare)));
    setSimState('cutting');
    await wait(Math.max(50, total - Math.round(total * feedShare)));
    setSimState('done');
    // Hold the "done" state long enough for the UI to register it, then idle.
    setTimeout(() => setSimState('idle'), 1500);
    return {
      status: 'done',
      state: 'done',
      mode: 'demo',
      length_mm: lengthMm,
      qty,
      message: 'Demo cycle completed successfully',
    };
  }

  const ip = settings.esp32Ip;
  if (!ip) throw new Error('ESP32 IP address is not configured (open Settings).');

  // 1. Send the cut command to the ESP32.
  let startData;
  try {
    const res = await fetch(`http://${ip}/cut`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ length_mm: lengthMm, qty, gauge, ref: ref || '' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Device rejected job start (HTTP ${res.status})`);
    startData = await res.json();
    if (startData.status !== 'started') {
      throw new Error(`Device rejected job: ${JSON.stringify(startData)}`);
    }
  } catch (err) {
    throw new Error(`Failed to start job on ESP32: ${err.message}`);
  }

  // 2. Poll /status until the machine reports done/error (or the dynamic
  //    deadline derived from the job size is reached).
  const deadlineMs = jobDeadlineMs(lengthMm, qty);
  console.log(
    `[esp32] job ${lengthMm}mm x ${qty} -> deadline ${Math.round(deadlineMs / 1000)}s ` +
      `(estimate ${Math.round(estimateJobMs(lengthMm, qty) / 1000)}s)`
  );
  const deadline = Date.now() + deadlineMs;
  let lastPollError = null;
  while (Date.now() < deadline) {
    await wait(300); // poll every 300 ms
    try {
      const statusRes = await fetch(`http://${ip}/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!statusRes.ok) continue;
      const statusData = await statusRes.json();

      if (statusData.state === 'done') {
        return { status: 'done', state: 'done', mode: 'live', startData, statusData };
      }
      if (statusData.state === 'error') {
        // Not a transient network blip - the machine itself reported an error.
        const err = new Error('Hardware error reported by ESP32 during processing');
        err.isHardwareError = true;
        throw err;
      }
    } catch (pollErr) {
      if (pollErr.isHardwareError) throw pollErr; // surface real machine errors
      lastPollError = pollErr; // ignore transient poll timeouts while the motor is running
    }
  }

  const suffix =
    lastPollError && lastPollError.name === 'AbortError'
      ? ` (last status poll timed out while waiting)`
      : '';
  throw new Error(
    `Timed out waiting for ESP32 to finish the job (` +
      `${Math.round(deadlineMs / 1000)}s deadline for ${lengthMm}mm x ${qty}).${suffix}`
  );
}