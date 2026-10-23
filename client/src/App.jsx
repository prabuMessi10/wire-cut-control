import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import BootSplash from './components/BootSplash.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SignupPage from './pages/SignupPage.jsx';
import EmployeeDashboard from './pages/EmployeeDashboard.jsx';
import AdminDashboard from './pages/AdminDashboard.jsx';

function RedirectByRole() {
  const { user } = useAuth();
  return <Navigate to={user?.role === 'admin' ? '/admin' : '/'} replace />;
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <BootSplash />;

  return (
    <Routes>
      <Route path="/login" element={user ? <RedirectByRole /> : <LoginPage />} />
      <Route path="/signup" element={user ? <RedirectByRole /> : <SignupPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute roles={['employee']}>
            <EmployeeDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute roles={['admin']}>
            <AdminDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="*"
        element={<Navigate to={user ? (user.role === 'admin' ? '/admin' : '/') : '/login'} replace />}
      />
    </Routes>
  );
}