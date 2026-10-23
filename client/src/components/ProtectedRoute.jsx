import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import BootSplash from './BootSplash.jsx';

/**
 * Guards routes by authentication + role. Redirects:
 * - not signed in  -> /login
 * - wrong role     -> the appropriate dashboard for the user's role
 */
export default function ProtectedRoute({ roles, children }) {
  const { user, loading } = useAuth();

  if (loading) return <BootSplash />;
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) {
    return <Navigate to={user.role === 'admin' ? '/admin' : '/'} replace />;
  }
  return children;
}