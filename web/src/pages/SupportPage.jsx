import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { api, listPayload } from '../lib/api';
import { useOnline } from '../hooks/useOnline';

export const ticketCategories = { account: '账号与使用', billing: '会员与订单', job_correction: '岗位纠错', suggestion: '功能建议', other: '其他问题' };
export const ticketStatuses = { open: '待处理', in_progress: '处理中', resolved: '已解决' };
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';

export function TicketConversation({ ticket }) {
  return <div className="ticket-conversation" aria-label="沟通记录">{(ticket.messages || []).map((message, index) => <article className={`ticket-message ${message.authorRole === 'admin' ? 'staff' : ''}`} key={message.id || index}><header><strong>{message.authorRole === 'admin' ? '平台客服' : '用户'}</strong><time>{date(message.createdAt)}</time></header><p>{message.message}</p></article>)}</div>;
}

function TicketCard({ ticket, onUpdate, online }) {
  const [expanded, setExpanded] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const send = async event => {
    event.preventDefault(); if (!reply.trim() || busy) return;
    setBusy(true); setError('');
    try { const data = await api.support.reply(ticket.id, reply.trim()); onUpdate(data.ticket); setReply(''); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  return <article className="commerce-list-item"><button type="button" className="ticket-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span><strong>{ticket.subject}</strong><small>{ticketCategories[ticket.category]} · {date(ticket.createdAt)}</small></span><span className={`commerce-status ${ticket.status}`}>{ticketStatuses[ticket.status] || ticket.status}</span><Icon name="chevronDown" size={18} /></button>
    {expanded && <div className="ticket-detail"><small className="commerce-caption">工单号 {ticket.id}</small>{ticket.jobId && <Link className="commerce-text-link" to={`/jobs/${encodeURIComponent(ticket.jobId)}`}>查看关联岗位 <Icon name="external" size={14} /></Link>}<TicketConversation ticket={ticket} />
      <form onSubmit={send}><label className="field"><span>补充信息{ticket.status === 'resolved' ? '（回复后将重新打开工单）' : ''}</span><textarea value={reply} onChange={event => setReply(event.target.value)} maxLength={5000} required placeholder="继续补充问题的情况" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="button secondary" type="submit" disabled={!reply.trim() || busy || !online}>{busy ? '发送中…' : '发送补充'}</button></form>
    </div>}
  </article>;
}

export function SupportPage() {
  const [params] = useSearchParams();
  const online = useOnline();
  const [tickets, setTickets] = useState(null);
  const [form, setForm] = useState(() => ({ category: ticketCategories[params.get('category')] ? params.get('category') : params.get('jobId') ? 'job_correction' : 'account', subject: params.get('questionId') ? '题目纠错' : '', message: params.get('questionId') ? `题目编号：${params.get('questionId').slice(0, 200)}\n问题描述与核对依据：\n` : '', jobId: params.get('jobId') || '' }));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState({ nextCursor: '', total: 0 });
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(async signal => { const result = await api.support.list(signal); setTickets(listPayload(result, 'tickets').items); setPage({ nextCursor: result.nextCursor, total: result.total }); }, []);
  useEffect(() => { const controller = new AbortController(); load(controller.signal).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [load]);
  const submit = async event => {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { const data = await api.support.create({ ...form, jobId: form.category === 'job_correction' ? form.jobId.trim() : undefined }); setTickets(items => [data.ticket, ...(items || [])]); setForm(current => ({ ...current, subject: '', message: '' })); setNotice('反馈已提交，可以在“我的工单”查看回复并补充信息。'); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const update = ticket => setTickets(items => items.map(item => item.id === ticket.id ? ticket : item));
  const more = async () => { setLoadingMore(true); try { const result = await api.support.list(undefined, { cursor: page.nextCursor }); setTickets(items => [...items, ...result.tickets]); setPage({ nextCursor: result.nextCursor, total: result.total }); } catch (e) { setError(e.message); } finally { setLoadingMore(false); } };
  return <div className="page support-page"><header className="page-header"><div><h1>帮助与反馈</h1><p>岗位信息有误、会员申请有疑问，或希望产品变得更好，都可以在这里告诉我们。</p></div><Link className="button secondary" to="/pricing"><Icon name="crown" size={17} />会员权益</Link></header>
    <div className="support-layout"><form className="commerce-panel support-create" onSubmit={submit}><h2>提交反馈</h2><p className="commerce-caption">只会向你的账户和负责处理的管理员展示。请勿发送账号密码、API Key 或银行卡信息。</p><label className="field"><span>问题类型</span><select value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>{Object.entries(ticketCategories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="field"><span>标题</span><input required maxLength={160} value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} placeholder="一句话描述你的问题" /></label>{form.category === 'job_correction' && <label className="field"><span>岗位编号（选填）</span><input value={form.jobId} maxLength={200} onChange={e => setForm({ ...form, jobId: e.target.value })} placeholder="可以从岗位详情页带入" /></label>}<label className="field"><span>详细说明</span><textarea required maxLength={5000} rows={6} value={form.message} onChange={e => setForm({ ...form, message: e.target.value })} placeholder="请描述发生了什么、期望的结果，或提供可核对的信息来源。" /></label>{error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="form-success" role="status"><Icon name="checkCircle" size={18} />{notice}</div>}<button className="button primary" type="submit" disabled={busy || !online || !form.subject.trim() || !form.message.trim()}>{busy ? '提交中…' : '提交反馈'}</button></form>
    <section className="support-history"><div className="section-title-row"><h2>我的工单</h2><span className="commerce-caption">{tickets?.length || 0} 条</span></div>{loading ? <LoadingState rows={3} /> : tickets === null ? <ErrorState message={error} onRetry={() => load().catch(e => setError(e.message))} /> : tickets.length ? <div className="commerce-list">{tickets.map(ticket => <TicketCard key={ticket.id} ticket={ticket} onUpdate={update} online={online} />)}</div> : <EmptyState icon="send" title="暂时没有工单" description="提交后可以在这里追踪处理进度，继续回复也会保留在同一条记录中。" />}{page.nextCursor && <div className="commerce-pagination"><span className="commerce-caption">共 {page.total} 条工单</span><button type="button" className="button secondary" disabled={loadingMore} onClick={more}>{loadingMore ? '加载中…' : '加载更多工单'}</button></div>}</section></div>
    <section className="commerce-faq"><h2>常见问题</h2><details><summary>会员会自动扣费吗？</summary><p>当前会员采用人工核验开通，提交申请不会扣款。套餐到期不会自动续费；你的收藏和投递记录会保留。</p></details><details><summary>岗位信息和薪资由谁提供？</summary><p>岗位来自平台采集的信息源，实际招聘要求、薪资与截止时间以雇主原始页面为准。发现错误可以选择“岗位纠错”，我们会核对来源。</p></details><details><summary>如何申请退款或处理开通问题？</summary><p>选择“会员与订单”并填写申请编号、具体诉求与可核对信息。平台会在本工单中反馈处理结果，请勿提交银行卡完整卡号。</p></details></section>
  </div>;
}
