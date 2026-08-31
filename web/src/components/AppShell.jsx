import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';
import { greeting, userDisplayName } from '../lib/format';
import { useOnline } from '../hooks/useOnline';
import { Brand } from './Brand';
import { Icon } from './Icon';

const desktopNav = [
  { to: '/', icon: 'home', label: '今日', end: true },
  { to: '/jobs', icon: 'search', label: '找岗位' },
  { to: '/pipeline', icon: 'progress', label: '求职进度' },
  { to: '/exams', icon: 'document', label: '考试中心' },
  { to: '/prep', icon: 'target', label: '每日练习' },
  { to: '/salary', icon: 'coin', label: '薪酬洞察' },
  { to: '/profile', icon: 'user', label: '我的' },
];

const mobileNav = desktopNav.filter(item => ['/', '/jobs', '/pipeline', '/exams', '/profile'].includes(item.to));

function NavItem({ item, mobile = false }) {
  return (
    <NavLink className={({ isActive }) => `${mobile ? 'mobile-nav-item' : 'sidebar-link'}${isActive ? ' active' : ''}`} to={item.to} end={item.end}>
      <Icon name={item.icon} size={mobile ? 24 : 21} strokeWidth={mobile ? 1.9 : 1.7} />
      <span>{item.label}</span>
    </NavLink>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();
  const [search, setSearch] = useState('');
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [entitlements, setEntitlements] = useState(null);
  const menuRef = useRef(null);
  const name = userDisplayName(user);

  useEffect(() => {
    setMenuOpen(false);
    setNoticeOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const controller = new AbortController();
    api.billing.entitlements(controller.signal).then(setEntitlements).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const close = event => {
      if (menuRef.current && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const submitSearch = event => {
    event.preventDefault();
    const query = search.trim();
    navigate(query ? `/jobs?q=${encodeURIComponent(query)}` : '/jobs');
  };

  const visibleDesktopNav = user?.role === 'admin'
    ? [...desktopNav, { to: '/admin/users', icon: 'settings', label: '用户管理' }]
    : desktopNav;

  return (
    <div className={`app-shell${sidebarCompact ? ' sidebar-compact' : ''}`}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <div className="sidebar-brand"><Brand /></div>
        <nav className="sidebar-nav" aria-label="主导航">
          {visibleDesktopNav.map(item => <NavItem key={item.to} item={item} />)}
        </nav>
        <div className="sidebar-usage">
          <span>当前套餐</span>
          <strong>{entitlements?.plan?.name || '免费版'}</strong>
          <small>权益和用量由服务端统一校验</small>
          <NavLink to="/pricing">了解会员权益 <Icon name="chevronRight" size={14} /></NavLink>
        </div>
      </aside>

      <div className="app-stage">
        <header className="topbar">
          <button
            className="icon-button menu-button"
            type="button"
            aria-label={sidebarCompact ? '展开导航' : '收起导航'}
            aria-pressed={sidebarCompact}
            onClick={() => setSidebarCompact(value => !value)}
          >
            <Icon name="menu" />
          </button>
          <form className="global-search" onSubmit={submitSearch} role="search">
            <Icon name="search" size={20} />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索公司、岗位或城市" aria-label="搜索公司、岗位或城市" />
          </form>
          <div className="topbar-actions" ref={menuRef}>
            <button className="icon-button notice-button" type="button" aria-label="通知" aria-expanded={noticeOpen} onClick={() => { setNoticeOpen(value => !value); setMenuOpen(false); }}>
              <Icon name="bell" size={22} />
              {user?.unreadNotifications > 0 && <i />}
            </button>
            <button className="user-menu-button" type="button" aria-expanded={menuOpen} onClick={() => { setMenuOpen(value => !value); setNoticeOpen(false); }}>
              <span className="avatar">{name.slice(0, 1)}</span>
              <span>{name}同学</span>
              <Icon name="chevronDown" size={14} />
            </button>
            {noticeOpen && <div className="popover notice-popover" role="status"><strong>通知</strong><p>重要提醒会出现在这里。</p></div>}
            {menuOpen && (
              <div className="popover user-popover">
                <button type="button" onClick={() => navigate('/profile')}><Icon name="user" size={17} />个人画像</button>
                <button type="button" onClick={() => navigate('/pricing')}><Icon name="crown" size={17} />套餐与权益</button>
                <button type="button" onClick={() => logout()}><Icon name="logout" size={17} />退出登录</button>
              </div>
            )}
          </div>
        </header>

        <header className="mobile-topbar">
          <div><Brand compact /><span>{greeting()}，{name}同学</span></div>
          <button className="icon-button notice-button" type="button" aria-label="通知" onClick={() => setNoticeOpen(value => !value)}>
            <Icon name="bell" size={27} />{user?.unreadNotifications > 0 && <i />}
          </button>
          {noticeOpen && <div className="popover notice-popover" role="status"><strong>通知</strong><p>重要提醒会出现在这里。</p></div>}
        </header>

        {!online && <div className="offline-banner" role="status"><Icon name="wifiOff" size={17} />当前离线，已打开的内容可继续查看；登录、刷新和修改需联网。</div>}
        <main className="app-content" id="main-content" tabIndex="-1"><Outlet /></main>
      </div>

      <nav className="mobile-nav" aria-label="主导航">
        {mobileNav.map(item => <NavItem key={item.to} item={item} mobile />)}
      </nav>
    </div>
  );
}
