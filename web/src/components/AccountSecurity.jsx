import { useCallback, useEffect, useState } from 'react';
import { api, request } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useOnline } from '../hooks/useOnline';
import '../styles/account-security.css';

const when = value => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function AccountSecurity() {
  const { user, setUser, renew } = useAuth();
  const online = useOnline();
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '', confirmation: '' });
  const [sessions, setSessions] = useState([]);
  const [nextCursor, setNextCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [capabilities, setCapabilities] = useState(null);
  useEffect(() => { const controller = new AbortController(); api.auth.capabilities(controller.signal).then(setCapabilities).catch(() => {}); return () => controller.abort(); }, []);
  const refresh = useCallback(async (signal, cursor = '') => {
    const result = await request(`/me/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal });
    setSessions(items => cursor ? [...items, ...result.sessions] : result.sessions);
    setNextCursor(result.nextCursor || '');
    setLoading(false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch(err => { if (err.name !== 'AbortError') { setError(err.message); setLoading(false); } });
    return () => controller.abort();
  }, [refresh]);

  const changePassword = async event => {
    event.preventDefault(); setError(''); setMessage('');
    if (passwords.newPassword !== passwords.confirmation) { setError('两次输入的新密码不一致'); return; }
    if (passwords.newPassword === passwords.currentPassword) { setError('新密码需要与当前密码不同'); return; }
    setBusy('password');
    try {
      await request('/me/password', { method: 'POST', body: { currentPassword: passwords.currentPassword, newPassword: passwords.newPassword } });
      setPasswords({ currentPassword: '', newPassword: '', confirmation: '' });
      setMessage('密码已更新，其他登录已退出。你可以继续使用当前页面。');
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  };

  const revoke = async session => {
    setBusy(session?.id || 'others'); setError(''); setMessage('');
    try {
      const result = await request(session ? `/me/sessions/${encodeURIComponent(session.id)}` : '/me/sessions', { method: 'DELETE', body: {} });
      if (result.revokedCurrent) { setUser(null); return; }
      setMessage(session ? '已退出这次登录。' : '已退出其他登录。');
      await refresh();
    } catch (err) { setError(err.message); } finally { setBusy(''); }
  };

  return <section className="account-security" aria-labelledby="account-security-heading">
    <div className="account-security-heading"><h2 id="account-security-heading">账号安全</h2><p>更新登录密码，管理仍然有效的登录记录。</p></div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {message && <div className="form-success" role="status">{message}</div>}
    <section className="account-password-action"><div><h3>邮箱与登录有效期</h3><p>{user?.emailVerifiedAt ? '注册邮箱已验证' : '注册邮箱尚未验证'}。{capabilities?.recovery?.emailVerificationConfigured === false ? '邮件服务未配置，暂不能发送验证邮件。' : '验证邮箱用于账户恢复。'}</p></div><button className="button secondary" disabled={!online || Boolean(busy) || Boolean(user?.emailVerifiedAt) || !capabilities?.recovery?.emailVerificationConfigured} onClick={async () => { setBusy('verify'); setError(''); try { const data = await api.auth.sendVerification(); setMessage(data.message || '验证邮件已发送，请打开邮箱中的链接。'); } catch (err) { setError(err.message); } finally { setBusy(''); } }}>发送验证邮件</button><button className="button secondary" disabled={!online || Boolean(busy)} onClick={async () => { setBusy('renew'); setError(''); try { const data = await renew(); setMessage(`当前登录已续期至 ${when(data.expiresAt)}，旧凭据已更新。`); await refresh(); } catch (err) { setError(err.message); } finally { setBusy(''); } }}>续期当前登录</button></section>
    <form className="account-password-form" onSubmit={changePassword}>
      <label className="field"><span>当前密码</span><input type="password" autoComplete="current-password" required maxLength={256} value={passwords.currentPassword} onChange={event => setPasswords(value => ({ ...value, currentPassword: event.target.value }))} /></label>
      <label className="field"><span>新密码</span><input type="password" autoComplete="new-password" required minLength={8} maxLength={256} value={passwords.newPassword} onChange={event => setPasswords(value => ({ ...value, newPassword: event.target.value }))} /><small>8–256 个字符</small></label>
      <label className="field"><span>再次输入新密码</span><input type="password" autoComplete="new-password" required minLength={8} maxLength={256} value={passwords.confirmation} onChange={event => setPasswords(value => ({ ...value, confirmation: event.target.value }))} /></label>
      <div className="account-password-action"><button className="button secondary" disabled={!online || Boolean(busy)}>{busy === 'password' ? '正在更新…' : '更新密码'}</button><small>修改后将退出其他设备，当前登录会自动更新。</small></div>
    </form>
    <div className="account-session-heading"><h3>有效登录</h3><button type="button" className="button ghost" onClick={() => revoke(null)} disabled={!online || Boolean(busy) || sessions.filter(item => !item.current).length === 0}>退出其他登录</button></div>
    <p className="account-session-description">按登录时间查看。尚未采集设备名称和位置，不推断登录者身份。</p>
    {loading ? <p role="status">正在加载登录记录…</p> : <ul className="account-session-list">{sessions.map(session => <li key={session.id}><div><strong>{session.current ? '当前登录' : '其他登录'}</strong><span>{when(session.createdAt)}</span><small>有效期至 {when(session.expiresAt)}</small></div><button type="button" className="button ghost" onClick={() => revoke(session)} disabled={!online || Boolean(busy)}>{busy === session.id ? '处理中…' : session.current ? '退出当前登录' : '退出这次登录'}</button></li>)}</ul>}
    {nextCursor && <button className="button ghost" type="button" disabled={Boolean(busy)} onClick={() => { setBusy('more'); refresh(undefined, nextCursor).catch(err => setError(err.message)).finally(() => setBusy('')); }}>加载更多登录记录</button>}
  </section>;
}
