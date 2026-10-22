import React, { useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Page, Button, Field, Notice } from '../components/UI';
import Icon from '../components/Icon';
import { api, webAppBase } from '../lib/api';
import { useMobile, useResource } from '../lib/runtime';
import { ActionError, ResourceState, csv, splitCsv, safeMobileReturnTo } from './account-live';
import './account.css';

export function AuthPage({ mode = 'login' }) {
  const { login, register, notify } = useMobile(), navigate = useNavigate(), location = useLocation(); const [params] = useSearchParams();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''); const lock = useRef(false);
  const capabilities = useResource(signal => api.auth.capabilities(signal), []);
  const isRegister = mode === 'register', forgot = mode === 'forgot';
  const destination = safeMobileReturnTo(params.get('returnTo'), isRegister ? '/onboarding' : '/account');
  const suffix = params.get('returnTo') ? `?returnTo=${encodeURIComponent(destination)}` : '';
  const recoveryReady = capabilities.data?.recovery?.passwordResetConfigured === true;
  const submit = async event => {
    event.preventDefault(); if (lock.current || (forgot && !recoveryReady)) return; const form = event.currentTarget, data = new FormData(form);
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { const email = String(data.get('email') || '').trim();
      if (forgot) { const result = await api.auth.forgot(email); setMessage({ mode, text: result.message || '请求已受理。如邮箱已注册且发送成功，请从邮件中的链接继续。' }); form.reset(); }
      else { const credentials = { email, password: String(data.get('password') || '') }; if (isRegister) await register({ ...credentials, displayName: String(data.get('displayName') || '').trim() }); else await login(credentials); form.reset(); notify(isRegister ? '账号已创建，请完善求职画像' : '登录成功'); navigate(destination, { replace: true }); }
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message); } finally { lock.current = false; setBusy(false); }
  };
  return <Page title={forgot ? '找回密码' : '账号'} className="account-page account-auth"><div className="account-auth-logo">职路</div><div className="account-page-intro"><h1>{forgot ? '找回密码' : isRegister ? '创建账号' : '欢迎回来'}</h1><p>{forgot ? '通过注册邮箱恢复账户访问。' : '从认识自己，到找到更合适的机会。'}</p></div>
    <Notice>与网页版使用同一账户。密码仅用于身份验证，不保存在本机网页存储中。</Notice>
    {location.state?.accountDeleted ? <Notice>{location.state.accountDeleted === 'pending' ? '账号已注销，但部分私有附件仍待后台重试清理。' : '账号已注销，在线个人资料和私有附件已清理。'}匿名交易、退款及必要审计按说明保留，恢复备份可能暂留。</Notice> : null}
    {forgot && !capabilities.data ? <ResourceState resource={capabilities} label="正在确认邮件服务" /> : null}
    {forgot && capabilities.data && !recoveryReady ? <Notice>平台邮件服务尚未启用，暂不能自助找回密码。请联系平台支持；切勿向他人提供原密码。</Notice> : null}<ActionError error={error} />
    {message?.mode === mode ? <section className="account-auth-success" role="status"><Icon name="mail" size={36} /><h2>恢复请求已受理</h2><p>{message.text}</p><Link className="button outline account-full" to={`/auth/login${suffix}`}>返回登录</Link></section> : <form className="account-form" key={mode} onSubmit={submit}>
      {isRegister ? <Field label="姓名或昵称"><input name="displayName" required maxLength={80} autoComplete="nickname" /></Field> : null}<Field label="注册邮箱"><input name="email" type="email" required maxLength={254} autoComplete="email" /></Field>
      {!forgot ? <Field label="密码" hint={isRegister ? '8–256 个字符，请不要与其他网站共用密码。' : undefined}><input name="password" type="password" required minLength={isRegister ? 8 : 1} maxLength={256} autoComplete={isRegister ? 'new-password' : 'current-password'} /></Field> : null}
      {isRegister ? <label className="account-consent"><input type="checkbox" required /><span>我已阅读并同意<a href={`${webAppBase}/policy/terms`} target="_blank" rel="noreferrer">使用说明</a>与<a href={`${webAppBase}/policy/privacy`} target="_blank" rel="noreferrer">隐私说明</a>。</span></label> : null}
      <Button className="account-full" type="submit" disabled={busy || (forgot && !recoveryReady)}>{busy ? '处理中…' : forgot ? '发送重置邮件' : isRegister ? '创建账号' : '登录'}</Button>
      {!forgot ? <div className="account-auth-links"><Link to={`${isRegister ? '/auth/login' : '/auth/register'}${suffix}`} onClick={() => { setError(''); setMessage(''); }}>{isRegister ? '已有账号？登录' : '创建账号'}</Link><Link to={`/auth/forgot${suffix}`} onClick={() => { setError(''); setMessage(''); }}>忘记密码</Link></div> : null}
    </form>}<Link className="account-auth-skip" to="/discover">先看看岗位<Icon name="chevron" size={16} /></Link></Page>;
}

