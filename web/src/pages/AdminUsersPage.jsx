import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingState } from '../components/StatusViews';
import { useAuth } from '../context/AuthContext';
import { api, listPayload } from '../lib/api';

const roleLabels = {
  user: '普通用户',
  content_editor: '内容编辑',
  admin: '管理员',
};

export function AdminUsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (user?.role !== 'admin') {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true); setError('');
    Promise.all([api.admin.users(controller.signal), api.billing.plans(controller.signal)])
      .then(([userData, planData]) => {
        setUsers(listPayload(userData, 'users').items);
        setPlans(listPayload(planData, 'plans').items);
      })
      .catch(requestError => {
        if (requestError.name !== 'AbortError') setError(requestError.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [user?.role, reloadKey]);

  const updateRole = async (account, role) => {
    const key = `${account.id}:role`;
    setSaving(key); setError(''); setNotice('');
    try {
      const data = await api.admin.setRole(account.id, role);
      setUsers(current => current.map(item => item.id === account.id ? { ...item, ...(data.user || {}), plan: item.plan } : item));
      setNotice(`已更新 ${account.displayName || account.email} 的角色`);
    } catch (requestError) { setError(requestError.message); } finally { setSaving(''); }
  };

  const updatePlan = async (account, planId) => {
    const key = `${account.id}:plan`;
    setSaving(key); setError(''); setNotice('');
    try {
      const data = await api.admin.setPlan(account.id, planId);
      setUsers(current => current.map(item => item.id === account.id ? { ...item, plan: data.plan } : item));
      setNotice(`已更新 ${account.displayName || account.email} 的测试套餐`);
    } catch (requestError) { setError(requestError.message); } finally { setSaving(''); }
  };

  if (user?.role !== 'admin') return <div className="page"><ErrorState title="仅管理员可访问" message="此页面用于用户角色和测试套餐授权。" /></div>;
  if (loading) return <div className="page"><LoadingState rows={6} /></div>;
  if (error && !users.length) return <div className="page"><ErrorState message={error} onRetry={() => setReloadKey(value => value + 1)} /></div>;

  return (
    <div className="page admin-users-page">
      <header className="page-header">
        <div><h1>用户与授权</h1><p>管理用户角色和测试套餐。真实付费状态仍应由支付回调确认。</p></div>
        <div className="admin-header-actions"><a className="button secondary" href={__OPS_PUBLIC_BASE__}><Icon name="settings" size={17} />运营看板</a><Link className="button secondary" to="/profile"><Icon name="arrowLeft" size={17} />返回我的</Link></div>
      </header>
      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && <div className="form-success" role="status"><Icon name="checkCircle" size={18} />{notice}</div>}
      <section className="admin-user-list" aria-label="用户列表">
        <header><span>用户</span><span>角色</span><span>套餐授权</span><span>状态</span></header>
        {users.map(account => (
          <article key={account.id}>
            <div className="admin-user-identity"><i>{String(account.displayName || account.email).slice(0, 1)}</i><span><strong>{account.displayName || '未命名用户'}</strong><small>{account.email}</small></span></div>
            <label><span className="mobile-field-label">角色</span><select value={account.role} disabled={saving === `${account.id}:role` || account.id === user.id} onChange={event => updateRole(account, event.target.value)}>{Object.entries(roleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label><span className="mobile-field-label">套餐授权</span><select value={account.plan?.id || 'free'} disabled={saving === `${account.id}:plan`} onChange={event => updatePlan(account, event.target.value)}>{plans.map(plan => <option value={plan.id} key={plan.id}>{plan.name}</option>)}</select></label>
            <span className={`account-status ${account.status}`}>{account.status === 'active' ? '正常' : account.status}</span>
          </article>
        ))}
      </section>
      <p className="admin-note">管理员不能在这里查看用户密码、个人备注或答题内容；本页只处理身份角色和套餐授权。</p>
    </div>
  );
}
