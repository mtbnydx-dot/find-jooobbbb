import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigationType } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppShell } from './components/AppShell';
import { Brand } from './components/Brand';
import { ErrorState, LoadingState } from './components/StatusViews';
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
import { PolicyPage } from './pages/PolicyPage';
import { AdminConsolePage } from './pages/AdminConsolePage';
import { SupportPage } from './pages/SupportPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { AdminContentPage } from './pages/AdminContentPage';
import { AccountRecoveryPage } from './pages/AccountRecoveryPage';
import { AccountServicesPage } from './pages/AccountServicesPage';
import { AdminServicesPage } from './pages/AdminServicesPage';
import { AnnouncementAdminPage } from './pages/AnnouncementAdminPage';
import './styles/commercial.css';
import './styles/mobile-readiness.css';

function RouteScroll() {
  const { pathname, state } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    // Jobs owns restoration after its paginated rows have reloaded.
    if (pathname === '/jobs' && (state?.restoreJobList || navigationType === 'POP')) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname, state?.restoreJobList, navigationType]);
  return null;
}

function Protected({ children }) {
  const { user, loading, connectionError, refresh } = useAuth();
  const location = useLocation();
  if (loading) return <div className="auth-loading"><Brand /><LoadingState rows={2} compact /></div>;
  if (!user && connectionError) return <div className="auth-loading"><Brand /><ErrorState message={`${connectionError}。尚未确认登录状态，没有退出你的账户。离线时只能继续已打开的练习，不能重新加载题库。`} onRetry={() => refresh()} /></div>;
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
          <Route path="/policy/:kind" element={<PolicyPage />} />
          <Route path="/forgot-password" element={<AccountRecoveryPage mode="forgot" />} />
          <Route path="/reset-password" element={<AccountRecoveryPage key="reset" mode="reset" />} />
          <Route path="/verify-email" element={<AccountRecoveryPage key="verify" mode="verify" />} />
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
            <Route path="account-services" element={<AccountServicesPage />} />
            <Route path="pricing" element={<PricingPage />} />
            <Route path="support" element={<SupportPage />} />
            <Route path="workspace" element={<WorkspacePage />} />
            <Route path="admin" element={<AdminConsolePage />} />
            <Route path="admin/users" element={<AdminUsersPage />} />
            <Route path="admin/content" element={<AdminContentPage />} />
            <Route path="admin/services" element={<AdminServicesPage />} />
            <Route path="admin/announcements" element={<AnnouncementAdminPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
