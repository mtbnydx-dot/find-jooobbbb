import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { Button, Company, Empty, Field, Meta, Notice, Sheet, TopBar } from '../components/UI';
import Icon from '../components/Icon';
import { api } from '../lib/api';
import { useMobile, useResource } from '../lib/runtime';
import { useJobAction } from '../lib/use-job-action';
import { companyName, EDITABLE_STAGES, formatDateTime, jobDeadlineLabel, jobTitle, progressDraft, progressPatch, stageLabel, STAGES, toLocalDateTime } from '../lib/job-tools';
import './jobs.css';

export function ProgressEditor({ job, onClose }) {
  const { notify, user } = useMobile();
  const owner = useRef(user?.id), initial = useRef(progressDraft(job.userState || {}));
  const [draft, setDraft] = useState(() => ({ ...initial.current, followUpAt: toLocalDateTime(initial.current.followUpAt), appliedAt: toLocalDateTime(initial.current.appliedAt) }));
  const [validation, setValidation] = useState('');
  const { run, busy, error } = useJobAction();
  useEffect(() => { if (user?.id !== owner.current) onClose(); }, [user?.id, onClose]);
  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const save = async () => {
    setValidation('');
    let patch;
    try { patch = progressPatch(initial.current, draft); }
    catch (failure) { setValidation(failure.message); return; }
    if (!Object.keys(patch).length) { onClose(); return; }
    await run(job.id, patch, () => { notify('求职进度已保存'); onClose(); });
  };
  return <Sheet title={`更新进度 · ${companyName(job)}`} onClose={() => { if (!busy) onClose(); }} footer={<Button disabled={busy} onClick={save}>{busy ? '保存中…' : '保存进度'}</Button>}>
    <Field label="当前阶段"><select value={draft.status} onChange={event => update('status', event.target.value)}>{draft.status === 'saved' && <option value="saved">已收藏（旧记录）</option>}{EDITABLE_STAGES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field>
    <Field label="下一步行动"><input value={draft.nextAction} maxLength={500} placeholder="例如：补充作品集，联系招聘方" onChange={event => update('nextAction', event.target.value)} /></Field>
    <Field label="实际投递时间（可留空）" hint="仅记录你已经完成的投递；修改阶段不会自动生成投递时间。"><input type="datetime-local" value={draft.appliedAt} onChange={event => update('appliedAt', event.target.value)} /></Field>
    <Field label="下次跟进时间（可留空）" hint="按本设备当地时区输入；清空可移除跟进时间。"><input type="datetime-local" value={draft.followUpAt} onChange={event => update('followUpAt', event.target.value)} /></Field>
    <Field label="私人备注"><textarea value={draft.note} maxLength={8000} onChange={event => update('note', event.target.value)} /></Field>
    <Notice>进度由你维护，不代表招聘方已接收或反馈。跟进时间会保存到账号；是否发送通知取决于你启用的渠道及服务配置。</Notice>
    {validation || error ? <p className="job-error" role="alert">{validation || error}</p> : null}
  </Sheet>;
}

const primaryTabs = [['saved', '收藏'], ['applied', '已投递'], ['interview', '面试'], ['offer', 'Offer']];
export default function Progress() {
  const [params, setParams] = useSearchParams(), location = useLocation();
  const requestedTab = params.get('tab');
  const tab = requestedTab === 'all' || requestedTab === 'saved' || Object.hasOwn(STAGES, requestedTab) ? requestedTab : 'saved';
  const [editing, setEditing] = useState(null);
  const { user } = useMobile();
  const resource = useResource(signal => api.pipeline.get(signal), []);
  const items = resource.data?.items || resource.data?.pipeline?.items || [];
  const list = items.filter(job => tab === 'all' || (tab === 'saved' ? job.userState?.saved : job.userState?.status === tab));
  const upcoming = items.filter(job => job.userState?.followUpAt).sort((a, b) => Date.parse(a.userState.followUpAt) - Date.parse(b.userState.followUpAt))[0];
  useEffect(() => { setEditing(null); }, [user?.id]);
  return <><TopBar /><main className="page pipeline-page live-jobs"><h1>每一步，都算数</h1><p className="page-subtitle">把机会推进成结果</p>
    <div className="stage-tabs">{primaryTabs.map(([value, label]) => <button key={value} className={tab === value ? 'selected' : ''} onClick={() => setParams({ tab: value })}>{label}</button>)}</div>
    <label className="pipeline-stage-select">其他阶段<select aria-label="进度阶段" value={tab} onChange={event => setParams({ tab: event.target.value })}><option value="all">全部记录</option><option value="saved">收藏</option>{Object.entries(STAGES).filter(([value]) => !['saved', 'ignored', 'not_applied'].includes(value)).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
    {upcoming && <button className="reminder-strip" onClick={() => setEditing(upcoming)}><Icon name="clock" /><span><strong>{Date.parse(upcoming.userState.followUpAt) < Date.now() ? '已到跟进时间' : formatDateTime(upcoming.userState.followUpAt)}</strong> · {companyName(upcoming)}</span><Icon name="chevron" size={20} /></button>}
    {resource.error && <Notice tone="amber">{resource.error.message}<button className="text-link" onClick={resource.reload}>重新加载</button></Notice>}
    {resource.loading && !resource.data ? <p className="loading-text" role="status">正在读取求职进度…</p> : list.length ? <div className="job-list">{list.map(job => <article className="job-card progress-card" key={job.id}><Company job={job}><span className="tag">{stageLabel(job.userState)}</span></Company><Link to={`/jobs/${encodeURIComponent(job.id)}`} state={{ returnTo: location.pathname + location.search }}><h2>{jobTitle(job)}</h2></Link><Meta job={job} />{job.available === false && <p className="job-risk">已下线 · 历史记录</p>}<p className="caption job-deadline">{jobDeadlineLabel(job)}</p><div className="progress-card-footer"><div><p><Icon name="file" size={20} />{job.userState?.appliedAt ? `${formatDateTime(job.userState.appliedAt)} 投递` : '未记录投递时间'}</p><p><Icon name="flag" size={20} />下一步：{job.userState?.nextAction || '待安排'}</p>{job.userState?.followUpAt && <p><Icon name="clock" size={20} />{formatDateTime(job.userState.followUpAt)} 跟进</p>}</div><button className="update-button" onClick={() => setEditing(job)}>更新进度 <Icon name="chevron" size={17} /></button></div></article>)}</div> : !resource.error && <Empty icon="clipboard" title={tab === 'saved' ? '收藏你的下一个机会' : '这个阶段还没有岗位'} message="从发现岗位开始，收藏后可在这里安排下一步。" />}
    <p className="progress-disclaimer"><Icon name="info" size={14} />进度由你维护，不代表招聘方已反馈</p>
  </main>{editing && <ProgressEditor key={`${user?.id}:${editing.id}`} job={editing} onClose={() => setEditing(null)} />}</>;
}
