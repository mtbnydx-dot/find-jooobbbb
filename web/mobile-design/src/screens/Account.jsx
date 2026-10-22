import React, { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar, Page, Button, Cell, Field, Notice, Empty, Sheet } from '../components/UI';
import Icon from '../components/Icon';
import { useDemo } from '../demo/state';
import './account.css';

const makeId = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || Date.now().toString(36)}`;
const plans = [
  { id: 'free', name: '基础版', subtitle: '从发现一个机会开始', features: ['浏览岗位与来源说明', '收藏机会、记录投递', '体验备考与求职工具'] },
  { id: 'pro', name: 'Pro 进阶', subtitle: '给持续准备多一点空间', features: ['更多收藏与保存的搜索', '更充足的练习与工具额度', '集中管理求职进度'] },
  { id: 'sprint', name: '求职冲刺', subtitle: '为集中求职做好准备', features: ['更高的学习与求职工具额度', '集中整理目标机会', '记录计划与每次跟进'] },
];
const sampleMessages = [
  { id: 'message-1', icon: 'clock', title: '给下一次面试留一点准备时间', text: '示例科技 · 前端开发工程师，可以先整理一份项目介绍。', to: '/pipeline', time: '今天' },
  { id: 'message-2', icon: 'book', title: '今天也可以前进一步', text: '完成一组专项练习，回看一道错题。', to: '/prep', time: '今天' },
];

export function AccountHome() {
  const { state } = useDemo();
  const { profile } = state;
  return <><TopBar action="settings" /><main className="page account-home">
    <div className="account-profile">
      <div className="account-avatar" aria-hidden="true">{profile.name?.slice(0, 1) || '小'}</div>
      <div className="account-profile-copy"><h1>{profile.name || '小路'}</h1><p>{profile.year}届 · {profile.major}专业</p></div>
      <Link className="account-edit" to="/onboarding">编辑求职画像<Icon name="chevron" size={18} /></Link>
    </div>
    <Link className="account-membership" to="/membership"><Icon name="crown" size={32} /><div><strong>让准备更有方向</strong><span>查看会员权益与使用额度</span></div><Icon name="chevron" size={18} /></Link>
    <div className="account-cell-group">
      <Cell icon="star" label="我的收藏" to="/pipeline?tab=saved" />
      <Cell icon="search" label="保存的搜索" to="/saved-searches" />
      <Cell icon="file" label="简历与附件" to="/attachments" />
      <Cell icon="bell" label="消息与提醒" to="/messages" />
    </div>
    <div className="account-cell-group">
      <Cell icon="shield" label="账号与安全" to="/settings" />
      <Cell icon="help" label="帮助与反馈" to="/support" />
      <Cell icon="info" label="关于职路" to="/about" />
    </div>
  </main></>;
}

export function MembershipPage() {
  const { state, patch, notify } = useDemo();
  const [plan, setPlan] = useState('pro');
  const [period, setPeriod] = useState('month');
  const [confirming, setConfirming] = useState(false);
  const selected = plans.find(item => item.id === plan);
  const orders = state.orders || [];
  const pending = orders.some(order => order.status === 'pending' && order.plan === plan && order.period === period);
  const apply = () => {
    if (pending) { setConfirming(false); notify('已有相同的本地申请'); return; }
    patch(current => ({ orders: [{ id: makeId('order'), plan, period, planName: selected.name, status: 'pending', createdAt: new Date().toISOString() }, ...(current.orders || [])] }));
    setConfirming(false); notify('已记录演示申请，不会扣款或开通真实权益');
  };
  return <Page title="会员权益" className="account-page">
    <div className="account-page-intro"><h1>让准备更有方向</h1><p>选择适合自己的求职节奏。</p></div>
    <Notice>这是会员选择流程演示。价格与权益未正式售卖，不发生支付，也不会自动续费。</Notice>
    <div className="account-segment" role="group" aria-label="会员周期">{[['month', '按月'], ['quarter', '按季']].map(([id, label]) => <button key={id} aria-pressed={period === id} onClick={() => setPeriod(id)} className={period === id ? 'selected' : ''}>{label}</button>)}</div>
    <div className="account-plan-options" role="group" aria-label="选择会员方案">{plans.map(item => <button key={item.id} className={`account-plan ${plan === item.id ? 'selected' : ''}`} aria-pressed={plan === item.id} onClick={() => setPlan(item.id)}><span>{item.name}</span><small>{item.id === 'free' ? '免费体验' : '演示方案'}</small></button>)}</div>
    <section className="account-plan-detail"><Icon name="crown" size={30} /><h2>{selected.name}</h2><p>{selected.subtitle}</p><ul>{selected.features.map(feature => <li key={feature}><Icon name="check" size={18} />{feature}</li>)}</ul><div className="account-plan-foot">{plan === 'free' ? '当前可使用的本地示例功能' : `${period === 'month' ? '1 个月' : '3 个月'}周期示例 · 价格待正式上线确认`}</div></section>
    <Button className="account-full" onClick={() => plan === 'free' ? notify('当前演示功能均可免费体验') : setConfirming(true)}>{plan === 'free' ? '继续免费体验' : pending ? '查看已有申请' : '申请开通（演示）'}</Button>
    <section className="account-section"><h2>申请记录</h2>{orders.length ? <div className="account-history">{orders.map(order => <article key={order.id}><div><strong>{order.planName || order.plan}</strong><p>{order.period === 'quarter' ? '季度' : '月度'} · {order.status === 'cancelled' ? '已撤回' : '待人工核验（演示）'}</p></div>{order.status === 'pending' ? <button className="account-text-button" onClick={() => { patch(current => ({ orders: current.orders.map(item => item.id === order.id ? { ...item, status: 'cancelled' } : item) })); notify('已撤回本地申请'); }}>撤回</button> : null}</article>)}</div> : <p className="account-muted">还没有申请记录。这里不会产生真实订单。</p>}</section>
    {confirming ? <Sheet title={pending ? '已有相同申请' : '确认演示申请'} onClose={() => setConfirming(false)} footer={<Button className="account-full" onClick={pending ? () => setConfirming(false) : apply}>{pending ? '知道了' : '记录本地申请'}</Button>}><p className="account-sheet-lead">{selected.name} · {period === 'quarter' ? '季度' : '月度'}</p><Notice>{pending ? '此方案已有待核验的演示申请，不会重复创建。' : '这一步只展示人工申请流程，不收集支付资料、不扣费、不发起人工服务。'}</Notice></Sheet> : null}
  </Page>;
}

export function AttachmentsPage() {
  const { state, patch, notify } = useDemo();
  const input = useRef(null);
  const [removing, setRemoving] = useState(null);
  const attachments = state.attachments || [];
  const add = event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    const extension = file.name.split('.').pop().toLowerCase();
    if (!['txt', 'pdf', 'doc', 'docx'].includes(extension)) { notify('请选择 TXT、PDF 或 Word 格式'); return; }
    if (file.size > 5 * 1024 * 1024) { notify('演示附件大小上限为 5 MB'); return; }
    const entry = { id: makeId('file'), name: file.name, size: file.size < 1024 * 1024 ? `${Math.max(1, Math.ceil(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`, type: `${extension.toUpperCase()} · 未上传、未解析` };
    patch(current => ({ attachments: [...(current.attachments || []), entry] })); notify('仅记录文件名与大小，没有读取文件内容');
  };
  return <Page title="简历与附件" className="account-page">
    <div className="account-page-intro"><h1>把准备整理好</h1><p>给每一次投递，留下一份从容。</p></div>
    <Notice>原型只记录文件名、类型和大小，不读取、不上传文件内容。PDF、Word 均未解析，也没有 AI 分析。</Notice>
    <input ref={input} className="account-hidden-input" type="file" accept=".txt,.pdf,.doc,.docx" aria-label="选择演示附件" onChange={add} />
    <Button className="account-full account-upload" variant="outline" onClick={() => input.current?.click()}><Icon name="upload" size={20} />选择文件（仅记录名称）</Button>
    <p className="account-caption">TXT / PDF / Word · 单个不超过 5 MB · 请使用示例文件</p>
    {attachments.length ? <div className="account-file-list">{attachments.map(file => <article key={file.id}><div className="account-file-icon"><Icon name="file" size={24} /></div><div className="account-file-copy"><strong>{file.name}</strong><p>{file.size}</p><small>{file.type}</small></div><button className="icon-button" aria-label={`删除 ${file.name}`} onClick={() => setRemoving(file)}><Icon name="trash" size={20} /></button></article>)}</div> : <Empty icon="file" title="还没有附件" message="可以选择一个示例文件，体验附件整理流程。" label="选择示例文件" action={() => input.current?.click()} />}
    {removing ? <Sheet title="删除附件记录？" onClose={() => setRemoving(null)} footer={<Button className="account-full" onClick={() => { patch(current => ({ attachments: current.attachments.filter(file => file.id !== removing.id) })); setRemoving(null); notify('已删除本地记录，原文件没有变化'); }}>删除本地记录</Button>}><p className="account-sheet-lead account-wrap">{removing.name}</p><p className="account-muted">只移除这条演示记录，不会删除设备上的文件。</p></Sheet> : null}
  </Page>;
}

export function MessagesPage() {
  const { state, patch, notify } = useDemo();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState('followup');
  const messages = [...(state.demoMessages || []), ...sampleMessages];
  const simulate = () => {
    const followup = kind === 'followup';
    patch(current => ({ messagesRead: false, demoMessages: [{ id: makeId('message'), icon: followup ? 'clock' : 'file', title: followup ? '该跟进你的求职进度了' : '留一点时间给今日练习', text: '这是你刚刚手动生成的模拟提醒，没有真实后台定时任务。', to: followup ? '/pipeline' : '/prep', time: '刚刚' }, ...(current.demoMessages || [])] }));
    setAdding(false); notify('已生成一条本地模拟提醒');
  };
  return <Page title="消息与提醒" className="account-page">
    <div className="account-heading-row"><h1>不遗漏重要进展</h1><button className="account-text-button" disabled={state.messagesRead} onClick={() => { patch({ messagesRead: true }); notify('示例消息已标为已读'); }}>{state.messagesRead ? '全部已读' : '全部已读'}</button></div>
    <Notice>站内消息是本地示例。邮件与推送服务未开通，开关只保存演示偏好，不会发信或请求设备权限。</Notice>
    <div className="account-cell-group account-channel-group">
      <label className="account-toggle"><span><strong>邮件提醒</strong><small>未配置邮件服务</small></span><input type="checkbox" checked={Boolean(state.emailEnabled)} onChange={e => { patch({ emailEnabled: e.target.checked }); notify('已保存本地偏好，没有真实邮件'); }} /><span className="account-switch" aria-hidden="true" /></label>
      <label className="account-toggle"><span><strong>设备推送</strong><small>未连接推送服务</small></span><input type="checkbox" checked={Boolean(state.pushEnabled)} onChange={e => { patch({ pushEnabled: e.target.checked }); notify('已保存本地偏好，没有注册真实设备'); }} /><span className="account-switch" aria-hidden="true" /></label>
    </div>
    <div className="account-message-list">{messages.map(message => <Link to={message.to} key={message.id} className={state.messagesRead ? 'read' : ''} onClick={() => patch({ messagesRead: true })}><div className="account-message-icon"><Icon name={message.icon === 'book' ? 'file' : message.icon} size={22} /></div><div><div className="account-message-title"><strong>{message.title}</strong>{!state.messagesRead ? <span className="account-unread" aria-label="未读" /> : null}</div><p>{message.text}</p><small>{message.time} · 演示消息</small></div></Link>)}</div>
    <Button className="account-full" variant="outline" onClick={() => setAdding(true)}>生成一条模拟提醒</Button>
    {adding ? <Sheet title="模拟哪种提醒？" onClose={() => setAdding(false)} footer={<Button className="account-full" onClick={simulate}>生成站内示例</Button>}><Field label="提醒类型"><select value={kind} onChange={e => setKind(e.target.value)}><option value="followup">投递跟进</option><option value="study">每日学习</option></select></Field><p className="account-muted">立即添加一条本地示例，不安排真实通知。</p></Sheet> : null}
  </Page>;
}

export function SettingsPage() {
  const { state, patch, notify, reset } = useDemo();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState(null);
  const [passwordError, setPasswordError] = useState('');
  const changePassword = event => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (form.get('password') !== form.get('confirmation')) { setPasswordError('两次输入不一致，请重新确认。'); return; }
    event.currentTarget.reset(); setPasswordError(''); setSheet(null); notify('密码填写校验已演示，未保存或修改任何真实密码');
  };
  return <Page title="账号与安全" className="account-page">
    <div className="account-page-intro"><h1>由你掌握</h1><p>管理偏好，了解每一步的边界。</p></div>
    <div className="account-cell-group">
      <Cell icon="user" label="登录状态" detail={state.signedIn ? '已登录 · 本地演示身份' : '未登录 · 演示仍可浏览'} to="/auth/login" />
      <Cell icon="lock" label="修改密码" detail="仅演示填写与校验" onClick={() => { setPasswordError(''); setSheet('password'); }} />
      <Cell icon="mail" label="邮箱验证" detail={state.demoEmailVerified ? '验证完成状态（模拟）' : '尚未验证 · 不发送邮件'} onClick={() => setSheet('email')} />
    </div>
    <section className="account-section"><h2>界面状态演示</h2><p className="account-muted">切换后前往发现页查看。这里不会切断网络或影响真实服务。</p><Field label="演示状态"><select value={state.scenario} onChange={e => patch({ scenario: e.target.value })}><option value="normal">正常内容</option><option value="loading">加载中</option><option value="empty">暂无内容</option><option value="offline">离线提示</option><option value="error">服务异常</option></select></Field><Button className="account-full" variant="outline" onClick={() => navigate('/discover')}>查看此状态</Button></section>
    <div className="account-cell-group"><Cell icon="refresh" label="重置演示数据" detail="恢复示例，不影响主站" onClick={() => setSheet('reset')} /><Cell icon="info" label="演示能力说明" to="/about" /></div>
    <Button className="account-full" variant="ghost" onClick={() => { patch({ signedIn: false }); navigate('/auth/login'); notify('已退出本地演示身份'); }}>退出登录（演示）</Button>
    {sheet === 'password' ? <Sheet title="修改密码 · 演示" onClose={() => setSheet(null)}><Notice>请勿输入真实密码。输入只留在当前表单中，关闭后清除。</Notice><form className="account-form" onSubmit={changePassword}><Field label="演示新密码"><input name="password" type="password" autoComplete="off" minLength={6} maxLength={80} required placeholder="输入至少 6 位演示字符" /></Field><Field label="再次确认"><input name="confirmation" type="password" autoComplete="off" minLength={6} maxLength={80} required placeholder="再次输入演示字符" /></Field>{passwordError ? <p className="account-error" role="alert">{passwordError}</p> : null}<Button className="account-full" type="submit">完成填写校验</Button></form></Sheet> : null}
    {sheet === 'email' ? <Sheet title="邮箱验证 · 演示" onClose={() => setSheet(null)} footer={<Button className="account-full" onClick={() => { patch({ demoEmailVerified: !state.demoEmailVerified }); setSheet(null); notify('仅切换本地验证显示状态，没有发送邮件'); }}>{state.demoEmailVerified ? '恢复未验证状态' : '模拟已验证状态'}</Button>}><Notice>当前没有邮件服务。此按钮仅展示验证前后的界面，不发送验证码，也不验证真实邮箱。</Notice></Sheet> : null}
    {sheet === 'reset' ? <Sheet title="重置本地演示？" onClose={() => setSheet(null)} footer={<Button className="account-full" onClick={() => { reset(); setSheet(null); navigate('/account'); }}>恢复示例数据</Button>}><p className="account-muted">演示画像、收藏、申请、附件名称和反馈将恢复初始状态。主站账号、岗位和原文件都不会改变。</p></Sheet> : null}
  </Page>;
}

export function SupportPage() {
  const { state, patch, notify } = useDemo();
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const selected = (state.tickets || []).find(ticket => ticket.id === selectedId);
  const submit = event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const title = String(data.get('title') || '').trim(); const message = String(data.get('message') || '').trim();
    if (!title || !message) { notify('请填写问题标题和说明'); return; }
    patch(current => ({ tickets: [{ id: makeId('ticket'), title, message, category: data.get('category'), status: 'open', createdAt: new Date().toISOString(), reply: '' }, ...(current.tickets || [])] }));
    setCreating(false); notify('已保存在本地，没有发送给客服');
  };
  return <Page title="帮助与反馈" className="account-page">
    <div className="account-page-intro"><h1>遇到问题，一起解决</h1><p>说清问题，比独自摸索更近一步。</p></div>
    <Notice>反馈只保存在当前浏览器会话，不会发给真实客服。请勿填写手机号、身份证或其他敏感资料。</Notice>
    <Button className="account-full account-spaced" onClick={() => setCreating(true)}><Icon name="plus" size={19} />创建反馈（演示）</Button>
    <section className="account-section"><h2>我的反馈</h2>{state.tickets?.length ? <div className="account-cell-group">{state.tickets.map(ticket => <Cell key={ticket.id} icon="help" label={ticket.title} detail={ticket.reply ? '有一条示例回复' : '本地记录 · 未实际提交'} onClick={() => setSelectedId(ticket.id)} />)}</div> : <Empty icon="help" title="还没有反馈记录" message="可以创建一条示例反馈，体验处理流程。" label="写下问题" action={() => setCreating(true)} />}</section>
    {creating ? <Sheet title="创建反馈" onClose={() => setCreating(false)}><form className="account-form" onSubmit={submit}><Field label="问题类型"><select name="category"><option>岗位信息</option><option>使用问题</option><option>功能建议</option></select></Field><Field label="问题标题"><input name="title" required maxLength={60} placeholder="例如：岗位来源页面打不开" /></Field><Field label="具体说明"><textarea name="message" rows={4} required maxLength={1000} placeholder="发生了什么？你希望如何改进？" /></Field><Button className="account-full" type="submit">保存本地反馈</Button></form></Sheet> : null}
    {selected ? <Sheet title="反馈详情" onClose={() => setSelectedId(null)}><span className="account-small-label">{selected.category} · 本地记录</span><h3 className="account-wrap">{selected.title}</h3><p className="account-ticket-body">{selected.message}</p>{selected.reply ? <section className="account-demo-reply"><strong>示例回复 · 非真人客服</strong><p>{selected.reply}</p></section> : <Button variant="outline" className="account-full" onClick={() => patch(current => ({ tickets: current.tickets.map(ticket => ticket.id === selected.id ? { ...ticket, status: 'replied', reply: '这是处理结果展示示例。正式产品中会在这里展示客服回复与处理进度；当前未发送或处理任何真实请求。' } : ticket) }))}>模拟收到回复</Button>}</Sheet> : null}
  </Page>;
}

export function AboutPage() {
  return <Page title="关于职路" className="account-page"><div className="account-about-brand"><span>职路</span><h1>让每一步求职<br />更有方向</h1></div><Notice>这是独立手机界面原型，不是主站的真实服务。</Notice><section className="account-section"><h2>你可以体验</h2><p className="account-readable">浏览示例岗位、保存搜索、整理投递进度、练习示例题目，以及编辑一份本地求职画像。</p><h2>数据留在哪里</h2><p className="account-readable">演示数据仅保存在当前浏览器的会话存储中。关闭会话或清理浏览器数据后可能丢失；也可在设置中重置。</p><h2>暂未连接的服务</h2><p className="account-readable">真实账号、招聘数据、支付、客服、邮件、设备推送和 AI 均未连接。会员申请不扣款，附件不上传、不读取内容、不做解析。</p><h2>请以原始公告为准</h2><p className="account-readable">这里的企业、岗位、练习和通知都是界面示例，不构成真实招聘、薪酬或录用承诺。</p></section><Link className="account-inline-link" to="/support">提出你的使用建议<Icon name="chevron" size={18} /></Link></Page>;
}

export function SavedSearchesPage() {
  const { state, patch, notify } = useDemo();
  const navigate = useNavigate();
  const [removing, setRemoving] = useState(null);
  const open = search => {
    const filters = { q: search.q || '', city: search.city || '', major: search.major || '', salary: Boolean(search.salary) };
    patch({ filters, scenario: 'normal' });
    const query = new URLSearchParams();
    for (const key of ['q', 'city', 'major']) if (filters[key]) query.set(key, filters[key]);
    if (filters.salary) query.set('salary', '1');
    navigate(`/discover${query.size ? `?${query}` : ''}`);
  };
  return <Page title="保存的搜索" className="account-page"><div className="account-page-intro"><h1>让好条件留下来</h1><p>下次找机会，不用从头设置。</p></div>{state.searches?.length ? <div className="account-search-list">{state.searches.map(search => <article key={search.id}><div className="account-heading-row"><h2 className="account-wrap">{search.name}</h2><button className="icon-button" aria-label={`删除搜索 ${search.name}`} onClick={() => setRemoving(search)}><Icon name="trash" size={20} /></button></div><p>{[search.city, search.major, search.q].filter(Boolean).join(' · ') || '全部示例岗位'}</p><Button variant="outline" onClick={() => open(search)}>使用这些条件<Icon name="chevron" size={17} /></Button></article>)}</div> : <Empty icon="search" title="还没有保存的搜索" message="在发现页设置条件后，可以保存常用的搜索。" />}<Notice>保存搜索只影响演示岗位列表，不产生真实订阅或自动提醒。</Notice>{removing ? <Sheet title="删除这条搜索？" onClose={() => setRemoving(null)} footer={<Button className="account-full" onClick={() => { patch(current => ({ searches: current.searches.filter(search => search.id !== removing.id) })); setRemoving(null); notify('已删除这条本地搜索'); }}>确认删除</Button>}><p className="account-sheet-lead account-wrap">{removing.name}</p><p className="account-muted">已收藏岗位和投递进度不会改变。</p></Sheet> : null}</Page>;
}
