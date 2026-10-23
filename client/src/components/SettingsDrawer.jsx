import { useEffect, useState } from 'react';
import api from '../api/client.js';
import { CloseIcon, AlertIcon } from './Icons.jsx';

/**
 * Settings drawer (right-hand slide-in panel), faithful to the reference:
 * demo mode toggle, ESP32 IP, max wire length. Settings persist server-side.
 */
export default function SettingsDrawer({ open, onClose, onSaved }) {
  const [settings, setSettings] = useState({ demoMode: true, esp32Ip: '', maxLenMm: 1000 });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError('');
    api
      .get('/settings')
      .then((data) => setSettings(data.settings))
      .catch((err) => setError(err.message));
  }, [open]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put('/settings', {
        demoMode: settings.demoMode,
        esp32Ip: settings.esp32Ip,
        maxLenMm: Number(settings.maxLenMm),
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        className={`drawer-overlay${open ? ' open' : ''}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className={`drawer${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="drawer-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            <CloseIcon />
          </button>
        </div>

        <div className="toggle-row">
          <div>
            <div className="t-label">Demo mode</div>
            <div className="t-sub">Simulate the cutting cycle without hardware</div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.demoMode}
              onChange={(e) => setSettings((s) => ({ ...s, demoMode: e.target.checked }))}
            />
            <span className="slider" />
          </label>
        </div>

        <div className="field">
          <label htmlFor="drawer-ip">ESP32 IP address</label>
          <input
            id="drawer-ip"
            type="text"
            placeholder="192.168.1.42"
            value={settings.esp32Ip}
            onChange={(e) => setSettings((s) => ({ ...s, esp32Ip: e.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor="drawer-maxlen">Maximum wire length (mm)</label>
          <input
            id="drawer-maxlen"
            type="number"
            value={settings.maxLenMm}
            min={50}
            step={10}
            onChange={(e) => setSettings((s) => ({ ...s, maxLenMm: e.target.value }))}
          />
        </div>

        {error && (
          <div className="alert err">
            <AlertIcon />
            <span>{error}</span>
          </div>
        )}

        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save and reconnect'}
        </button>
      </aside>
    </>
  );
}