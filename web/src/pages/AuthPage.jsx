import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Brand } from '../components/Brand';
import { Icon } from '../components/Icon';
import { useOnline } from '../hooks/useOnline';

export function AuthPage({ mode = 'login' }) {
  const isRegister = mode === 'register';
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const online = useOnline();
  const [visible, setVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', password: '', agree: false });

  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));

  const submit = async event => {
    event.preventDefault();
    setError('');
    if (!online) return setError('当前离线，联网后才能登录');
    if (isRegister && !form.agree) return setError('请先同意服务协议与隐私政策');
    if (form.password.length < 8) return setError('密码至少需要 8 个字符');
    setSubmitting(true);
    try {
      if (isRegister) {
        await register({ name: form.name.trim(), email: form.email.trim(), password: form.password });
        navigate('/onboarding', { replace: true });
      } else {
        await login({ email: form.email.trim(), password: form.password });
        navigate(location.state?.from || '/', { replace: true });
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <div>
          <h1>找到更适合你的<br />下一份工作</h1>
          <p>岗位聚合、画像匹配、进度管理和针对性备考，在一个地方完成。</p>
          <ol>
            <li><Icon name="check" size={16} />多来源岗位持续汇总与去重</li>
            <li><Icon name="check" size={16} />结合专业、技能与薪酬期望推荐</li>
            <li><Icon name="check" size={16} />从投递到面试的完整求职计划</li>
          </ol>
        </div>
        <small>职路 · 让每一步求职都有方向</small>
      </section>
      <section className="auth-form-wrap">
        <div className="auth-mobile-brand"><Brand /></div>
        <form className="auth-form" onSubmit={submit}>
          <h2>{isRegister ? '创建你的职路账户' : '欢迎回来'}</h2>
          <p>{isRegister ? '用几分钟完善画像，开始发现适合你的机会。' : '继续管理岗位、投递和备考计划。'}</p>
          {error && <div className="form-error" role="alert">{error}</div>}
          {isRegister && (
            <label className="field">
              <span>姓名或昵称</span>
              <input name="name" value={form.name} onChange={update} placeholder="怎么称呼你" autoComplete="name" required maxLength={80} />
            </label>
          )}
          <label className="field">
            <span>邮箱</span>
            <input name="email" type="email" value={form.email} onChange={update} placeholder="name@example.com" autoComplete="email" required />
          </label>
          <label className="field">
            <span>密码</span>
            <span className="password-field">
              <input name="password" type={visible ? 'text' : 'password'} value={form.password} onChange={update} placeholder="至少 8 个字符" autoComplete={isRegister ? 'new-password' : 'current-password'} required minLength={8} />
              <button type="button" onClick={() => setVisible(value => !value)} aria-label={visible ? '隐藏密码' : '显示密码'}><Icon name={visible ? 'eyeOff' : 'eye'} size={19} /></button>
            </span>
          </label>
          {isRegister ? (
            <label className="check-field">
              <input name="agree" type="checkbox" checked={form.agree} onChange={update} />
              <span>我已阅读并同意《服务协议》和《隐私政策》</span>
            </label>
          ) : <Link className="forgot-link" to="/register">还没有账户？立即注册</Link>}
          <button className="button primary auth-submit" type="submit" disabled={submitting || !online}>
            {submitting ? '请稍候…' : isRegister ? '注册并开始' : '登录'}
          </button>
          <p className="auth-switch">
            {isRegister ? '已经有账户？' : '第一次使用职路？'}
            <Link to={isRegister ? '/login' : '/register'}>{isRegister ? '直接登录' : '免费注册'}</Link>
          </p>
        </form>
      </section>
    </main>
  );
}
