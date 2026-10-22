import React, { Suspense, lazy, useEffect } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import Icon from './components/Icon';
import { Button, Empty, Notice, Page, RouteScroll } from './components/UI';
import { useMobile } from './lib/runtime';
import { webAppBase } from './lib/api';
import Discovery, { AiPage } from './screens/Discovery';
import JobDetail, { SourcePage } from './screens/JobDetail';
import Progress from './screens/Progress';
const navigation = [{ path: '/discover', icon: 'search', label: '发现' }, { path: '/pipeline', icon: 'clipboard', label: '进度' }, { path: '/prep', icon: 'book', label: '备考' }, { path: '/account', icon: 'user', label: '我的' }];
const Prep = lazy(() => import('./screens/Prep').then(module => ({ default: module.PrepHome })));
const prepScreens = Object.fromEntries(['SectionPage', 'Practice', 'PracticeResult', 'QuestionCollection', 'ExamIntro', 'ExamSession', 'ExamResult'].map(name => [name, lazy(() => import('./screens/Prep').then(module => ({ default: module[name] })))]));
const accountScreens = Object.fromEntries(['AccountHome', 'MembershipPage', 'AttachmentsPage', 'MessagesPage', 'SettingsPage', 'SupportPage', 'AboutPage', 'SavedSearchesPage'].map(name => [name, lazy(() => import('./screens/Account').then(module => ({ default: module[name] })))]));
const authScreens = Object.fromEntries(['AuthPage', 'OnboardingPage'].map(name => [name, lazy(() => import('./screens/Auth').then(module => ({ default: module[name] })))]));
const PrepScreen = ({ name, ...props }) => React.createElement(prepScreens[name], props);
const AccountScreen = ({ name, ...props }) => React.createElement(accountScreens[name], props);
const AuthScreen = ({ name, ...props }) => React.createElement(authScreens[name], props);
function RequireAuth({ children }) {
  const { authStatus, authError, refreshUser } = useMobile();
  const location = useLocation();
  if (authStatus === 'loading') return <p className="loading-text" role="status">正在确认登录状态…</p>;
  if (authStatus === 'error') return <Page title="连接未完成"><Notice>{authError}</Notice><Button onClick={() => refreshUser()}>重新连接</Button></Page>;
  if (authStatus !== 'authenticated') return <Navigate to={`/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return children;
}
const privatePage = element => <RequireAuth>{element}</RequireAuth>;
class ScreenBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidUpdate(previous) { if (previous.route !== this.props.route && this.state.error) this.setState({ error: false }); }
  render() { return this.state.error ? <Page title="页面暂时无法显示"><Notice>可能是网络中断或页面版本已更新。重新加载不会清除已保存到云端的数据。</Notice><Button onClick={() => window.location.reload()}>重新加载</Button></Page> : this.props.children; }
}
export default function App() {
  const location = useLocation(); const { online, user, authChecking } = useMobile();
  useEffect(() => {
    if (!authChecking) return;
    const focused = document.activeElement;
    focused?.blur?.();
    return () => { if (focused?.isConnected) focused.focus?.({ preventScroll: true }); };
  }, [authChecking]);
  // Keep same-account drafts during checks, but block interaction on older iOS
  // versions without native inert support. A changed identity remounts all pages.
  const blockDuringCheck = event => { if (authChecking) { event.preventDefault(); event.stopPropagation(); } };
  const hideNav = !['/discover', '/pipeline', '/prep', '/account'].includes(location.pathname);
  return <><div className={`design-workspace ${authChecking ? 'identity-checking' : ''}`} inert={authChecking ? '' : undefined} aria-hidden={authChecking ? true : undefined}
    onClickCapture={blockDuringCheck} onSubmitCapture={blockDuringCheck} onKeyDownCapture={blockDuringCheck}
    onFocusCapture={event => { if (authChecking) event.target.blur(); }}>
    <aside className="design-rail"><Link to="/discover" className="rail-brand">职路 / MOBILE</Link><h2>更清晰地找到方向</h2><p>你的真实机会与求职进度<br/>手机和电脑共用一个账户</p><nav aria-label="桌面导航">{navigation.map(item => <NavLink to={item.path} key={item.path}><Icon name={item.icon} />{item.label}</NavLink>)}</nav><Link to={user ? '/onboarding' : '/auth/login'}>{user ? '更新求职画像' : '登录或注册'}</Link><a href={`${webAppBase}/jobs`}>切换完整网页版</a><p className="rail-note">招聘信息以原公告为准。会员按后台实际权益生效；未接入在线支付的渠道不会收款。</p></aside>
    <div className={`phone-surface ${hideNav ? 'without-nav' : ''}`}><RouteScroll />{!online ? <div className="connection-banner" role="status">当前离线，新增操作和云端数据需要联网</div> : null}
      <ScreenBoundary key={user?.id || 'anonymous'} route={location.pathname}><Suspense fallback={<p className="loading-text" role="status">加载页面…</p>}><Routes>
        <Route path="/" element={<Navigate to="/discover" replace />} /><Route path="/discover" element={<Discovery />} /><Route path="/jobs/:id" element={<JobDetail />} /><Route path="/jobs/:id/source" element={<SourcePage />} />
        <Route path="/ai" element={privatePage(<AiPage />)} /><Route path="/pipeline" element={privatePage(<Progress />)} /><Route path="/prep" element={privatePage(<Prep />)} />
        <Route path="/prep/sections" element={privatePage(<PrepScreen name="SectionPage" />)} /><Route path="/practice" element={privatePage(<PrepScreen name="Practice" />)} /><Route path="/practice/result" element={privatePage(<PrepScreen name="PracticeResult" />)} />
        <Route path="/wrongbook" element={privatePage(<PrepScreen name="QuestionCollection" type="wrong" />)} /><Route path="/bookmarks" element={privatePage(<PrepScreen name="QuestionCollection" type="bookmarks" />)} />
        <Route path="/exam" element={privatePage(<PrepScreen name="ExamIntro" />)} /><Route path="/exam/session" element={privatePage(<PrepScreen name="ExamSession" />)} /><Route path="/exam/result" element={privatePage(<PrepScreen name="ExamResult" />)} />
        {Object.entries({ account: 'AccountHome', membership: 'MembershipPage', attachments: 'AttachmentsPage', messages: 'MessagesPage', settings: 'SettingsPage', support: 'SupportPage', about: 'AboutPage', 'saved-searches': 'SavedSearchesPage' }).map(([path, name]) => <Route key={path} path={`/${path}`} element={privatePage(<AccountScreen name={name} />)} />)}
        <Route path="/auth/login" element={<AuthScreen name="AuthPage" mode="login" />} /><Route path="/auth/register" element={<AuthScreen name="AuthPage" mode="register" />} /><Route path="/auth/forgot" element={<AuthScreen name="AuthPage" mode="forgot" />} /><Route path="/onboarding" element={privatePage(<AuthScreen name="OnboardingPage" />)} />
        <Route path="*" element={<Page title="页面未找到"><Empty title="这个页面不存在" /></Page>} />
      </Routes></Suspense></ScreenBoundary>
      {!hideNav ? <nav className="bottom-nav" aria-label="主导航">{navigation.map(item => <NavLink key={item.path} to={item.path}><Icon name={item.icon} size={25} /><span>{item.label}</span></NavLink>)}</nav> : null}
    </div>
  </div>{authChecking ? <div className="identity-check-overlay" role="status" aria-live="polite">正在确认账户状态…</div> : null}</>;
}
