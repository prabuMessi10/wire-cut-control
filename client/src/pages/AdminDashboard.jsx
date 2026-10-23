import { useCallback, useEffect, useMemo, useState } from 'react';
import api from '../api/client.js';
import TopBar from '../components/TopBar.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import JobsTable from '../components/JobsTable.jsx';
import SettingsDrawer from '../components/SettingsDrawer.jsx';
import Modal from '../components/Modal.jsx';
import Alert from '../components/Alert.jsx';
import { CheckIcon, TrashIcon, XIcon } from '../components/Icons.jsx';

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString([], {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

function statusTone(status) {
  if (status === 'approved') return 'ok';
  if (status === 'pending') return 'warn';
  if (status === 'rejected') return 'err';
  return 'idle';
}

/**
 * Admin dashboard: approve/reject pending operators, create employees directly,
 * remove employees (with confirmation) and browse the full job history with
 * employee / date-range / status filters.
 */
export default function AdminDashboard() {
  const [pending, setPending] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  const [flash, setFlash] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  // create-employee form
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [creating, setCreating] = useState(false);

  // job history filters
  const [filterEmployee, setFilterEmployee] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // delete confirmation
  const [target, setTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsSavedKey, setSettingsSavedKey] = useState(0);

  const flashSoon = (msg) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(''), 5000);
  };

  const loadPending = useCallback(async () => {
    try {
      const data = await api.get('/users/pending');
      setPending(data.users || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const loadEmployees = useCallback(async () => {
    try {
      const data = await api.get('/users');
      setEmployees(data.users || []);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterEmployee) params.set('employeeId', filterEmployee);
    if (filterFrom) params.set('from', filterFrom);
    if (filterTo) params.set('to', filterTo);
    if (filterStatus) params.set('status', filterStatus);
    try {
      const qs = params.toString();
      const data = await api.get(`/jobs/all${qs ? `?${qs}` : ''}`);
      setJobs(data.jobs || []);
    } catch (err) {
      setError(err.message);
    }
  }, [filterEmployee, filterFrom, filterTo, filterStatus]);

  useEffect(() => {
    Promise.all([loadPending(), loadEmployees(), loadJobs()]).finally(() => setLoading(false));
  }, [loadPending, loadEmployees, loadJobs]);

  const handleDecision = async (id, action) => {
    setBusyId(id);
    setError('');
    try {
      await api.post(`/users/${id}/${action}`);
      flashSoon(action === 'approve' ? 'Request approved - the operator can now sign in.' : 'Request rejected.');
      await Promise.all([loadPending(), loadEmployees()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      const data = await api.post('/users', form);
      flashSoon(data.message || `Employee "${data.user.name}" created.`);
      setForm({ name: '', email: '', password: '' });
      await Promise.all([loadEmployees()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const requestDelete = (user) => {
    setTarget(user);
  };

  const confirmDelete = async () => {
    if (!target) return;
    setDeleting(true);
    setError('');
    try {
      await api.del(`/users/${target.id}`);
      flashSoon(`Employee "${target.name}" removed (including their job history).`);
      setTarget(null);
      await Promise.all([loadEmployees(), loadJobs()]);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const handleSettingsSaved = () => setSettingsSavedKey((k) => k + 1);

  const jobCount = useMemo(() => jobs.length, [jobs]);

  if (loading) return null;

  return (
    <div className="app">
      <TopBar
        onOpenSettings={() => setDrawerOpen(true)}
        refreshKey={settingsSavedKey}
      />

      {(flash || error) && (
        <div style={{ marginBottom: 18 }}>
          {flash && <Alert tone="ok">{flash}</Alert>}
          {error && <Alert tone="err">{error}</Alert>}
        </div>
      )}

      {/* ---------- Pending requests ---------- */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Pending requests</span>
          <span className="card-sub">{pending.length} awaiting review</span>
        </div>
        {pending.length === 0 ? (
          <p style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: '6px 0' }}>
            No pending requests. New signups will appear here for approval.
          </p>
        ) : (
          pending.map((u) => (
            <div className="pending-row" key={u.id}>
              <span className="user-avatar">{u.name.charAt(0).toUpperCase()}</span>
              <div className="who">
                <div className="name">{u.name}</div>
                <div className="sub">
                  {u.email} · requested {formatDate(u.createdAt)}
                </div>
              </div>
              <div className="actions">
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => handleDecision(u.id, 'approve')}
                  disabled={busyId === u.id}
                >
                  <CheckIcon />
                  Approve
                </button>
                <button
                  className="btn-danger btn-sm"
                  onClick={() => handleDecision(u.id, 'reject')}
                  disabled={busyId === u.id}
                >
                  <XIcon />
                  Reject
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ---------- Create employee ---------- */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Create employee</span>
          <span className="card-sub">skip the request flow</span>
        </div>
        <form onSubmit={handleCreate}>
          <div className="field-row three">
            <div className="field">
              <label htmlFor="emp-name">Name</label>
              <input
                id="emp-name"
                type="text"
                placeholder="Jane Operator"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="emp-email">Email</label>
              <input
                id="emp-email"
                type="email"
                placeholder="jane@company.com"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="emp-password">Temporary password</label>
              <input
                id="emp-password"
                type="password"
                placeholder="At least 8 characters"
                minLength={8}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                required
              />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn-primary" type="submit" disabled={creating} style={{ width: 'auto', padding: '10px 22px', marginTop: 0 }}>
              {creating ? 'Creating…' : 'Create employee'}
            </button>
          </div>
        </form>
      </div>

      {/* ---------- Employees ---------- */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Employees</span>
          <span className="card-sub">{employees.length} total</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Status</th>
                <th>Last login</th>
                <th>Created</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={5}>No employees yet</td>
                </tr>
              ) : (
                employees.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="user-row">
                        <span className="user-avatar">{u.name.charAt(0).toUpperCase()}</span>
                        <div className="who">
                          <div className="name">{u.name}</div>
                          <div className="sub">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge tone={statusTone(u.status)}>
                        {u.status.charAt(0).toUpperCase() + u.status.slice(1)}
                      </StatusBadge>
                    </td>
                    <td className="mono">{formatDate(u.lastLoginAt)}</td>
                    <td className="mono">{formatDate(u.createdAt)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn-ghost btn-sm" onClick={() => requestDelete(u)}>
                        <TrashIcon />
                        Delete
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------- Job history (all employees) ---------- */}
      <div className="card">
        <div className="card-head">
          <span className="card-title">Job history</span>
          <span className="card-sub">
            {jobCount} {jobCount === 1 ? 'job' : 'jobs'} · all employees
          </span>
        </div>

        <div className="filter-row">
          <div className="field">
            <label htmlFor="filter-employee">Employee</label>
            <select id="filter-employee" value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
              <option value="">All employees</option>
              {employees.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-from">From date</label>
            <input id="filter-from" type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="filter-to">To date</label>
            <input id="filter-to" type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="filter-status">Status</label>
            <select id="filter-status" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
              <option value="">Any status</option>
              <option value="done">Done</option>
              <option value="error">Error</option>
            </select>
          </div>
        </div>

        <JobsTable jobs={jobs} showEmployee emptyText="No jobs match the current filters" />
      </div>

      <footer>Wire Cut Control · connects to an ESP32 controller over local WiFi</footer>

      <SettingsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onSaved={handleSettingsSaved} />

      <Modal
        open={!!target}
        title={`Remove ${target?.name || 'employee'}?`}
        body={`This permanently deletes the account${target ? ` (${target.email})` : ''} and all of its job history. This cannot be undone.`}
        confirmLabel="Remove employee"
        busy={deleting}
        onConfirm={confirmDelete}
        onClose={() => !deleting && setTarget(null)}
      />
    </div>
  );
}