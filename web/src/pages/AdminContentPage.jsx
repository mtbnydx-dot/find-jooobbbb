import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { useAuth } from '../context/AuthContext';
import { request } from '../lib/api';
import '../styles/content-admin.css';

const statusLabels = { draft: '草稿', published: '已发布', retired: '已下架' };
const typeLabels = { single: '单选题', multi: '多选题', short: '简答题' };
const actionLabels = { import: '导入现有内容', create: '创建草稿', edit: '保存草稿', publish: '发布', retire: '下架' };
const basePath = '/admin/content/questions';
const emptyDraft = trackId => ({ trackId, type: 'single', difficulty: '基础', prompt: '', options: [], answer: '',
  explanation: '', sourceType: 'original', sourceUrl: '', author: '', licenseNote: '', rightsConfirmed: false });
const toForm = draft => ({ ...draft, optionsText: (draft.options || []).join('\n'),
  answerText: draft.type === 'multi' ? (draft.answer || []).join('\n') : draft.type === 'short' ? draft.answer?.sample || '' : draft.answer || '',
  keywordsText: draft.type === 'short' ? (draft.answer?.keywords || []).join('，') : '' });
const fromForm = form => ({ ...form, options: form.type === 'short' ? [] : form.optionsText.split('\n').map(value => value.trim()).filter(Boolean),
  answer: form.type === 'short' ? { sample: form.answerText, keywords: form.keywordsText.split(/[,，\n]/).map(value => value.trim()).filter(Boolean) }
    : form.type === 'multi' ? form.answerText.split('\n').map(value => value.trim()).filter(Boolean) : form.answerText });
const dateLabel = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
const answerLabel = (type, answer) => type === 'short' ? `${answer?.sample || ''}\n评分关键词：${(answer?.keywords || []).join('、')}`
  : Array.isArray(answer) ? answer.join('、') : answer;

