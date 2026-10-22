import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { useAuth } from '../context/AuthContext';
import { useOnline } from '../hooks/useOnline';
import { api, listPayload } from '../lib/api';

const roleLabels = { user: '普通用户', content_editor: '内容编辑', admin: '管理员' };
const date = value => value ? new Date(value).toLocaleDateString('zh-CN') : '无到期日';

function AccountEditor({ account, plans, self, busy, mutate }) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState(account.role);
  const [planId, setPlanId] = useState(account.plan?.id || 'free');
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState('');
  const [action, setAction] = useState('plan');
  const submit = async event => {
    event.preventDefault();
    const operation = action === 'role' ? () => api.admin.setRole(account.id, role) : action === 'status' ? () => api.admin.setStatus(account.id, account.status === 'active' ? 'suspended' : 'active', reason) : action === 'sessions' ? () => api.admin.revokeSessions(account.id, reason) : () => api.admin.setPlan(account.id, planId, { days: Number(days), reason });
    const ok = await mutate(operation, `${account.displayName || account.email} 的${action === 'role' ? '角色' : action === 'status' ? '账户状态' : action === 'sessions' ? '登录状态' : '会员授权'}已更新`);
    if (ok) { setEditing(false); setReason(''); }
  };
  return <article className="commerce-list-item admin-account">
    <div className="commerce-item-heading"><div className="admin-user-identity"><i>{String(account.displayName || account.email).slice(0, 1)}</i><span><strong>{account.displayName || '未命名用户'}{self ? '（当前账户）' : ''}</strong><small>{account.email}</small></span></div><span className={`commerce-status ${account.status === 'active' ? 'approved' : 'rejected'}`}>{account.status === 'active' ? '正常' : '已停用'}</span></div>
    <div className="admin-account-facts"><span>{roleLabels[account.role] || account.role}</span><span>{account.plan?.name || '免费版'}</span><span>{account.plan?.subscription?.currentPeriodEnd ? `有效至 ${date(account.plan.subscription.currentPeriodEnd)}` : '基础权益'}</span></div>
    <button className="button secondary" type="button" disabled={busy} onClick={() => { setEditing(!editing); setRole(account.role); setPlanId(account.plan?.id || 'free'); }}>管理账户 <Icon name="chevronDown" size={15} /></button>
    {editing && <form className="commerce-review" onSubmit={submit}>
      <label className="field"><span>管理事项</span><select value={action} onChange={e => setAction(e.target.value)}><option value="plan">人工会员授权</option><option value="role" disabled={self}>调整角色</option><option value="status" disabled={self}>{account.status === 'active' ? '停用账户并退出登录' : '恢复账户'}</option><option value="sessions" disabled={self}>退出所有登录</option></select></label>
      {action === 'role' && <label className="field"><span>账户角色</span><select value={role} onChange={e => setRole(e.target.value)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
      {action === 'plan' && <div className="field-grid two"><label className="field"><span>授权套餐</span><select value={planId} onChange={e => setPlanId(e.target.value)}>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label>{planId !== 'free' && <label className="field"><span>授权天数</span><input type="number" min="1" max="365" step="1" required value={days} onChange={e => setDays(e.target.value)} /></label>}</div>}
      {action !== 'role' && <label className="field"><span>操作原因</span><textarea required maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder={action === 'plan' ? '例如内测赠送、补偿或人工核实后的授权' : '请说明本次管理操作的原因'} /></label>}
      {action === 'status' && <p className="inline-notice">{account.status === 'active' ? '停用会立即撤销此用户的登录会话，数据仍然保留。' : '恢复后，用户可以再次登录并访问自己的数据。'}</p>}
      {action === 'sessions' && <p className="inline-notice">此用户在所有设备上都将退出，需要重新登录；不会修改密码或删除数据。</p>}
      <div className="commerce-actions"><button className="button primary" type="submit" disabled={busy || (action !== 'role' && !reason.trim()) || (action === 'role' && role === account.role)}>{busy ? '保存中…' : '确认保存'}</button><button className="button secondary" type="button" onClick={() => setEditing(false)} disabled={busy}>取消</button></div>
    </form>}
  </article>;
}

export function AdminUsersPage() {
  const { user } = useAuth();
  const online = useOnline();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(async signal => {
    const [users, plans] = await Promise.all([api.admin.users(signal), api.admin.plans(signal)]);
    setData({ users: listPayload(users, 'users').items, plans: listPayload(plans, 'plans').items, nextCursor: users.nextCursor, total: users.total });
  }, []);
  useEffect(() => { if (user?.role !== 'admin') return; const controller = new AbortController(); load(controller.signal).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [load, user?.role]);
  const reload = async () => { setLoading(true); setError(''); try { await load(); } catch (e) { setError(e.message); } finally { setLoading(false); } };
  const mutate = async (operation, success) => { if (busy || !online) return false; setBusy(true); setError(''); setNotice(''); try { await operation(); await load(); setNotice(success); return true; } catch (e) { setError(e.message); return false; } finally { setBusy(false); } };
  const more = async () => { setLoadingMore(true); try { const page = await api.admin.users(undefined, { cursor: data.nextCursor }); setData(current => ({ ...current, users: [...current.users, ...page.users], nextCursor: page.nextCursor, total: page.total })); } catch (e) { setError(e.message); } finally { setLoadingMore(false); } };
  if (user?.role !== 'admin') return <div className="page"><EmptyState title="仅管理员可访问" description="此页面用于用户角色、账户状态和会员授权管理。" icon="lock" action={<Link className="button primary" to="/">返回首页</Link>} /></div>;
  const users = (data?.users || []).filter(account => (!roleFilter || account.role === roleFilter) && `${account.displayName} ${account.email}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="page commercial-admin">
    <header className="page-header"><div><Link className="back-link" to="/admin"><Icon name="arrowLeft" size={17} />管理后台</Link><h1>用户与授权</h1><p>管理账户状态、角色和限时权益。会员申请请在“会员申请”中核验，人工授权用于明确的运营场景。</p></div><Link className="button secondary" to="/admin?tab=orders">会员申请</Link></header>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="form-success" role="status"><Icon name="checkCircle" size={18} />{notice}</div>}
    <div className="commerce-toolbar"><label className="field commerce-search"><span>搜索已加载用户</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="姓名或邮箱" /></label><label className="field"><span>角色</span><select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}><option value="">全部角色</option>{Object.entries(roleLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button type="button" className="button secondary" disabled={loading || busy} onClick={reload}><Icon name="refresh" size={16} />刷新</button></div>
    {loading ? <LoadingState rows={5} /> : !data ? <ErrorState message={error} onRetry={reload} /> : users.length ? <div className="admin-account-list">{users.map(account => <AccountEditor key={account.id} account={account} plans={data.plans} self={account.id === user.id} busy={busy || !online} mutate={mutate} />)}</div> : <EmptyState title="没有符合条件的用户" description="可以尝试更换姓名、邮箱或角色筛选。" icon="user" />}
    {data?.nextCursor && <div className="commerce-pagination"><span className="commerce-caption">已加载 {data.users.length} / {data.total} 个账户</span><button type="button" className="button secondary" disabled={loadingMore || busy} onClick={more}>{loadingMore ? '加载中…' : '加载更多用户'}</button></div>}
    <p className="commerce-caption">当前已加载 {data?.users.length || 0} 个账户。角色、套餐和状态变更会保留操作记录；管理员不能查看用户密码。</p>
  </div>;
}
