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
  { to: '/workspace', icon: 'briefcase', label: '求职工具' },
  { to: '/exams', icon: 'document', label: '考试中心' },
  { to: '/prep', icon: 'target', label: '每日练习' },
  { to: '/salary', icon: 'coin', label: '薪酬洞察' },
  { to: '/pricing', icon: 'crown', label: '会员权益' },
  { to: '/support', icon: 'send', label: '帮助与反馈' },
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
  const [notices, setNotices] = useState({ items: [], unread: 0 });
  const [noticeError, setNoticeError] = useState('');
  const [entitlements, setEntitlements] = useState(null);
  const menuRef = useRef(null);
  const name = userDisplayName(user);

  useEffect(() => {
    setMenuOpen(false);
    setNoticeOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const controller = new AbortController();
    api.notifications.list(controller.signal).then(setNotices).catch(error => { if (error.name !== 'AbortError') setNoticeError(error.message); });
    return () => controller.abort();
  }, [location.pathname, noticeOpen]);

  const noticePanel = <div className="popover notice-popover" role="status"><strong>通知</strong>{noticeError ? <p>{noticeError}</p> : notices.items.length ? <><button type="button" onClick={() => api.notifications.read().then(setNotices).catch(error => setNoticeError(error.message))}>全部标记已读</button>{notices.items.slice(0,8).map(item => <button className="notice-item" key={item.id} type="button" onClick={() => navigate(item.link)}><strong>{item.readAt ? '' : '• '}{item.title}</strong><span>{item.body}</span></button>)}</> : <p>暂无到期提醒。收藏岗位或设置下一步行动后，提醒会出现在这里。</p>}</div>;

  useEffect(() => {
    const controller = new AbortController();
    api.billing.entitlements(controller.signal).then(setEntitlements).catch(() => {});
    return () => controller.abort();
  }, [location.pathname]);

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

  const visibleDesktopNav = [...desktopNav,
    ...(user?.role === 'admin' ? [{ to: '/admin', icon: 'building', label: '管理后台', end: true }] : []),
    ...(['admin', 'content_editor'].includes(user?.role) ? [{ to: '/admin/content', icon: 'book', label: '题库内容' }] : []),
  ];

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
          <small>{entitlements?.plan?.currentPeriodEnd ? `有效至 ${new Date(entitlements.plan.currentPeriodEnd).toLocaleDateString('zh-CN')}` : '按自己的节奏，把机会变成进展'}</small>
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
              {notices.unread > 0 && <i />}
            </button>
            <button className="user-menu-button" type="button" aria-expanded={menuOpen} onClick={() => { setMenuOpen(value => !value); setNoticeOpen(false); }}>
              <span className="avatar">{name.slice(0, 1)}</span>
              <span>{name}</span>
              <Icon name="chevronDown" size={14} />
            </button>
            {noticeOpen && noticePanel}
            {menuOpen && (
              <div className="popover user-popover">
                <button type="button" onClick={() => navigate('/profile')}><Icon name="user" size={17} />个人画像</button>
                <button type="button" onClick={() => navigate('/pricing')}><Icon name="crown" size={17} />套餐与权益</button>
                <button type="button" onClick={() => navigate('/support')}><Icon name="send" size={17} />帮助与反馈</button>
                <button type="button" onClick={() => navigate('/workspace')}><Icon name="briefcase" size={17} />求职工具</button>
                {user?.role === 'admin' && <button type="button" onClick={() => navigate('/admin')}><Icon name="building" size={17} />管理后台</button>}
                {['admin', 'content_editor'].includes(user?.role) && <button type="button" onClick={() => navigate('/admin/content')}><Icon name="book" size={17} />题库内容管理</button>}
                <button type="button" onClick={() => logout()}><Icon name="logout" size={17} />退出登录</button>
              </div>
            )}
          </div>
        </header>

        <header className="mobile-topbar">
          <div><Brand compact /><span>{greeting()}，{name}</span></div>
          <button className="icon-button notice-button" type="button" aria-label="通知" onClick={() => setNoticeOpen(value => !value)}>
            <Icon name="bell" size={27} />{notices.unread > 0 && <i />}
          </button>
          {noticeOpen && noticePanel}
        </header>

        {!online && <div className="offline-banner" role="status"><Icon name="wifiOff" size={17} />当前离线，已打开的内容可继续查看；登录、刷新和修改需联网。</div>}
        {location.pathname === '/profile' && <nav className="mobile-account-links" aria-label="账户功能"><NavLink to="/workspace">求职工具</NavLink><NavLink to="/pricing">会员权益</NavLink><NavLink to="/support">帮助与反馈</NavLink>{user?.role === 'admin' && <NavLink to="/admin">管理后台</NavLink>}{['admin', 'content_editor'].includes(user?.role) && <NavLink to="/admin/content">题库内容管理</NavLink>}</nav>}
        <main className="app-content" id="main-content" tabIndex="-1"><Outlet /></main>
      </div>

      <nav className="mobile-nav" aria-label="主导航">
        {mobileNav.map(item => <NavItem key={item.to} item={item} mobile />)}
      </nav>
    </div>
  );
}
