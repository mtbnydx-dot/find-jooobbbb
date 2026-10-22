import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';

export function AccountRecoveryPage({ mode = 'forgot' }) {
  const { refresh } = useAuth();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
  const [form, setForm] = useState({ email: '', password: '', confirmation: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [capabilities, setCapabilities] = useState(null);
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`);
    const controller = new AbortController();
    api.auth.capabilities(controller.signal).then(setCapabilities).catch(err => { if (err.name !== 'AbortError') setError(err.message); });
    return () => controller.abort();
  }, []);
  const submit = async event => {
    event.preventDefault(); setError(''); setMessage('');
    if (mode === 'reset' && form.password !== form.confirmation) return setError('两次新密码不一致');
    setBusy(true);
    try {
      if (mode === 'forgot') {
        const response = await api.auth.forgot(form.email.trim()); setMessage(response.message || '若该邮箱已注册，将收到密码重置邮件。请同时检查垃圾邮件。');
      } else if (mode === 'reset') {
        await api.auth.reset({ token, newPassword: form.password }); setForm({ email: '', password: '', confirmation: '' }); setMessage('密码已重置，所有旧登录已退出。请使用新密码登录。');
      } else {
        await api.auth.verify(token); setMessage('邮箱已验证。'); void refresh();
      }
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const unavailable = mode === 'forgot' && capabilities?.recovery?.passwordResetConfigured === false;
  return <main className="auth-loading"><Brand /><form className="auth-form" onSubmit={submit}>
    <h1>{mode === 'forgot' ? '找回密码' : mode === 'reset' ? '设置新密码' : '验证邮箱'}</h1>
    <p>{mode === 'forgot' ? '重置链接发送到注册邮箱，不会在页面显示账号是否存在。' : '此链接仅用于本次操作，请勿转发。链接移除后刷新页面会失效，可从邮件重新打开。'}</p>
    {error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}
    {unavailable && <p role="status">平台邮件服务尚未启用，暂不能自助找回密码。请联系平台支持处理，切勿向他人提供原密码。</p>}
    {mode !== 'forgot' && !token && <p role="alert">缺少验证凭据，请从最新邮件重新打开完整链接。</p>}
    {mode === 'forgot' && <label className="field"><span>注册邮箱</span><input type="email" autoComplete="email" required value={form.email} onChange={event => setForm(value => ({ ...value, email: event.target.value }))} /></label>}
    {mode === 'reset' && !message && <><label className="field"><span>新密码</span><input type="password" autoComplete="new-password" minLength={8} maxLength={256} required value={form.password} onChange={event => setForm(value => ({ ...value, password: event.target.value }))} /></label><label className="field"><span>再次输入新密码</span><input type="password" autoComplete="new-password" minLength={8} maxLength={256} required value={form.confirmation} onChange={event => setForm(value => ({ ...value, confirmation: event.target.value }))} /></label></>}
    {!message && <button className="button primary" disabled={busy || unavailable || (mode !== 'forgot' && !token)}>{busy ? '处理中…' : mode === 'forgot' ? '发送重置邮件' : mode === 'reset' ? '重置密码' : '确认验证邮箱'}</button>}
    <p><Link to="/login">返回登录</Link> · <Link to="/profile">我的账户</Link></p>
  </form></main>;
}
