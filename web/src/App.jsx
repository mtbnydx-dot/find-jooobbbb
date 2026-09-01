import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppShell } from './components/AppShell';
import { Brand } from './components/Brand';
import { LoadingState } from './components/StatusViews';
import { AuthPage } from './pages/AuthPage';
import { DashboardPage } from './pages/DashboardPage';
import { JobsPage } from './pages/JobsPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { PipelinePage } from './pages/PipelinePage';
import { PrepPage } from './pages/PrepPage';
import { ExamCenterPage } from './pages/ExamCenterPage';
import { ExamSessionPage } from './pages/ExamSessionPage';
import { SalaryPage } from './pages/SalaryPage';
import { ProfilePage } from './pages/ProfilePage';
import { PricingPage } from './pages/PricingPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { AdminUsersPage } from './pages/AdminUsersPage';

function RouteScroll() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }, [pathname]);
  return null;
}

function Protected({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="auth-loading"><Brand /><LoadingState rows={2} compact /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return children;
}

function GuestOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-loading"><Brand /><LoadingState rows={2} compact /></div>;
  return user ? <Navigate to="/" replace /> : children;
}

function NotFoundPage() {
  return <div className="not-found"><Brand /><h1>这个页面走远了</h1><p>返回首页，继续寻找适合你的机会。</p><a className="button primary" href={import.meta.env.BASE_URL}>回到今日</a></div>;
}

export default function App() {
  const basename = import.meta.env.BASE_URL === '/' ? '/' : import.meta.env.BASE_URL.replace(/\/$/, '');
  return (
    <BrowserRouter basename={basename}>
      <AuthProvider>
        <RouteScroll />
        <Routes>
          <Route path="/login" element={<GuestOnly><AuthPage /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><AuthPage mode="register" /></GuestOnly>} />
          <Route path="/onboarding" element={<Protected><OnboardingPage /></Protected>} />
          <Route element={<Protected><AppShell /></Protected>}>
            <Route index element={<DashboardPage />} />
            <Route path="jobs" element={<JobsPage />} />
            <Route path="jobs/:jobId" element={<JobDetailPage />} />
            <Route path="pipeline" element={<PipelinePage />} />
            <Route path="prep" element={<PrepPage />} />
            <Route path="exams" element={<ExamCenterPage />} />
            <Route path="exams/session/:sessionId" element={<ExamSessionPage />} />
            <Route path="salary" element={<SalaryPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="pricing" element={<PricingPage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
