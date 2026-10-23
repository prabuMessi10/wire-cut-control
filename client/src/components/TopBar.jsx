import { useAuth } from '../context/AuthContext.jsx';
import ConnPill from './ConnPill.jsx';
import { GearIcon, LogoMark, LogoutIcon } from './Icons.jsx';

/**
 * Shared top bar: brand, connection pill, settings (optional), user chip.
 */
export default function TopBar({ onOpenSettings, busy = false, showSettings = true, refreshKey = 0 }) {
  const { user, logout } = useAuth();

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">
          <LogoMark />
        </div>
        <div className="brand-text">
          <h1>Wire Cut Control</h1>
          <p>Automated wire processing · unit 01</p>
        </div>
      </div>

      <div className="topbar-right">
        <ConnPill busy={busy} refreshKey={refreshKey} />
        {showSettings && (
          <button className="icon-btn" onClick={onOpenSettings} aria-label="Settings">
            <GearIcon />
          </button>
        )}
        <div className="user-chip">
          <span className="user-avatar">{user?.name?.charAt(0)?.toUpperCase() || '?'}</span>
          <span className="user-meta">
            <span className="u-name">{user?.name}</span>
            <span className="u-role">{user?.role}</span>
          </span>
          <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out">
            <LogoutIcon />
          </button>
        </div>
      </div>
    </header>
  );
}