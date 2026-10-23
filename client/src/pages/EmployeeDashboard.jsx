import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import RulerControl from '../components/RulerControl.jsx';
import StepIndicator from '../components/StepIndicator.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import JobsTable from '../components/JobsTable.jsx';
import SettingsDrawer from '../components/SettingsDrawer.jsx';
import Alert from '../components/Alert.jsx';
import { ScissorsIcon } from '../components/Icons.jsx';

const GAUGES = ['26 AWG', '24 AWG', '22 AWG', '20 AWG', '18 AWG', '16 AWG'];

// Machine timing model - MUST stay in sync with server/src/services/esp32.js,
// which computes the backend's poll deadline from the same formula.
const MS_PER_MM = 1.2;
const FEED_BASE_MS = 900;
const CUT_MS_PER_PIECE = 500;
const MIN_JOB_DEADLINE_MS = 60_000; // backend never gives a job less than this
const MAX_JOB_DEADLINE_MS = 600_000; // ...or more than this to finish
const DEADLINE_SAFETY_FACTOR = 1.3;
const FETCH_BUFFER_MS = 15_000; // browser waits a little longer than the backend

const estimateJobMs = (lengthMm, qty) =>
  qty * (FEED_BASE_MS + lengthMm * MS_PER_MM + CUT_MS_PER_PIECE);
const jobDeadlineMs = (lengthMm, qty) =>
  Math.round(
    Math.min(
      MAX_JOB_DEADLINE_MS,
      Math.max(MIN_JOB_DEADLINE_MS, estimateJobMs(lengthMm, qty) * DEADLINE_SAFETY_FACTOR)
    )
  );
const jobFetchTimeoutMs = (lengthMm, qty) => jobDeadlineMs(lengthMm, qty) + FETCH_BUFFER_MS;

const convertFromMm = (mm, unit) => {
  if (unit === 'cm') return Math.round((mm / 10) * 10) / 10;
  if (unit === 'in') return Math.round((mm / 25.4) * 100) / 100;
  return mm;
};
const convertToMm = (val, unit) => {
  if (unit === 'cm') return val * 10;
  if (unit === 'in') return val * 25.4;
  return val;
};

/**
 * Employee dashboard = the "New Cut Job" screen from the reference design:
 * ruler length control, Live Status card with step indicator, payload preview,
 * device card and a personal job history fed from MongoDB.
 */