function ProfileForm({ source, entitlements, reload }) {
  const { user, refreshUser, notify, bumpRefresh } = useMobile(), navigate = useNavigate();
  const [step, setStep] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false); const lock = useRef(false);
  const [form, setForm] = useState(() => ({ displayName: source.displayName || user?.displayName || '', educationLevel: source.educationLevel || '', school: source.school || '', graduationYear: source.graduationYear ?? '', experienceYears: source.experienceYears ?? '', majors: csv(source.majors?.length ? source.majors : source.major), skills: csv(source.skills), targetRoles: csv(source.targetRoles), locations: csv(source.locations || source.preferredLocations), industries: csv(source.industries || source.targetIndustries), salaryCurrency: source.salaryCurrency || source.currency || 'CNY', salaryPeriod: source.salaryPeriod || 'month', salaryMin: source.salaryMin ?? '', salaryMax: source.salaryMax ?? '', salaryMonths: source.salaryMonths ?? '', restrictions: csv(source.restrictions) }));
  const update = (name, value) => setForm(current => ({ ...current, [name]: value })); const majorLimit = entitlements?.values?.['profile.majors']?.limit;
  const submit = async event => {
    event.preventDefault(); if (lock.current) return; setError(''); if (step < 2) { setStep(current => current + 1); return; }
    const majors = splitCsv(form.majors); if (majorLimit >= 0 && majors.length > majorLimit) { setError(`当前套餐最多保存 ${majorLimit} 个专业方向`); setStep(0); return; }
    if (form.salaryMin !== '' && form.salaryMax !== '' && Number(form.salaryMin) > Number(form.salaryMax)) { setError('最低期望薪资不能高于理想目标'); return; }
    lock.current = true; setBusy(true);
    try {
      const payload = { ...form, expectedVersion: source.version || 1, displayName: form.displayName.trim(), majors, major: majors[0] || '', skills: splitCsv(form.skills), targetRoles: splitCsv(form.targetRoles), locations: splitCsv(form.locations), industries: splitCsv(form.industries), restrictions: splitCsv(form.restrictions), timeZone: source.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' };
      for (const name of ['graduationYear', 'experienceYears', 'salaryMin', 'salaryMax', 'salaryMonths']) payload[name] = form[name] === '' ? null : Number(form[name]);
      await api.profile.update(payload); try { await refreshUser(); } catch { /* Confirmed write remains saved even if refresh fails. */ } bumpRefresh(); notify('求职画像已保存到你的账户'); navigate('/account');
    } catch (cause) { if (cause.name !== 'AbortError') { setError(cause.message); setConflict(cause.code === 'VERSION_CONFLICT'); } } finally { lock.current = false; setBusy(false); }
  };
  const input = (label, name, { hint, ...options } = {}) => <Field label={label} hint={hint}><input {...options} value={form[name]} onChange={event => update(name, event.target.value)} disabled={busy} /></Field>;
  return <><ol className="account-steps" aria-label="画像填写进度">{['教育背景', '求职意向', '薪资期待'].map((label, index) => <li key={label} className={index <= step ? 'active' : ''} aria-current={step === index ? 'step' : undefined}><span>{index < step ? <Icon name="check" size={14} /> : index + 1}</span>{label}</li>)}</ol><div className="account-page-intro"><h1>{['先认识一下你', '想去哪里，做什么', '聊聊你的薪资期待'][step]}</h1><p>与你的网页账户同步，只影响本人的岗位匹配。</p></div><ActionError error={error} />
    {conflict ? <Notice>其他设备已更新画像，本页内容尚未覆盖云端。请先复制要保留的修改。<Button variant="outline" onClick={() => { if (window.confirm('重新载入会放弃本页尚未保存的修改，继续吗？')) reload(); }}>重新载入云端画像</Button></Notice> : null}
    <form className="account-form" onSubmit={submit}>{step === 0 ? <>{input('姓名或昵称', 'displayName', { required: true, maxLength: 80 })}<div className="account-field-pair"><Field label="最高学历"><select value={form.educationLevel} onChange={e => update('educationLevel', e.target.value)} disabled={busy}><option value="">暂不填写</option>{['高中/中专', '专科', '本科', '硕士', '博士', '其他'].map(value => <option key={value}>{value}</option>)}</select></Field>{input('毕业年份', 'graduationYear', { type: 'number', min: 1980, max: 2100 })}</div>{input('学校', 'school', { maxLength: 200 })}{input('专业方向', 'majors', { maxLength: 1000, hint: `多个专业用逗号分隔${Number.isFinite(majorLimit) && majorLimit >= 0 ? `，当前最多 ${majorLimit} 个` : ''}。不限于技术专业。` })}{input('相关经验年数', 'experienceYears', { type: 'number', min: 0, max: 60, step: 0.5, hint: '0 表示应届或暂无全职经验；空白表示未填写。' })}{input('技能与证书', 'skills', { maxLength: 2000, hint: '多个技能或证书用逗号分隔。' })}</> : null}
    {step === 1 ? <>{input('意向城市', 'locations', { maxLength: 1000, hint: '多个城市用逗号分隔。' })}{input('目标岗位', 'targetRoles', { maxLength: 1000 })}{input('目标行业', 'industries', { maxLength: 1000 })}<Notice>专业与目标岗位可以不同。实际资格、待遇和招聘状态仍以招聘方原始公告为准。</Notice></> : null}
    {step === 2 ? <><div className="account-field-pair"><Field label="币种"><select value={form.salaryCurrency} onChange={e => update('salaryCurrency', e.target.value)} disabled={busy}>{['CNY', 'AUD', 'USD', 'HKD', 'SGD'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="薪资周期"><select value={form.salaryPeriod} onChange={e => update('salaryPeriod', e.target.value)} disabled={busy}><option value="month">月薪</option><option value="year">年薪 / 年包</option><option value="week">周薪</option><option value="hour">时薪</option></select></Field></div><div className="account-field-pair">{input('最低期望（税前）', 'salaryMin', { type: 'number', min: 0 })}{input('理想目标（税前）', 'salaryMax', { type: 'number', min: 0 })}</div>{input('薪资月数', 'salaryMonths', { type: 'number', min: 1, max: 30, hint: '用于年薪比较，不确定时可留空。' })}{input('不能接受的条件', 'restrictions', { maxLength: 1000, hint: '例如长期出差、无薪实习；用逗号分隔。' })}<Notice>填写金额以所选币种为单位，不自动换算汇率。保存画像不会自动发起 AI 评估。</Notice></> : null}
    <div className="account-step-actions">{step > 0 ? <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(current => current - 1)}>上一步</Button> : null}<Button type="submit" disabled={busy || conflict}>{busy ? '保存中…' : step === 2 ? '保存求职画像' : '下一步'}</Button></div></form></>;
}

export function OnboardingPage() {
  const resource = useResource(async signal => { const [profile, entitlements] = await Promise.all([api.profile.get(signal), api.billing.entitlements(signal)]); return { profile: profile.profile || {}, entitlements }; }, []);
  return <Page title="求职画像" className="account-page account-onboarding">{resource.data ? <><ActionError error={resource.error?.message} /><ProfileForm key={`${resource.data.profile.userId || ''}:${resource.data.profile.version || 1}`} source={resource.data.profile} entitlements={resource.data.entitlements} reload={resource.reload} /></> : <ResourceState resource={resource} />}</Page>;
}
