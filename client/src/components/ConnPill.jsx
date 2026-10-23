import { useEffect, useState } from 'react';
import api from '../api/client.js';

/**
 * Connection pill in the top bar. Polls GET /api/esp32/status - in demo mode
 * the backend reports "connected" with mode "demo"; in live mode it probes the
 * ESP32 directly.
 */
export default function ConnPill({ busy = false, refreshKey = 0 }) {
  const [status, setStatus] = useState({
    connected: false,
    mode: 'demo',
    ip: '',
    state: 'idle',
  });

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await api.get('/esp32/status');
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus((s) => ({ ...s, connected: false, state: 'idle' }));
      }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [refreshKey]);

  const cls = busy ? 'dot busy' : status.connected ? 'dot on' : 'dot';
  const label = busy ? 'Working' : status.mode === 'demo' ? 'Demo' : status.connected ? 'Connected' : 'Offline';
  const ipText = status.mode === 'demo' ? 'demo' : status.ip || '—';

  return (
    <div className="conn-pill" title="ESP32 controller link">
      <span className={cls} />
      <span>{label}</span>
      <span className="ip-tag">{ipText}</span>
    </div>
  );
}