export default function EmployeeDashboard() {
  const [settings, setSettings] = useState({ demoMode: true, esp32Ip: '', maxLenMm: 1000 });
  const [unit, setUnit] = useState('mm');
  const [lengthMm, setLengthMm] = useState(350);
  const [qty, setQty] = useState(1);
  const [gauge, setGauge] = useState('20 AWG');
  const [ref, setRef] = useState('');

  const [jobs, setJobs] = useState([]);
  const [liveState, setLiveState] = useState({ connected: false, mode: 'demo', state: 'idle' });
  const [stepState, setStepState] = useState('idle');
  const [stepError, setStepError] = useState(false);
  const [busy, setBusy] = useState(false);

  const [payloadText, setPayloadText] = useState('');
  const [responseText, setResponseText] = useState('');
  const [lastResult, setLastResult] = useState('—');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsSavedKey, setSettingsSavedKey] = useState(0);
  const [appError, setAppError] = useState('');

  // Machine settings (max length, esp32 ip, demo mode)
  useEffect(() => {
    api
      .get('/settings')
      .then((d) => setSettings(d.settings))
      .catch((err) => setAppError(err.message));
  }, []);

  // Personal job history
  const refreshJobs = useCallback(async () => {
    try {
      const data = await api.get('/jobs/mine');
      setJobs(data.jobs || []);
      setAppError('');
    } catch (err) {
      setAppError(err.message);
    }
  }, []);
  useEffect(() => {
    refreshJobs();
  }, [refreshJobs]);

  // Live machine state (drives the step indicator when idle)
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.get('/esp32/status');
        if (!cancelled) setLiveState(data);
      } catch {
        /* keep previous state */
      }
    };
    poll();
    const timer = setInterval(poll, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // When no job is in flight, the steps follow the machine's reported state.
  useEffect(() => {
    if (!busy) {
      setStepState(liveState.state || 'idle');
      setStepError(false);
    }
  }, [liveState.state, busy]);

  const cyclesToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return jobs
      .filter((j) => j.status === 'done' && new Date(j.createdAt) >= start)
      .reduce((sum, j) => sum + j.qty, 0);
  }, [jobs]);

  const sendJob = async () => {
    if (busy) return;
    if (lengthMm <= 0) {
      setAppError('Enter a length greater than zero.');
      return;
    }
    setAppError('');
    const payload = { length_mm: lengthMm, qty, gauge, ref: ref.trim() };
    setPayloadText(JSON.stringify(payload, null, 2));
    setResponseText('');
    setLastResult('—');
    setStepError(false);
    setStepState('feeding');
    setBusy(true);

    // Optimistic local animation so the UI feels responsive while the backend
    // relays the job to the ESP32 and waits for the cycle.
    const timer = setTimeout(
      () => setStepState('cutting'),
      Math.min(1500, 650 + lengthMm)
    );

    // The backend waits for the ESP32 to physically finish the job, so the
    // fetch timeout is derived from the job size (same model as the server's
    // poll deadline). A small job times out quickly; a huge batch gets up to
    // the 10-minute ceiling plus buffer.
    const timeoutMs = jobFetchTimeoutMs(lengthMm, qty);
    try {
      const data = await api.post('/jobs', payload, { signal: AbortSignal.timeout(timeoutMs) });
      const ok = data.job?.status === 'done';
      setLastResult(ok ? 'Success' : 'Failed');
      setStepState(ok ? 'done' : 'idle');
      setStepError(!ok);
      setResponseText(JSON.stringify(data.result, null, 2));
      if (!ok) {
        setAppError(
          typeof data.result?.error === 'string'
            ? data.result.error
            : 'The cut job failed. Check the machine and try again.'
        );
      }
      await refreshJobs();
    } catch (err) {
      setStepState('idle');
      setStepError(true);
      setLastResult('Failed');
      // A self-aborting timeout means the backend is still relaying/polling -
      // be honest that the machine may still be working rather than claiming
      // the job silently failed.
      const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
      setResponseText(
        timedOut
          ? `// still waiting after ${Math.round(timeoutMs / 1000)}s - the machine\n// may still be running; check Job history shortly.`
          : `// request failed: ${err.message}`
      );
      setAppError(
        timedOut
          ? `No response after ${Math.round(jobDeadlineMs(lengthMm, qty) / 1000)}s. The machine may still be working - check Job history in a moment.`
          : err.message
      );
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };

  const handleSettingsSaved = () => {
    api
      .get('/settings')
      .then((d) => setSettings(d.settings))
      .catch(() => {});
    setSettingsSavedKey((k) => k + 1);
  };

  const displayLength = convertFromMm(lengthMm, unit);
  const lengthStep = unit === 'in' ? 0.05 : 1;

  const isDone = stepState === 'done' && !stepError;
  const badgeTone = stepError ? 'err' : isDone ? 'ok' : stepState === 'idle' ? 'idle' : 'warn';
  const badgeText = stepError ? 'Error' : stepState.charAt(0).toUpperCase() + stepState.slice(1);

  return (
    <div className="app">
      <TopBar
        onOpenSettings={() => setDrawerOpen(true)}
        busy={busy}
        refreshKey={settingsSavedKey}
      />

      {appError && (
        <div style={{ marginBottom: 18 }}>
          <Alert tone="err">{appError}</Alert>
        </div>
      )}

      <div className="grid">
        {/* ---------- LEFT COLUMN ---------- */}
        <div>
          <div className="card">
            <div className="card-head">
              <span className="card-title">New cut job</span>
              <span className="card-sub">0–{settings.maxLenMm} mm</span>
            </div>

            <RulerControl
              valueMm={lengthMm}
              maxMm={settings.maxLenMm}
              unit={unit}
              onChange={setLengthMm}
              onUnitChange={setUnit}
            />

            <div className="field-row three">
              <div className="field">
                <label htmlFor="length-input">Length</label>
                <input
                  id="length-input"
                  type="number"
                  value={displayLength}
                  min={0}
                  max={convertFromMm(settings.maxLenMm, unit)}
                  step={lengthStep}
                  onChange={(e) => {
                    const raw = e.target.value === '' ? 0 : parseFloat(e.target.value);
                    if (Number.isNaN(raw)) return;
                    setLengthMm(
                      Math.max(0, Math.min(settings.maxLenMm, Math.round(convertToMm(raw, unit))))
                    );
                  }}
                />
              </div>
              <div className="field">
                <label>Unit</label>
                <div className="unit-toggle">
                  {['mm', 'cm', 'in'].map((u) => (
                    <button
                      key={u}
                      type="button"
                      className={unit === u ? 'active' : ''}
                      onClick={() => setUnit(u)}
                    >
                      {u}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="qty-input">Quantity</label>
                <input
                  id="qty-input"
                  type="number"
                  value={qty}
                  min={1}
                  max={200}
                  step={1}
                  onChange={(e) =>
                    setQty(Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 1)))
                  }
                />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="gauge-select">Wire gauge</label>
                <select id="gauge-select" value={gauge} onChange={(e) => setGauge(e.target.value)}>
                  {GAUGES.map((g) => (
                    <option key={g}>{g}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="ref-input">Job reference</label>
                <input
                  id="ref-input"
                  type="text"
                  placeholder="e.g. Order #245"
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  maxLength={200}
                />
              </div>
            </div>

            <button className="btn-primary" onClick={sendJob} disabled={busy}>
              <ScissorsIcon />
              <span>{busy ? 'Sending…' : 'Send cut job'}</span>
            </button>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Job history</span>
              <span className="card-sub">
                {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
              </span>
            </div>
            <JobsTable jobs={jobs} emptyText="No jobs sent yet" />
          </div>
        </div>

        {/* ---------- RIGHT COLUMN ---------- */}
        <div>
          <div className="card">
            <div className="card-head">
              <span className="card-title">Live status</span>
              <StatusBadge tone={badgeTone}>{badgeText}</StatusBadge>
            </div>

            <StepIndicator state={stepState} error={stepError} />

            <div className="status-readout">
              <div className="label">Target length</div>
              <div className="value">{lengthMm} mm</div>
            </div>

            <div className="status-grid">
              <div className="status-readout">
                <div className="label">Cycles today</div>
                <div className="value">{cyclesToday}</div>
              </div>
              <div className="status-readout">
                <div className="label">Last result</div>
                <div className="value" style={{ fontSize: 13 }}>
                  {lastResult}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Request payload</span>
              <span className="card-sub">sent to ESP32 as JSON</span>
            </div>
            <pre className="payload-pre">
              {payloadText
                ? payloadText +
                  (responseText
                    ? `\n\n// Response received:\n${responseText}`
                    : '\n// Waiting for machine response…')
                : '// Fill in the form and click "Send cut job" —\n// the exact JSON body will appear here.'}
            </pre>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Device</span>
            </div>
            <div className="status-grid" style={{ gridTemplateColumns: '1fr', gap: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Controller</span>
                <span className="mono">ESP32-WROOM</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>IP address</span>
                <span className="mono">{settings.esp32Ip || 'not set'}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 0' }}>
                <span style={{ color: 'var(--text-secondary)' }}>Mode</span>
                <span>{settings.demoMode ? 'Demo' : 'Live'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <footer>Wire Cut Control · connects to an ESP32 controller over local WiFi</footer>

      <SettingsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSaved={handleSettingsSaved}
      />
    </div>
  );
}