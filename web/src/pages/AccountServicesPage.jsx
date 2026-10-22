import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { request } from '../lib/api';
import { ErrorState, LoadingState } from '../components/StatusViews';
import { useOnline } from '../hooks/useOnline';

const deliveryStatus = { queued: '等待投递', sending: '投递中', sent: '已发送', failed: '失败', blocked: '未满足发送条件', skipped: '已跳过' };
export function AccountServicesPage() {
  const online = useOnline();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [file, setFile] = useState(null);
  const load = useCallback(async signal => {
    const [delivery, files] = await Promise.all([request('/me/delivery-status', { signal }), request('/me/attachments', { signal })]);
    if (!signal?.aborted) setData({ delivery, files });
  }, []);
  useEffect(() => { const controller = new AbortController(); load(controller.signal).catch(err => { if (err.name !== 'AbortError') setError(err.message); }); return () => controller.abort(); }, [load]);
  const perform = async (operation, success) => {
    setBusy(true); setError(''); setMessage('');
    try { await operation(); await load(); setMessage(success); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const upload = event => {
    event.preventDefault(); if (!file) return;
    if (file.size > data.files.limits.maxFileBytes) return setError('文件超过单个附件大小限制，请先压缩或精简。');
    void perform(async () => {
      const contentBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('文件读取失败')); reader.readAsDataURL(file); });
      await request('/me/attachments', { method: 'POST', body: { name: file.name, contentBase64 }, timeoutMs: 60000 }); setFile(null);
    }, '附件已保存到个人账户。PDF/Word 不会自动解析成画像，也不会发送给 AI。');
  };
  const download = async attachment => {
    setBusy(true); setError('');
    try { const blob = await request(`/me/attachments/${encodeURIComponent(attachment.id)}/download`, { responseType: 'blob', timeoutMs: 60000 }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = attachment.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000); setMessage('已请求浏览器下载；手机上请查看下载列表或系统文件应用。'); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  if (!data) return <div className="page">{error ? <ErrorState message={error} onRetry={() => load().catch(err => setError(err.message))} /> : <LoadingState rows={5} />}</div>;
  const { delivery, files } = data;
  return <div className="page account-services"><header className="page-header"><div><Link to="/profile">返回我的账户</Link><h1>通知与个人附件</h1><p>订阅状态、真实投递记录和仅本人可访问的求职资料。</p></div></header>{error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}
    <section className="commerce-panel"><h2>提醒渠道</h2><p>站内提醒始终可在通知面板查看；邮件和设备推送只有渠道配置完成且符合订阅条件时才会投递。</p><p>邮件：{delivery.channels.email.configured ? '已配置' : '未配置'} · 邮箱{delivery.channels.email.verified ? '已验证' : '未验证'}；设备推送：{delivery.channels.push.configured ? '已配置' : '未配置'}。</p>
      {[['emailEnabled', '接收邮件提醒', !delivery.channels.email.configured || !delivery.channels.email.verified], ['pushEnabled', '接收已注册设备推送', !delivery.channels.push.configured], ['savedSearchEnabled', '接收保存搜索的新岗位提醒', false]].map(([key, label, disabled]) => <label className="commerce-check" key={key}><input type="checkbox" checked={Boolean(delivery.preferences[key])} disabled={busy || !online || disabled} onChange={event => perform(() => request('/me/delivery-preferences', { method: 'PUT', body: { ...delivery.preferences, [key]: event.target.checked } }), '通知偏好已保存。')} /><span>{label}</span></label>)}
      <p className="commerce-caption">网页尚未注册系统推送设备，不会弹出未经实现的“已开启推送”。未验证邮箱可在“账号安全”中验证。</p>
      <h3>投递状态</h3>{delivery.outbox.length ? <ul>{delivery.outbox.map(item => <li key={`${item.channel}-${item.status}`}>{item.channel === 'email' ? '邮件' : '推送'} · {deliveryStatus[item.status] || item.status}：{item.count}</li>)}</ul> : <p>暂无投递记录。</p>}
      {delivery.devices.map(device => <div className="ai-run" key={device.id}><span>{device.label || device.provider}</span><button className="button secondary" disabled={busy || !online} onClick={() => perform(() => request(`/me/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' }), '设备订阅已移除。')}>移除设备订阅</button></div>)}
    </section>
    <section className="commerce-panel"><h2>简历与求职附件</h2><p>支持 {files.limits.types.join('、')}，单个文件最多 {Math.floor(files.limits.maxFileBytes / 1048576)} MB，最多 {files.limits.maxFiles} 个。TXT 可读取文字；PDF、Word 目前只存储和下载，不提供自动解析或 AI 简历评分。</p>
      <form className="commerce-actions" onSubmit={upload}><label className="field"><span>选择个人附件</span><input type="file" accept={files.limits.types.join(',')} onChange={event => setFile(event.target.files?.[0] || null)} disabled={busy} /></label><button className="button primary" disabled={busy || !online || !file}>{busy ? '处理中…' : '上传附件'}</button></form>
      {files.attachments.length ? files.attachments.map(attachment => <article className="ai-run" key={attachment.id}><div><strong>{attachment.name}</strong><p>{attachment.parseStatus === 'parsed_text' ? '已读取文字' : '仅存储文件 · 未解析'}</p></div><div className="commerce-actions"><button className="button secondary" disabled={busy || !online} onClick={() => download(attachment)}>下载</button><button className="button secondary" disabled={busy || !online} onClick={() => perform(async () => { const response = await request(`/me/attachments/${encodeURIComponent(attachment.id)}`); setPreview(response.attachment); }, '')}>查看状态</button><button className="button secondary" disabled={busy || !online} onClick={() => { if (window.confirm(`删除个人附件“${attachment.name}”？此操作不可撤回。`)) perform(() => request(`/me/attachments/${encodeURIComponent(attachment.id)}`, { method: 'DELETE' }), '附件已删除。'); }}>删除</button></div></article>) : <p>还没有个人附件。</p>}
      {preview && <div className="attachment-preview"><button className="button ghost" onClick={() => setPreview(null)}>关闭预览</button><h3>{preview.name}</h3><p>{preview.parseMessage}</p>{preview.text && <pre>{preview.text}</pre>}{preview.textTruncated && <p>预览已截断，请下载原文件查看全部内容。</p>}</div>}
    </section>
  </div>;
}
