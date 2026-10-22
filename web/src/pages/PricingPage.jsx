import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { api, listPayload, request } from '../lib/api';
import { TransactionLedger } from '../components/TransactionLedger';
import { useOnline } from '../hooks/useOnline';

const periods = [{ id: 'month', label: '30 天' }, { id: 'quarter', label: '90 天' }, { id: 'year', label: '365 天' }];
const quotaRows = [
  ['profile.majors', '专业方向'], ['prep.tracks', '备考路径'], ['prep.attempts.daily', '每日练习次数'],
  ['savedSearches.limit', '保存搜索条件'], ['offers.limit', 'Offer 对比记录'], ['studyPlans.limit', '学习计划'], ['salary.insights', '岗位库薪酬洞察'],
];
const statusLabels = { pending: '待审核', approved: '已开通', rejected: '未通过', cancelled: '已取消' };
const money = (amount, currency = 'CNY') => new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount || 0) / 100);
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const quota = (value, key) => key === 'salary.insights' ? (value ? '包含' : '不包含') : value < 0 ? '不限' : value ?? '—';

export function PricingPage() {
  const online = useOnline();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [termId, setTermId] = useState('quarter');
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [payment, setPayment] = useState(null);
  useEffect(() => { const controller = new AbortController(); request('/billing/status', { signal: controller.signal }).then(setPayment).catch(() => {}); return () => controller.abort(); }, []);
  const requestKey = useRef('');
  const requestPanel = useRef(null);
  const load = useCallback(async signal => {
    const [plans, entitlements, orders, tracks] = await Promise.all([api.billing.plans(signal), api.billing.entitlements(signal), api.billing.orders(signal), api.prep.tracks(signal)]);
    setData({ plans: listPayload(plans, 'plans').items, content: plans.content, bonusTracks: listPayload(tracks, 'tracks').items.filter(track => track.freeAccess), entitlements, orders: listPayload(orders, 'orders').items, ordersNextCursor: orders.nextCursor, ordersTotal: orders.total, mode: plans.purchaseMode });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);
  const retry = async () => { setLoading(true); setError(''); try { await load(); } catch (e) { setError(e.message); } finally { setLoading(false); } };
  const choose = (plan, term) => {
    setSelected({ plan, term }); setNote(''); setConfirmed(false); setError(''); setNotice('');
    requestKey.current = crypto.randomUUID();
    requestAnimationFrame(() => requestPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  };
  const submit = async event => {
    event.preventDefault();
    if (!selected || !confirmed || busy) return;
    setBusy('request'); setError('');
    try {
      await api.billing.request({ planId: selected.plan.id, termId: selected.term.id, note: note.trim(), idempotencyKey: requestKey.current });
      setSelected(null); setNotice('会员申请已提交。审核和开通进度会显示在下方；此操作没有扣款。');
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const cancel = async id => {
    setBusy(id); setError(''); setNotice('');
    try { await api.billing.cancel(id); await load(); setNotice('已取消这条会员申请。'); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const moreOrders = async () => { setLoadingMore(true); try { const page = await api.billing.orders(undefined, { cursor: data.ordersNextCursor }); setData(current => ({ ...current, orders: [...current.orders, ...page.orders], ordersNextCursor: page.nextCursor, ordersTotal: page.total })); } catch (e) { setError(e.message); } finally { setLoadingMore(false); } };
  if (loading) return <div className="page"><LoadingState rows={5} label="正在加载会员权益" /></div>;
  if (!data) return <div className="page"><ErrorState message={error} onRetry={retry} /></div>;
  const current = data.entitlements.plan;
  const expiry = current?.subscription?.currentPeriodEnd || current?.currentPeriodEnd;
  const attempts = data.entitlements.values?.['prep.attempts.daily'];
  const validity = current?.subscription?.status === 'expired'
    ? `上一套餐已于 ${date(expiry)} 到期，当前使用免费权益`
    : expiry ? `有效至 ${date(expiry)}，到期后恢复免费权益`
    : current?.id && current.id !== 'free' ? '当前为长期人工授权，续期前请联系平台确认期限' : '免费权益持续可用';
  return <div className="page membership-page">
    <header className="page-header"><div><Link to="/profile" className="back-link"><Icon name="arrowLeft" size={17} />返回我的</Link><h1>把时间留给更值得的机会</h1><p>岗位搜索、原始申请链接和基本投递管理免费。需要系统练习、保存筛选和对比决策时，再选择会员。</p></div></header>
    <section className="membership-current" aria-label="当前会员权益">
      <span className="membership-symbol"><Icon name="crown" size={28} /></span><div><span>当前套餐</span><h2>{current?.name || '免费版'}</h2><p>{validity}</p>{current?.subscription?.entitlementsLocked && <small>已开通权益已锁定，不受套餐目录后续调整影响。</small>}</div>
      {attempts && <div className="membership-usage"><strong>{attempts.used} <span>/ {attempts.limit < 0 ? '不限' : attempts.limit}</span></strong><small>今日已完成练习</small></div>}
    </section>
    {error && <div className="form-error" role="alert">{error}</div>}
    {notice && <div className="form-success" role="status"><Icon name="checkCircle" size={18} />{notice}</div>}
    {payment && <p className="inline-notice">支付渠道：{payment.message}。当前页面的会员申请不会扣款，付款及退款问题请通过工单联系平台。</p>}
    <div className="membership-period-row"><div className="commerce-segments" role="group" aria-label="会员时长">{periods.map(item => <button type="button" key={item.id} aria-pressed={termId === item.id} onClick={() => setTermId(item.id)}>{item.label}</button>)}</div><span>一次开通 · 到期不自动续费</span></div>
    <section className="membership-plans" aria-label="会员套餐">
      {data.plans.map(plan => {
        const term = plan.terms?.find(item => item.id === termId);
        const free = plan.id === 'free';
        const active = current?.id === plan.id;
        const requestable = plan.availableForRequest && Boolean(term);
        return <article key={plan.id} className={`membership-plan${plan.id === 'pro' ? ' preferred' : ''}`}>
          <div className="membership-plan-title"><h2>{plan.name}</h2>{active && <span className="commerce-status approved">当前套餐</span>}</div>
          <p>{plan.tagline || plan.description}</p>
          <div className="membership-price"><strong>{free ? '免费' : term ? money(term.price, plan.currency) : '暂未开放'}</strong>{!free && term && <span>/ {term.days} 天</span>}</div>
          <small>{free ? '长期使用，不设试用倒计时' : term ? `约 ${money(term.price / term.days, plan.currency)} / 天；以整期金额开通` : '此周期暂不提供申请'}</small>
          <ul>{(plan.features || []).map(feature => <li key={typeof feature === 'string' ? feature : feature.label}><Icon name="check" size={16} />{typeof feature === 'string' ? feature : feature.label}</li>)}</ul>
          <p className="commerce-caption">当前试运行个人 AI 额度：{plan.aiDailyLimit ?? '—'} 岗位 / 日{!plan.aiServiceConfigured && '（服务未就绪）'}。额度随 AI 服务设置调整，不属于锁定的付费权益。</p>
          {free ? <Link className="button secondary full" to="/jobs">继续找岗位</Link> : <button className={`button full ${plan.id === 'pro' ? 'primary' : 'secondary'}`} type="button" disabled={!requestable || !online || Boolean(busy)} onClick={() => choose(plan, term)}>{requestable ? active ? '申请续期' : `申请${plan.name}` : '暂未开放申请'}</button>}
        </article>;
      })}
    </section>
    <p className="commerce-caption">当前采用人工审核开通。提交申请不会扣款，付款与核验方式由平台在反馈工单中说明。会员不包含真人辅导，不承诺面试或录用结果。</p>
    <p className="commerce-caption">个人 AI 每日额度按当前服务设置展示，实际剩余额度和可用状态请查看 <Link to="/jobs?view=ai">AI 推荐</Link>；服务未就绪时不会发起模型评估。</p>
    {data.content && <p className="inline-notice membership-content-inventory">当前已发布 {data.content.tracks} 条备考路径、{data.content.questions} 道题目（{data.content.source}）。每日练习额度包含重复练习，不代表每天提供同等数量的新题。{data.content.grading}。</p>}
    {data.bonusTracks?.length > 0 && <p className="inline-notice">另赠送免费体验路径：{data.bonusTracks.map(track => track.title || track.name).join('、')}。不占套餐的原有路径名额，仍与其他练习共用每日答题次数。<Link to="/prep?examType=xingce">进入行测练习</Link></p>}
    {selected && <form ref={requestPanel} className="commerce-panel membership-request" onSubmit={submit}>
      <div className="section-title-row"><div><h2>确认会员申请</h2><p>{selected.plan.name} · {selected.term.days} 天 · {money(selected.term.price, selected.plan.currency)}</p></div><button type="button" className="icon-button" aria-label="关闭会员申请" disabled={Boolean(busy)} onClick={() => setSelected(null)}><Icon name="close" /></button></div>
      <label className="field"><span>补充说明（选填）</span><textarea maxLength={1000} value={note} onChange={event => setNote(event.target.value)} placeholder="例如你的求职周期、需要了解的权益。请勿填写密码或银行卡信息。" /></label>
      <label className="commerce-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} required /><span>我已核对套餐、时长和金额，理解本次仅提交申请，人工审核通过后才会开通；不自动续费。</span></label>
      <div className="commerce-actions"><button className="button primary" disabled={!confirmed || !online || Boolean(busy)} type="submit">{busy === 'request' ? '提交中…' : '提交会员申请'}</button><Link to="/support?category=billing" className="button secondary">咨询开通与退款</Link></div>
    </form>}
    <section className="commerce-section"><div className="section-title-row"><div><h2>权益一览</h2><p>额度以当前账户与套餐目录为准，升级不改变你的已有投递记录。</p></div></div><div className="commerce-table-scroll"><table className="commerce-table"><caption className="sr-only">各会员套餐的权益对比</caption><thead><tr><th scope="col">功能</th>{data.plans.map(plan => <th key={plan.id} scope="col">{plan.name}</th>)}</tr></thead><tbody><tr><th scope="row">岗位浏览、申请链接、投递管理</th>{data.plans.map(plan => <td key={plan.id}>免费包含</td>)}</tr>{quotaRows.map(([key, label]) => <tr key={key}><th scope="row">{label}</th>{data.plans.map(plan => <td key={plan.id}>{quota(plan.entitlements?.[key], key)}</td>)}</tr>)}</tbody></table></div></section>
    <section className="commerce-section"><div className="section-title-row"><div><h2>我的申请记录</h2><p>查看审核结果和实际开通时间。申请金额不是已收款凭证。</p></div><button className="button secondary" type="button" onClick={retry} disabled={Boolean(busy)}><Icon name="refresh" size={16} />刷新</button></div>
      {!data.orders.length ? <EmptyState title="还没有会员申请" description="先免费体验，需要更多额度时再开通。" icon="crown" /> : <div className="commerce-list">{data.orders.map(order => <article className="commerce-list-item" key={order.id}><div className="commerce-item-heading"><div><h3>{order.planName} · {order.termLabel || `${order.days} 天`}</h3><small>{date(order.createdAt)} · 申请号 {order.id}</small></div><span className={`commerce-status ${order.status}`}>{statusLabels[order.status] || order.status}</span></div><p className="commerce-order-amount">申请金额 {money(order.amount, order.currency)}</p>{order.reviewNote && <p className="commerce-response">处理说明：{order.reviewNote}</p>}{order.currentPeriodEnd && <p>开通有效至 {date(order.currentPeriodEnd)}</p>}<div className="commerce-actions">{order.status === 'pending' && <button className="button secondary" type="button" disabled={Boolean(busy) || !online} onClick={() => cancel(order.id)}>{busy === order.id ? '取消中…' : '取消申请'}</button>}<Link className="commerce-text-link" to="/support?category=billing">订单咨询</Link></div></article>)}</div>}
      {data.ordersNextCursor && <div className="commerce-pagination"><span className="commerce-caption">已加载 {data.orders.length} / {data.ordersTotal} 条申请</span><button type="button" className="button secondary" disabled={loadingMore} onClick={moreOrders}>{loadingMore ? '加载中…' : '加载更多申请'}</button></div>}
    </section>
    <TransactionLedger />
  </div>;
}
