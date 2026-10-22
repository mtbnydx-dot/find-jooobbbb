import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page, Button, Field, Notice } from '../components/UI';
import Icon from '../components/Icon';
import { useDemo } from '../demo/state';
import './account.css';

export function AuthPage({ mode = 'login' }) {
  const { patch, notify } = useDemo();
  const navigate = useNavigate();
  const [submittedMode, setSubmittedMode] = useState(null);
  const register = mode === 'register'; const forgot = mode === 'forgot';
  const title = forgot ? '找回密码' : register ? '创建演示账号' : '欢迎回来';
  const submit = event => {
    event.preventDefault();
    if (forgot) { event.currentTarget.reset(); setSubmittedMode(mode); return; }
    event.currentTarget.reset();
    patch({ signedIn: true });
    notify(register ? '已进入本地演示，没有创建真实账号' : '演示登录完成，密码未保存');
    navigate('/onboarding');
  };
  return <Page title={forgot ? '找回密码' : '账号'} className="account-page account-auth"><div className="account-auth-logo">职路</div><div className="account-page-intro"><h1>{title}</h1><p>{forgot ? '看看账号恢复会如何进行。' : '从认识自己，到找到更合适的机会。'}</p></div><Notice>这是独立登录演示，不连接真实账号。请使用虚构邮箱与演示字符，勿输入真实密码。</Notice>{forgot && submittedMode === mode ? <section className="account-auth-success" role="status"><Icon name="mail" size={36} /><h2>找回流程已演示</h2><p>邮件服务未接通，没有发送任何邮件，也没有修改账号。正式服务接通后才会通过验证链接处理。</p><Button className="account-full" onClick={() => navigate('/auth/login')}>返回登录</Button></section> : <form className="account-form" key={mode} onSubmit={submit}><Field label="演示邮箱"><input name="email" type="email" required maxLength={120} autoComplete="off" placeholder="hello@example.invalid" /></Field>{!forgot ? <Field label="演示密码" hint="至少 6 位，仅用于当前表单，不会保存。"><input name="password" type="password" required minLength={6} maxLength={80} autoComplete="off" placeholder="请勿使用真实密码" /></Field> : null}{register ? <label className="account-consent"><input type="checkbox" required /><span>我了解这是本地界面演示，不会注册真实账号。</span></label> : null}<Button className="account-full" type="submit">{forgot ? '演示找回流程' : register ? '开始本地体验' : '演示登录'}</Button>{!forgot ? <div className="account-auth-links"><Link to={register ? '/auth/login' : '/auth/register'}>{register ? '已有演示账号？登录' : '创建演示账号'}</Link><Link to="/auth/forgot">忘记密码</Link></div> : null}</form>}<Link className="account-auth-skip" to="/discover">先看看示例岗位<Icon name="chevron" size={16} /></Link></Page>;
}

export function OnboardingPage() {
  const { state, patch, notify } = useDemo();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState(() => ({ ...state.profile }));
  const update = (field, value) => setProfile(current => ({ ...current, [field]: value }));
  const submit = event => {
    event.preventDefault();
    if (step === 0 && (!profile.name.trim() || !profile.major.trim())) { notify('请填写称呼与专业'); return; }
    if (step === 1 && (!profile.city.trim() || !profile.role.trim())) { notify('请填写意向城市与岗位'); return; }
    if (step < 2) { setStep(current => current + 1); return; }
    patch(current => ({ profile: { ...current.profile, ...Object.fromEntries(Object.entries(profile).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])) } }));
    notify('求职画像已保存在本地，没有发送给 AI 或服务器'); navigate('/account');
  };
  const titles = ['先认识一下你', '想去哪里，做什么', '聊聊你的薪资期待'];
  return <Page title="求职画像" className="account-page account-onboarding"><ol className="account-steps" aria-label="画像填写进度">{['教育背景', '求职意向', '薪资期待'].map((label, index) => <li key={label} className={index <= step ? 'active' : ''} aria-current={step === index ? 'step' : undefined}><span>{index < step ? <Icon name="check" size={14} /> : index + 1}</span>{label}</li>)}</ol><div className="account-page-intro"><h1>{titles[step]}</h1><p>这些信息只用于当前原型的本地展示。</p></div><form className="account-form" onSubmit={submit}>
    {step === 0 ? <><Field label="如何称呼你"><input value={profile.name} required maxLength={12} onChange={e => update('name', e.target.value)} placeholder="例如：小路" /></Field><div className="account-field-pair"><Field label="最高学历"><select value={profile.education} onChange={e => update('education', e.target.value)}>{['高中/中职', '大专', '本科', '硕士', '博士', '其他'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="毕业年份"><input inputMode="numeric" type="number" min="1960" max="2040" required value={profile.year} onChange={e => update('year', e.target.value)} /></Field></div><Field label="专业" hint="不限于技术专业，可填写完整专业名称。"><input required maxLength={40} value={profile.major} onChange={e => update('major', e.target.value)} placeholder="例如：会计学、汉语言文学、设计" /></Field></> : null}
    {step === 1 ? <><Field label="意向城市"><input required maxLength={40} value={profile.city} onChange={e => update('city', e.target.value)} placeholder="例如：上海，也可以填写多个城市" /></Field><Field label="意向岗位"><input required maxLength={50} value={profile.role} onChange={e => update('role', e.target.value)} placeholder="例如：人力资源、财务、产品设计" /></Field><Notice>专业与岗位可以不同。真实岗位资格仍要根据招聘方公告逐项确认。</Notice></> : null}
    {step === 2 ? <><Field label="期望薪资" hint="可写月薪、年薪或暂未确定；请注明单位。"><input maxLength={40} value={profile.salary} onChange={e => update('salary', e.target.value)} placeholder="例如：12–18K/月，或暂未确定" /></Field><section className="account-profile-summary"><h2>你的求职方向</h2><p>{profile.education} · {profile.year}届 · {profile.major}</p><p>{profile.city} · {profile.role}</p></section><Notice>这里不估算薪资、不进行真实岗位匹配，也不调用 AI。之后随时可以回来修改。</Notice></> : null}
    <div className="account-step-actions">{step > 0 ? <Button type="button" variant="outline" onClick={() => setStep(current => current - 1)}>上一步</Button> : null}<Button type="submit">{step === 2 ? '保存本地画像' : '下一步'}{step < 2 ? <Icon name="chevron" size={17} /> : null}</Button></div>
  </form></Page>;
}
