import { useCallback, useEffect, useRef, useState } from 'react';
import { request, newRequestKey } from '../lib/api';
const money = (value, currency = 'CNY') => new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(Number(value || 0) / 100);
const states = { pending: '待确认', succeeded: '已核验到账', failed: '未成功', partially_refunded: '部分已退款', refunded: '已全额退款' };
export function TransactionLedger({ admin = false }) {
  const [page, setPage] = useState({ transactions: [], total: 0, nextCursor: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const key = useRef('');
  const base = admin ? '/admin/transactions' : '/me/transactions';
  const load = useCallback(async (cursor = '', signal) => { const result = await request(`${base}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal }); if (!signal?.aborted) setPage(current => ({ ...result, transactions: cursor ? [...current.transactions, ...result.transactions] : result.transactions })); }, [base]);
  useEffect(() => { const controller = new AbortController(); load('', controller.signal).catch(err => { if (err.name !== 'AbortError') setError(err.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, [load]);
  const refund = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await request(`${base}/${encodeURIComponent(form.id)}/refunds`, { method: 'POST', body: { amount: Math.round(Number(form.yuan) * 100), reference: form.reference, reason: form.reason, idempotencyKey: key.current } }); setForm(null); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <section className="commerce-panel"><h2>交易与退款记录</h2><p>独立保留核验交易和退款凭据。人工核验不代表平台完成支付渠道扣款。</p>{error && <div className="form-error" role="alert">{error}</div>}{loading ? <p>正在读取交易…</p> : !page.transactions.length ? <p>暂无交易记录。</p> : page.transactions.map(item => <article className="ai-run" key={item.id}><div><strong>{money(item.amount, item.currency)} · {states[item.status] || item.status}</strong><p>{item.planId} · {item.days} 天 · {item.provider === 'manual' ? '人工核验' : item.provider}</p><small>{item.id}{admin && ` · 用户 ${item.userId}`}</small><p>已记录退款 {money(item.refundedAmount, item.currency)}</p>{item.refunds?.map(refund => <p key={refund.id}>退款 {money(refund.amount, item.currency)} · {refund.reason} · 凭据 {refund.reference}</p>)}</div>{admin && ['succeeded', 'partially_refunded'].includes(item.status) && <button className="button secondary" onClick={() => { key.current = newRequestKey(); setForm({ id: item.id, yuan: ((item.amount - item.refundedAmount) / 100).toFixed(2), max: (item.amount - item.refundedAmount) / 100, reference: '', reason: '', confirmed: false }); }}>登记已完成退款</button>}</article>)}
    {form && <form className="commerce-review" onSubmit={refund}><h3>仅登记已经在外部完成的退款</h3><p>此操作不会打款。全额退款会撤销对应购买权益，部分退款保留权益。</p><label className="field"><span>已退金额（元）</span><input type="number" min="0.01" max={form.max} step="0.01" required value={form.yuan} onChange={event => setForm(value => ({ ...value, yuan: event.target.value }))} /></label>{[['reference', '真实退款凭据编号'], ['reason', '原因与说明']].map(([field, label]) => <label className="field" key={field}><span>{label}</span><input required value={form[field]} onChange={event => setForm(value => ({ ...value, [field]: event.target.value }))} /></label>)}<label className="commerce-check"><input type="checkbox" required checked={form.confirmed} onChange={event => setForm(value => ({ ...value, confirmed: event.target.checked }))} /><span>已核对真实退款到账及凭据，确认只登记并同步权益。</span></label><div className="commerce-actions"><button className="button primary" disabled={busy || !form.confirmed}>{busy ? '处理中…' : '确认登记'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setForm(null)}>取消</button></div></form>}
    {page.nextCursor && <button className="button secondary" disabled={busy} onClick={() => { setBusy(true); load(page.nextCursor).catch(err => setError(err.message)).finally(() => setBusy(false)); }}>加载更多交易</button>}
  </section>;
}