export function AdminContentPage() {
  const { user } = useAuth();
  const allowed = ['admin', 'content_editor'].includes(user?.role);
  const [data, setData] = useState({ items: [], total: 0, page: 1, limit: 25, counts: {} });
  const [tracks, setTracks] = useState([]);
  const [filters, setFilters] = useState({ q: '', status: '', trackId: '', page: 1 });
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [record, setRecord] = useState(null);
  const [form, setForm] = useState(null);
  const [changeNote, setChangeNote] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!allowed) { setLoading(false); return undefined; }
    const controller = new AbortController();
    setLoading(true); setError('');
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== ''));
    Promise.all([request(`${basePath}?${query}`, { signal: controller.signal }), request('/admin/content/tracks', { signal: controller.signal })])
      .then(([questions, trackData]) => { setData(questions); setTracks(trackData.tracks || []); })
      .catch(caught => { if (caught.name !== 'AbortError') setError(caught.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [allowed, filters, reload]);

  const dirty = Boolean(record && form && JSON.stringify(toForm(record.draft)) !== JSON.stringify(form));
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const accept = question => { setRecord(question); setForm(toForm(question.draft)); setChangeNote(''); };
  const canLeave = () => !dirty || window.confirm('当前草稿还未保存，确定放弃这些修改吗？');
  const open = async id => {
    if (!canLeave()) return;
    setSaving('load'); setError(''); setNotice('');
    try { const result = await request(`${basePath}/${encodeURIComponent(id)}`); accept(result.question); }
    catch (caught) { setError(caught.message); }
    finally { setSaving(''); }
  };
  const create = () => {
    if (!canLeave()) return;
    accept({ id: '', version: 0, status: 'draft', history: [], draft: emptyDraft(tracks[0]?.id || '') });
    setError(''); setNotice('');
  };
  const save = async event => {
    event.preventDefault(); setSaving('save'); setError(''); setNotice('');
    try {
      const result = await request(record.id ? `${basePath}/${encodeURIComponent(record.id)}` : basePath,
        { method: record.id ? 'PUT' : 'POST', body: { ...fromForm(form), expectedVersion: record.version, changeNote: changeNote || '保存草稿' } });
      accept(result.question); setReload(value => value + 1); setNotice('草稿已保存。发布前，学生仍只看到原来的发布版本。');
    } catch (caught) { setError(caught.message); }
    finally { setSaving(''); }
  };
  const transition = async action => {
    if (!changeNote.trim()) { setError(action === 'retire' ? '请填写下架原因' : '请填写发布说明'); return; }
    if (action === 'retire' && !window.confirm('下架后，学生将无法开始练习这道题。已有考试的历史版本仍会保留。确定下架吗？')) return;
    setSaving(action); setError(''); setNotice('');
    try {
      const result = await request(`${basePath}/${encodeURIComponent(record.id)}/${action}`, {
        method: 'POST', body: { expectedVersion: record.version, changeNote },
      });
      accept(result.question); setReload(value => value + 1);
      setNotice(action === 'publish' ? '内容已发布，用户端现在可以练习新版本。' : '内容已下架，历史答题记录和已开始的考试不受影响。');
    } catch (caught) { setError(caught.message); }
    finally { setSaving(''); }
  };

  if (!allowed) return <div className="page"><ErrorState message="只有管理员和内容编辑可以管理题库。" /></div>;

  return <div className="page content-admin-page">
    <header className="page-header">
      <div><h1>题库内容管理</h1><p>把原创题目从草稿发布到练习。每次修订都可追溯，已有考试保留开始时的版本。</p></div>
      <div className="content-header-actions"><Link className="button secondary" to={user.role === 'admin' ? '/admin' : '/prep'}>返回{user.role === 'admin' ? '管理中心' : '备考中心'}</Link><button className="button primary" type="button" onClick={create} disabled={Boolean(saving)}><Icon name="edit" size={17} />新建题目</button></div>
    </header>
    <div className="content-counts" aria-label="题库状态概览">
      {Object.entries(statusLabels).map(([status, label]) => <button type="button" key={status} className={filters.status === status ? 'selected' : ''} onClick={() => setFilters(current => ({ ...current, status: current.status === status ? '' : status, page: 1 }))}><span>{label}</span><strong>{data.counts[status] || 0}</strong></button>)}
    </div>
    {error && <div className="form-error" role="alert">{error}{record?.id && <button type="button" onClick={() => open(record.id)} disabled={Boolean(saving)}>重新载入题目</button>}</div>}
    {notice && <div className="form-success" role="status">{notice}</div>}
    <form className="content-filters" onSubmit={event => { event.preventDefault(); setFilters(current => ({ ...current, q: search.trim(), page: 1 })); }}>
      <label className="field"><span>查找题目</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索题干、解析或作者" /></label>
      <label className="field"><span>备考路径</span><select value={filters.trackId} onChange={event => setFilters(current => ({ ...current, trackId: event.target.value, page: 1 }))}><option value="">全部路径</option>{tracks.map(track => <option key={track.id} value={track.id}>{track.title}</option>)}</select></label>
      <button className="button secondary" type="submit"><Icon name="search" size={17} />搜索</button>
    </form>
    <div className={`content-workspace${record ? ' has-editor' : ''}`}>
      <section className="content-library" aria-label="题目列表">
        <div className="section-title-row"><h2>题目目录</h2><span>共 {data.total} 道</span></div>
        {loading ? <LoadingState rows={4} /> : data.items.length === 0 ? <EmptyState title="没有找到题目" description="试试其他关键词，或创建新的原创练习。" icon="book" /> :
          <div className="content-question-list">{data.items.map(item => <button key={item.id} type="button" className={`content-question-row${record?.id === item.id ? ' selected' : ''}`} onClick={() => open(item.id)} disabled={Boolean(saving)}>
            <span className="content-row-meta"><span className={`content-status ${item.status}`}>{statusLabels[item.status]}</span><span>{typeLabels[item.type]}</span>{item.hasDraft && item.status === 'published' && <span className="content-draft-mark">有未发布修改</span>}</span>
            <strong>{item.prompt}</strong><small>{tracks.find(track => track.id === item.trackId)?.title || '未选择路径'} · v{item.version}</small>
          </button>)}</div>}
        <div className="content-pagination"><button className="button secondary" type="button" disabled={loading || data.page <= 1} onClick={() => setFilters(current => ({ ...current, page: current.page - 1 }))}>上一页</button><span>{data.page} / {Math.max(1, Math.ceil(data.total / data.limit))}</span><button className="button secondary" type="button" disabled={loading || data.page * data.limit >= data.total} onClick={() => setFilters(current => ({ ...current, page: current.page + 1 }))}>下一页</button></div>
      </section>
      {record && form && <section className="content-editor" aria-label="题目编辑">
        <header><div><h2>{record.id ? '编辑题目' : '新题目草稿'}</h2><p>{record.id ? `${statusLabels[record.status]} · 版本 ${record.version}` : '保存后可审核发布'}{dirty ? ' · 尚未保存' : ''}</p></div><button type="button" className="icon-button" aria-label="关闭题目编辑" onClick={() => { if (canLeave()) { setRecord(null); setForm(null); } }}><Icon name="close" /></button></header>
        <form onSubmit={save}>
          <div className="field-grid two"><label className="field"><span>备考路径</span><select value={form.trackId} onChange={event => update('trackId', event.target.value)}><option value="">请选择</option>{tracks.map(track => <option key={track.id} value={track.id}>{track.title}</option>)}</select></label>
            <label className="field"><span>题型</span><select value={form.type} onChange={event => setForm(current => ({ ...current, type: event.target.value, answerText: '', keywordsText: '' }))}>{Object.entries(typeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label></div>
          <label className="field"><span>难度</span><select value={form.difficulty} onChange={event => update('difficulty', event.target.value)}>{['基础', '进阶', '挑战'].map(value => <option key={value}>{value}</option>)}</select></label>
          <label className="field"><span>题干</span><textarea required maxLength={5000} value={form.prompt} onChange={event => update('prompt', event.target.value)} placeholder="描述清晰、可独立作答的问题" /></label>
          {form.type !== 'short' && <label className="field"><span>选项（每行一个）</span><textarea value={form.optionsText} onChange={event => update('optionsText', event.target.value)} placeholder={'第一个选项\n第二个选项'} /><small>2–12 个选项，文字不能重复。</small></label>}
          <label className="field"><span>{form.type === 'short' ? '参考回答' : form.type === 'multi' ? '正确选项（每行一个，使用完整选项文字）' : '正确答案（使用完整选项文字）'}</span><textarea value={form.answerText} onChange={event => update('answerText', event.target.value)} /></label>
          {form.type === 'short' && <label className="field"><span>评分关键词（逗号分隔）</span><input value={form.keywordsText} onChange={event => update('keywordsText', event.target.value)} placeholder="事实，证据，结果" /><small>简答题按关键词规则评分，不等同于真人或 AI 评分。</small></label>}
          <label className="field"><span>答案解析</span><textarea value={form.explanation} maxLength={5000} onChange={event => update('explanation', event.target.value)} placeholder="说明判断依据，以及容易混淆之处" /></label>
          <fieldset className="content-rights"><legend>来源与使用权限</legend>
            <div className="field-grid two"><label className="field"><span>内容来源</span><select value={form.sourceType} onChange={event => update('sourceType', event.target.value)}><option value="original">原创练习</option><option value="authorized">已获授权内容</option><option value="unverified">待核验（不可发布）</option></select></label><label className="field"><span>作者或权利人</span><input maxLength={200} value={form.author} onChange={event => update('author', event.target.value)} /></label></div>
            <label className="field"><span>来源链接{form.sourceType === 'authorized' ? '（发布必填）' : '（选填）'}</span><input type="url" value={form.sourceUrl} onChange={event => update('sourceUrl', event.target.value)} placeholder="https://" /></label>
            <label className="field"><span>原创或授权说明</span><textarea value={form.licenseNote} maxLength={2000} onChange={event => update('licenseNote', event.target.value)} placeholder="注明原创归属，或授权范围与依据" /></label>
            <label className="content-checkbox"><input type="checkbox" checked={form.rightsConfirmed} onChange={event => update('rightsConfirmed', event.target.checked)} /><span>已核实内容及答案，并确认有权在本站发布。</span></label>
          </fieldset>
          <label className="field"><span>变更说明 / 下架原因</span><input value={changeNote} maxLength={1000} onChange={event => setChangeNote(event.target.value)} placeholder="发布和下架时必填，随版本留存" /></label>
          <div className="content-editor-actions"><button className="button secondary" type="submit" disabled={Boolean(saving)}>{saving === 'save' ? '保存中…' : '保存草稿'}</button><button className="button primary" type="button" onClick={() => transition('publish')} disabled={Boolean(saving) || !record.id || dirty || (!record.hasDraft && record.status === 'published')}>{saving === 'publish' ? '发布中…' : '审核并发布'}</button>{record.id && record.status !== 'retired' && <button className="button content-retire" type="button" onClick={() => transition('retire')} disabled={Boolean(saving) || dirty}>{saving === 'retire' ? '处理中…' : '下架题目'}</button>}</div>
          {dirty && <p className="content-edit-hint">请先保存草稿，再发布或下架。</p>}
        </form>
        {!!record.history?.length && <details className="content-history"><summary>版本与操作记录（{record.history.length}）</summary><ol>{record.history.map(item => <li key={item.id}><strong>v{item.version} · {actionLabels[item.action] || item.action}</strong><p>{item.note}</p><small>{item.actor} · {dateLabel(item.createdAt)}</small><details><summary>查看该版本内容</summary><p><strong>题干：</strong>{item.snapshot.prompt}</p><p className="preline"><strong>答案：</strong>{answerLabel(item.snapshot.type, item.snapshot.answer)}</p><p><strong>解析：</strong>{item.snapshot.explanation || '尚未填写'}</p><p><strong>来源说明：</strong>{item.snapshot.licenseNote || '待核验'}</p></details></li>)}</ol></details>}
      </section>}
    </div>
  </div>;
}
