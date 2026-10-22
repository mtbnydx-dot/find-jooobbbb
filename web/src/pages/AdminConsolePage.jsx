import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { useAuth } from '../context/AuthContext';
import { api, listPayload } from '../lib/api';
import { useOnline } from '../hooks/useOnline';
import { TicketConversation, ticketCategories, ticketStatuses } from './SupportPage';

const tabs = [{ id: 'overview', label: '经营总览' }, { id: 'orders', label: '会员申请' }, { id: 'plans', label: '套餐与权益' }, { id: 'support', label: '用户反馈' }, { id: 'audit', label: '操作记录' }];
const orderLabels = { pending: '待审核', approved: '已开通', rejected: '未通过', cancelled: '已取消' };
const quotaNames = { 'profile.majors': '专业数量', 'prep.tracks': '备考路径（-1 为不限）', 'prep.attempts.daily': '每日练习次数', 'savedSearches.limit': '保存搜索条件', 'offers.limit': 'Offer 记录', 'studyPlans.limit': '学习计划', 'salary.insights': '薪酬洞察（0 关闭 / 1 开启）' };
const quotaBounds = key => key === 'profile.majors' ? { min: 1, max: 20 } : key === 'salary.insights' ? { min: 0, max: 1 } : { min: -1, max: 10000 };
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const money = (amount, currency = 'CNY') => new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount || 0) / 100);
// The isolated product process intentionally has no collector or AI credentials.
const operationsUrl = __OPS_PUBLIC_BASE__ === '/app-ops' ? '/' : __OPS_PUBLIC_BASE__;

function Overview({ overview, setTab }) {
  const cards = [['注册用户', overview.users, 'user'], ['有效岗位', overview.activeJobs, 'briefcase'], ['有效会员', overview.paidMembers, 'crown'], ['待审申请', overview.pendingOrders, 'clock'], ['待处理工单', overview.openTickets, 'send'], ['人工核验金额', money(overview.verifiedRevenue), 'coin']];
  return <><div className="commerce-metrics">{cards.map(([label, value, icon]) => <article key={label}><span><Icon name={icon} size={19} />{label}</span><strong>{value ?? '—'}</strong></article>)}</div><div className="commerce-overview-columns"><section className="commerce-panel"><h2>待办入口</h2><div className="admin-task-links"><button onClick={() => setTab('orders')} type="button"><span><strong>核验会员申请</strong><small>检查凭证、开通周期，处理重复申请</small></span><span>{overview.pendingOrders ?? 0}<Icon name="chevronRight" size={16} /></span></button><button onClick={() => setTab('support')} type="button"><span><strong>回复用户反馈</strong><small>处理岗位纠错、会员和账号问题</small></span><span>{overview.openTickets ?? 0}<Icon name="chevronRight" size={16} /></span></button><Link to="/admin/content"><span><strong>维护题库内容</strong><small>编辑草稿、发布与查看版本记录</small></span><Icon name="chevronRight" size={16} /></Link><Link to="/admin/users"><span><strong>用户与授权</strong><small>管理角色、状态和限时会员授权</small></span><Icon name="chevronRight" size={16} /></Link></div></section><section className="commerce-panel"><h2>产品使用</h2><dl className="commerce-facts"><div><dt>已完善画像</dt><dd>{overview.profilesCompleted ?? 0}</dd></div><div><dt>投递记录</dt><dd>{overview.applications ?? 0}</dd></div><div><dt>考试提交</dt><dd>{overview.examSubmissions ?? 0}</dd></div><div><dt>已核验申请</dt><dd>{overview.approvedOrders ?? 0}</dd></div></dl><p className="commerce-caption">以上为平台实际累计数据。人工核验金额不代表支付渠道结算收入。</p><small className="commerce-caption">统计时间：{date(overview.asOf)}</small></section></div></>;
}

function OrderReview({ order, onSave, busy, onClose }) {
  const [action, setAction] = useState('approve');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  return <form className="commerce-review" onSubmit={event => { event.preventDefault(); onSave(order.id, { action, reference: reference.trim(), reason: reason.trim() }); }}><div className="field-grid two"><label className="field"><span>处理结果</span><select value={action} onChange={event => { setAction(event.target.value); setChecked(false); }}><option value="approve">核验通过并开通</option><option value="reject">拒绝申请</option></select></label><label className="field"><span>{action === 'approve' ? '核验凭证编号（必填）' : '关联凭证（选填）'}</span><input value={reference} maxLength={200} required={action === 'approve'} onChange={event => setReference(event.target.value)} placeholder="填写真实交易或授权凭证编号" /></label></div><label className="field"><span>处理说明（用户可见）</span><textarea required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="说明核验结果；拒绝时请提供原因和下一步" /></label><label className="commerce-check"><input type="checkbox" checked={checked} required onChange={event => setChecked(event.target.checked)} /><span>{action === 'approve' ? `已核对申请人、${money(order.amount, order.currency)} 金额和凭证；确认开通 ${order.days} 天权益。` : '确认已填写拒绝原因，提交后这条申请结束。'}</span></label><div className="commerce-actions"><button className="button primary" type="submit" disabled={busy || !checked || !reason.trim() || (action === 'approve' && !reference.trim())}>{busy ? '处理中…' : action === 'approve' ? '确认开通' : '确认拒绝'}</button><button className="button secondary" type="button" onClick={onClose} disabled={busy}>取消</button></div></form>;
}

