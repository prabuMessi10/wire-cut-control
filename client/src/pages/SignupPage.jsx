import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { LogoMark } from '../components/Icons.jsx';
import Alert from '../components/Alert.jsx';

/** Fallback inline clock glyph (avoids adding an unused export to Icons). */
function ClockGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" width={26} height={26} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

export default function SignupPage() {
  const { signup } = useAuth();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!name.trim() || !email.trim() || !password) {
      setError('Please fill in all fields.');
      return;
    }
    setBusy(true);
    try {
      await signup({ name: name.trim(), email: email.trim(), password });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">
            <div className="brand-mark">
              <LogoMark size={24} />
            </div>
            <h1>Wire Cut Control</h1>
            <p>Automated wire processing · unit 01</p>
          </div>

          <div className="approval-state">
            <div className="approval-icon">
              <ClockGlyph />
            </div>
            <h3>Request sent</h3>
            <p>
              Your account is awaiting admin approval. You'll be able to sign in
              as soon as an administrator approves your request.
            </p>
            <Link to="/login" className="btn-primary" style={{ textDecoration: 'none' }}>
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="brand-mark">
            <LogoMark size={24} />
          </div>
          <h1>Wire Cut Control</h1>
          <p>Automated wire processing · unit 01</p>
        </div>

        <h2>Request operator access</h2>
        {error && <Alert tone="err">{error}</Alert>}

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="signup-name">Full name</label>
            <input
              id="signup-name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jane Operator"
            />
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="signup-email">Email</label>
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="signup-password">Password</label>
            <input
              id="signup-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
            <p className="hint">Use at least 8 characters. A manager must approve your account before you can sign in.</p>
          </div>
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? 'Submitting…' : 'Request access'}
          </button>
        </form>

        <p className="auth-switch">
          Already approved?{' '}
          <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}