function Orders({ orders, mutate, busy }) {
  const [filter, setFilter] = useState('pending');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const visible = orders.filter(order => (!filter || order.status === filter) && `${order.userEmail || ''} ${order.displayName || ''} ${order.id}`.toLowerCase().includes(query.toLowerCase()));
  return <><div className="commerce-toolbar"><label className="field"><span>申请状态</span><select value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部状态</option>{Object.entries(orderLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="field commerce-search"><span>搜索申请</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="邮箱、用户名或申请号" /></label><span className="commerce-caption">{visible.length} 条记录</span></div><div className="inline-notice">这是人工核验工作台。请先确认真实凭证，再授予会员；通过审核会立即生效，同套餐续期会延长有效期。</div>{!visible.length ? <EmptyState title="没有符合条件的申请" description="调整筛选条件，或等待用户提交会员申请。" icon="crown" /> : <div className="commerce-list">{visible.map(order => <article className="commerce-list-item" key={order.id}><div className="commerce-item-heading"><div><h3>{order.planName} · {order.termLabel || `${order.days} 天`} <span className="commerce-amount">{money(order.amount, order.currency)}</span></h3><small>{order.displayName || order.userEmail} · {order.userEmail}</small></div><span className={`commerce-status ${order.status}`}>{orderLabels[order.status]}</span></div><p className="commerce-caption">{date(order.createdAt)} · {order.id}</p>{order.note && <p className="commerce-response">申请说明：{order.note}</p>}{order.reference && <p className="commerce-caption">核验凭证：{order.reference}</p>}{order.reviewNote && <p>处理说明：{order.reviewNote}</p>}{order.currentPeriodEnd && <p className="commerce-caption">有效至 {date(order.currentPeriodEnd)}</p>}{order.status === 'pending' && (selected === order.id ? <OrderReview key={order.id} order={order} busy={busy} onClose={() => setSelected('')} onSave={(id, body) => mutate(() => api.admin.reviewOrder(id, body), '申请处理完成').then(ok => { if (ok) setSelected(''); })} /> : <button className="button secondary" type="button" disabled={busy} onClick={() => setSelected(order.id)}>审核申请</button>)}</article>)}</div>}</>;
}

function PlanEditor({ plan, mutate, busy }) {
  const [draft, setDraft] = useState(() => ({ name: plan.name, tagline: plan.tagline || '', availableForRequest: Boolean(plan.availableForRequest), terms: (plan.terms || []).map(term => ({ ...term, yuan: String(term.price / 100) })), entitlements: { ...plan.entitlements } }));
  const [dirty, setDirty] = useState(false);
  const update = values => { setDraft(current => ({ ...current, ...values })); setDirty(true); };
  const save = event => { event.preventDefault(); mutate(() => api.admin.updatePlan(plan.id, { ...draft, terms: draft.terms.map(({ yuan, ...term }) => ({ ...term, price: Math.round(Number(yuan) * 100) })) }), '套餐目录已更新，新申请将采用新价格和权益').then(ok => { if (ok) setDirty(false); }); };
  return <form className="commerce-panel admin-plan-editor" onSubmit={save}><div className="section-title-row"><h2>{plan.name}</h2><span className="commerce-caption">{plan.id}</span></div><div className="field-grid two"><label className="field"><span>套餐名称</span><input value={draft.name} required maxLength={50} onChange={e => update({ name: e.target.value })} /></label><label className="field"><span>适用人群说明</span><input value={draft.tagline} required maxLength={200} onChange={e => update({ tagline: e.target.value })} /></label></div>{plan.id !== 'free' && <><label className="commerce-check"><input type="checkbox" checked={draft.availableForRequest} onChange={e => update({ availableForRequest: e.target.checked })} /><span>开放会员申请</span></label><div className="field-grid three">{draft.terms.map((term, index) => <label className="field" key={term.id}><span>{term.label || `${term.days} 天`}价格（元）</span><input type="number" min="1" max="10000" step="0.01" required value={term.yuan} onChange={e => update({ terms: draft.terms.map((item, itemIndex) => itemIndex === index ? { ...item, yuan: e.target.value } : item) })} /></label>)}</div></>}<details className="plan-quota-editor"><summary>编辑权益额度</summary><p className="commerce-caption">专业数量为 1–20；其他数量可设为 -1 表示不限、0 表示不开放。功能开关仅支持 0 或 1。</p><div className="field-grid two">{Object.entries(quotaNames).map(([key, label]) => <label className="field" key={key}><span>{label}</span><input type="number" {...quotaBounds(key)} step="1" required value={draft.entitlements[key] ?? 0} onChange={e => update({ entitlements: { ...draft.entitlements, [key]: e.target.value === '' ? '' : Number(e.target.value) } })} /></label>)}</div></details><button className="button primary" type="submit" disabled={!dirty || busy}>{busy ? '保存中…' : '保存套餐'}</button></form>;
}

function TicketEditor({ ticket, mutate, busy }) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState(ticket.status);
  const [message, setMessage] = useState('');
  const save = event => { event.preventDefault(); mutate(() => api.admin.updateTicket(ticket.id, { status, message: message.trim() }), '工单已更新').then(ok => { if (ok) setMessage(''); }); };
  return <article className="commerce-list-item"><button className="ticket-toggle" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span><strong>{ticket.subject}</strong><small>{ticketCategories[ticket.category]} · {ticket.userEmail || ticket.displayName} · {date(ticket.updatedAt || ticket.createdAt)}</small></span><span className={`commerce-status ${ticket.status}`}>{ticketStatuses[ticket.status]}</span><Icon name="chevronDown" size={18} /></button>{expanded && <div className="ticket-detail"><small className="commerce-caption">工单号 {ticket.id}</small>{ticket.jobId && <Link className="commerce-text-link" to={`/jobs/${encodeURIComponent(ticket.jobId)}`}>打开关联岗位</Link>}<TicketConversation ticket={ticket} /><form className="commerce-review" onSubmit={save}><label className="field"><span>处理状态</span><select value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(ticketStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="field"><span>回复用户</span><textarea maxLength={5000} value={message} onChange={e => setMessage(e.target.value)} placeholder="告知处理结果和下一步操作" /></label><button className="button primary" type="submit" disabled={busy || (!message.trim() && status === ticket.status)}>{busy ? '保存中…' : '发送回复并更新状态'}</button></form></div>}</article>;
}

function Tickets({ tickets, mutate, busy }) {
  const [status, setStatus] = useState('');
  const visible = tickets.filter(ticket => !status || ticket.status === status);
  return <><div className="commerce-toolbar"><label className="field"><span>工单状态</span><select value={status} onChange={e => setStatus(e.target.value)}><option value="">全部工单</option>{Object.entries(ticketStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><span className="commerce-caption">{visible.length} 条记录</span></div>{visible.length ? <div className="commerce-list">{visible.map(ticket => <TicketEditor key={ticket.id} ticket={ticket} mutate={mutate} busy={busy} />)}</div> : <EmptyState title="暂无待展示的工单" icon="send" description="用户提交的岗位纠错、会员咨询与建议会出现在这里。" />}</>;
}

function Audit({ items }) {
  const [query, setQuery] = useState('');
  const filtered = items.filter(item => `${item.actorEmail} ${item.action} ${item.targetId}`.toLowerCase().includes(query.toLowerCase()));
  return <><label className="field commerce-search"><span>搜索操作记录</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="操作人、动作或目标编号" /></label>{filtered.length ? <div className="commerce-table-scroll"><table className="commerce-table audit-table"><caption className="sr-only">管理员操作审计记录</caption><thead><tr><th>时间 / 操作人</th><th>操作</th><th>目标与变更详情</th></tr></thead><tbody>{filtered.map(item => <tr key={item.id}><td><strong>{date(item.createdAt)}</strong><small>{item.actorEmail || item.actorId || '系统'}</small></td><td>{item.action}</td><td><span>{item.targetType} · {item.targetId}</span><details><summary>查看详情</summary><pre>{JSON.stringify(item.detail, null, 2)}</pre></details></td></tr>)}</tbody></table></div> : <EmptyState title="没有符合条件的操作记录" icon="document" />}</>;
}

export function AdminConsolePage() {
  const { user } = useAuth();
  const online = useOnline();
  const [params, setParams] = useSearchParams();
  const tab = tabs.some(item => item.id === params.get('tab')) ? params.get('tab') : 'overview';
  const setTab = value => setParams(value === 'overview' ? {} : { tab: value });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const viewVersion = useRef(0);
  const load = useCallback(async (signal, expectedVersion = viewVersion.current) => {
    const fetcher = { overview: api.admin.overview, orders: api.admin.orders, plans: api.admin.plans, support: api.admin.tickets, audit: api.admin.audit }[tab];
    const result = await fetcher(signal);
    if (!signal?.aborted && expectedVersion === viewVersion.current) setData(result);
  }, [tab]);
  useEffect(() => {
    if (user?.role !== 'admin') return;
    const version = ++viewVersion.current;
    const controller = new AbortController(); setLoading(true); setLoadingMore(false); setError(''); setNotice(''); setData(null);
    load(controller.signal, version).catch(e => { if (e.name !== 'AbortError' && version === viewVersion.current) setError(e.message); }).finally(() => { if (!controller.signal.aborted && version === viewVersion.current) setLoading(false); });
    return () => { controller.abort(); viewVersion.current += 1; };
  }, [load, user?.role]);
  const reload = async () => { const version = viewVersion.current; setLoading(true); setError(''); try { await load(undefined, version); } catch (e) { if (version === viewVersion.current) setError(e.message); } finally { if (version === viewVersion.current) setLoading(false); } };
  const more = async () => {
    const version = viewVersion.current;
    setLoadingMore(true); setError('');
    try {
      const key = { orders: 'orders', support: 'tickets', audit: 'items' }[tab];
      const fetcher = { orders: api.admin.orders, support: api.admin.tickets, audit: api.admin.audit }[tab];
      const next = await fetcher(undefined, { cursor: data.nextCursor });
      if (version === viewVersion.current) setData(current => ({ ...next, [key]: [...(current?.[key] || []), ...next[key]] }));
    } catch (e) { if (version === viewVersion.current) setError(e.message); } finally { if (version === viewVersion.current) setLoadingMore(false); }
  };
  const mutate = async (operation, success) => {
    if (busy || !online) return false;
    const version = viewVersion.current;
    setBusy(true); setError(''); setNotice('');
    try { await operation(); if (version === viewVersion.current) { await load(undefined, version); if (version === viewVersion.current) setNotice(success); } return true; } catch (e) { if (version === viewVersion.current) setError(e.message); return false; } finally { setBusy(false); }
  };
  if (user?.role !== 'admin') return <div className="page"><EmptyState title="此页面仅对管理员开放" description="你可以继续使用自己的岗位、学习和会员功能。" icon="lock" action={<Link className="button primary" to="/">返回首页</Link>} /></div>;
  return <div className="page commercial-admin"><header className="page-header"><div><h1>管理后台</h1><p>处理会员、服务用户，并掌握平台运行中的真实业务数据。</p></div><div className="commerce-actions"><a className="button secondary" href={operationsUrl} title="采集工作台使用独立的授权和数据；来源登录与 AI 设置仍需原工作台授权。"><Icon name="building" size={17} />独立采集工作台</a><button className="button secondary" onClick={reload} type="button" disabled={loading || busy}><Icon name="refresh" size={17} />刷新</button></div></header>
    <nav className="commerce-admin-nav" aria-label="后台导航">{tabs.map(item => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>{item.label}</button>)}<Link to="/admin/users">用户与授权</Link><Link to="/admin/content">题库内容</Link></nav>
    {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="form-success" role="status"><Icon name="checkCircle" size={17} />{notice}</div>}
    {loading ? <LoadingState rows={5} /> : !data ? <ErrorState message={error} onRetry={reload} /> : <>{tab === 'overview' && <Overview overview={data.overview || {}} setTab={setTab} />}{tab === 'orders' && <Orders orders={listPayload(data, 'orders').items} mutate={mutate} busy={busy || !online} />}{tab === 'plans' && <><p className="inline-notice">价格单位为人民币元（1–10000 元），申请会保留提交时的价格与权益。已锁定权益的付费会员不受目录调整影响；免费版与未锁定的历史会员采用当前目录额度。</p><div className="admin-plan-list">{listPayload(data, 'plans').items.map(plan => <PlanEditor key={plan.id} plan={plan} mutate={mutate} busy={busy || !online} />)}</div></>}{tab === 'support' && <Tickets tickets={listPayload(data, 'tickets').items} mutate={mutate} busy={busy || !online} />}{tab === 'audit' && <Audit items={listPayload(data, 'items').items} />}{data.nextCursor && <div className="commerce-pagination"><span className="commerce-caption">共 {data.total} 条；筛选搜索作用于已加载记录</span><button type="button" className="button secondary" disabled={loadingMore || busy} onClick={more}>{loadingMore ? '加载中…' : '加载更多记录'}</button></div>}</>}
  </div>;
}
