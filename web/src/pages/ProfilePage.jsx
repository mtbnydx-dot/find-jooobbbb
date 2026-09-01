import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { TagInput } from '../components/TagInput';
import { ErrorState, LoadingState } from '../components/StatusViews';
import { api } from '../lib/api';
import { browserTimeZone, fromCsv, toCsv, userDisplayName } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { useOnline } from '../hooks/useOnline';

const initialProfile = {
  displayName: '', educationLevel: '', school: '', graduationYear: '', experienceYears: '', majorCategory: '', majors: [], major: '',
  skills: '', targetRoles: '', targetIndustries: '', preferredLocations: '', workModes: [],
  currency: 'CNY', salaryPeriod: 'month', salaryMin: '', salaryMax: '', salaryMonths: '12', restrictions: '',
  notificationDeadline: true, notificationRecommendation: true, notificationPrep: true,
};

function profileForm(data) {
  const source = data?.profile || data || {};
  const majors = Array.isArray(source.majors) && source.majors.length ? source.majors : fromCsv(source.major);
  return {
    ...initialProfile, ...source,
    majors,
    major: majors[0] || source.major || '',
    skills: toCsv(source.skills), targetRoles: toCsv(source.targetRoles), targetIndustries: toCsv(source.targetIndustries),
    preferredLocations: toCsv(source.preferredLocations), restrictions: toCsv(source.restrictions),
    workModes: Array.isArray(source.workModes) ? source.workModes : [],
  };
}

export function ProfilePage() {
  const { user, setUser, logout } = useAuth();
  const online = useOnline();
  const [form, setForm] = useState(initialProfile);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [entitlements, setEntitlements] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    Promise.all([api.profile.get(controller.signal), api.billing.entitlements(controller.signal)]).then(([data, entitlementData]) => {
      setForm(profileForm(data));
      setEntitlements(entitlementData);
    }).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [reloadKey]);

  const completion = useMemo(() => {
    const fields = [form.educationLevel, form.majors.length, form.skills, form.targetRoles, form.preferredLocations, form.salaryMin, form.salaryMax];
    return Math.round((fields.filter(value => String(value || '').trim()).length / fields.length) * 100);
  }, [form]);

  const majorLimit = entitlements?.values?.['profile.majors']?.limit;

  const update = event => {
    const { name, type, checked, value } = event.target;
    setForm(current => ({ ...current, [name]: type === 'checkbox' ? checked : value }));
    setSaved(false);
  };
  const toggleMode = mode => setForm(current => ({ ...current, workModes: current.workModes.includes(mode) ? current.workModes.filter(item => item !== mode) : [...current.workModes, mode] }));

  const save = async event => {
    event.preventDefault();
    if (form.salaryMin && form.salaryMax && Number(form.salaryMin) > Number(form.salaryMax)) return setError('最低期望薪资不能高于最高期望薪资');
    if (form.experienceYears !== '' && (Number(form.experienceYears) < 0 || Number(form.experienceYears) > 60)) return setError('相关经验年数需在 0 到 60 之间');
    setSaving(true); setError(''); setSaved(false);
    try {
      const payload = {
        ...form,
        majors: form.majors,
        major: form.majors[0] || '',
        timeZone: browserTimeZone(),
        graduationYear: form.graduationYear ? Number(form.graduationYear) : null,
        experienceYears: form.experienceYears === '' || form.experienceYears === null ? null : Number(form.experienceYears),
        salaryMin: form.salaryMin ? Number(form.salaryMin) : null,
        salaryMax: form.salaryMax ? Number(form.salaryMax) : null,
        salaryMonths: form.salaryMonths ? Number(form.salaryMonths) : null,
        skills: fromCsv(form.skills), targetRoles: fromCsv(form.targetRoles), targetIndustries: fromCsv(form.targetIndustries),
        preferredLocations: fromCsv(form.preferredLocations), restrictions: fromCsv(form.restrictions),
      };
      await api.profile.update(payload);
      setUser({ ...user, displayName: form.displayName || userDisplayName(user), profileCompletion: completion, profileCompleted: completion === 100 });
      setSaved(true);
    } catch (requestError) { setError(requestError.message); } finally { setSaving(false); }
  };

  if (loading) return <div className="page"><LoadingState rows={6} /></div>;
  if (error && !form.majors.length && !form.targetRoles) return <div className="page"><ErrorState message={error} onRetry={() => setReloadKey(value => value + 1)} /></div>;

  return (
    <div className="page profile-page">
      <header className="page-header profile-header">
        <div className="profile-identity"><span>{userDisplayName(user).slice(0, 1)}</span><div><h1>{userDisplayName(user)}同学</h1><p>{user?.email}</p></div></div>
        <div className="profile-completion"><strong>{completion}%</strong><span>画像完整度</span><i><b style={{ width: `${completion}%` }} /></i></div>
      </header>
      <div className="profile-layout">
        <form className="profile-form" onSubmit={save}>
          {error && <div className="form-error" role="alert">{error}</div>}
          {saved && <div className="form-success" role="status"><Icon name="checkCircle" size={18} />画像已保存，新的推荐会逐步更新。</div>}
          <section className="profile-section"><div><h2>基本信息</h2><p>帮助我们判断学历、专业与岗位要求。</p></div><div className="profile-fields">
            <div className="field-grid two">
              <label className="field"><span>姓名或昵称</span><input name="displayName" value={form.displayName} onChange={update} placeholder={userDisplayName(user)} /></label>
              <label className="field"><span>最高学历</span><select name="educationLevel" value={form.educationLevel} onChange={update}><option value="">请选择</option><option>高中/中专</option><option>专科</option><option>本科</option><option>硕士</option><option>博士</option><option>其他</option></select></label>
              <label className="field"><span>学校</span><input name="school" value={form.school} onChange={update} /></label>
              <label className="field"><span>毕业年份</span><input name="graduationYear" type="number" min="1980" max="2100" value={form.graduationYear} onChange={update} /></label>
              <label className="field"><span>相关经验年数</span><input name="experienceYears" type="number" min="0" max="60" step="0.5" value={form.experienceYears} onChange={update} placeholder="0 表示应届或暂无全职经验" /></label>
              <label className="field"><span>专业大类</span><select name="majorCategory" value={form.majorCategory} onChange={update}><option value="">请选择</option><option>计算机与信息技术</option><option>工程与制造</option><option>商科与管理</option><option>经济与金融</option><option>人文与社会科学</option><option>艺术与设计</option><option>医疗与生命科学</option><option>教育与语言</option><option>法律与公共事务</option><option>其他/跨专业</option></select></label>
            </div>
            <TagInput label="具体专业" items={form.majors} limit={majorLimit} onChange={majors => { setForm(current => ({ ...current, majors, major: majors[0] || '' })); setSaved(false); }} placeholder="例如 数据科学、机械工程、市场营销" />
            <label className="field"><span>技能与证书</span><textarea name="skills" value={form.skills} onChange={update} placeholder="用逗号分隔" /></label>
          </div></section>

          <section className="profile-section"><div><h2>求职目标</h2><p>支持多个方向和跨专业求职。</p></div><div className="profile-fields">
            <label className="field"><span>目标岗位</span><textarea name="targetRoles" value={form.targetRoles} onChange={update} placeholder="例如 数据分析师、产品经理" /></label>
            <label className="field"><span>目标行业</span><input name="targetIndustries" value={form.targetIndustries} onChange={update} /></label>
            <label className="field"><span>意向城市</span><input name="preferredLocations" value={form.preferredLocations} onChange={update} /></label>
            <fieldset className="choice-field"><legend>工作方式</legend><div>{['现场', '混合办公', '远程'].map(mode => <button className={form.workModes.includes(mode) ? 'selected' : ''} type="button" aria-pressed={form.workModes.includes(mode)} key={mode} onClick={() => toggleMode(mode)}>{form.workModes.includes(mode) && <Icon name="check" size={15} />}{mode}</button>)}</div></fieldset>
          </div></section>

          <section className="profile-section"><div><h2>薪酬与边界</h2><p>用于筛选和比较，不会展示给招聘方。</p></div><div className="profile-fields">
            <div className="field-grid three"><label className="field"><span>币种</span><select name="currency" value={form.currency} onChange={update}><option value="CNY">CNY</option><option value="AUD">AUD</option><option value="USD">USD</option><option value="HKD">HKD</option><option value="SGD">SGD</option></select></label><label className="field"><span>周期</span><select name="salaryPeriod" value={form.salaryPeriod} onChange={update}><option value="hour">时薪</option><option value="week">周薪</option><option value="month">月薪</option><option value="year">年薪/年包</option></select></label><label className="field"><span>薪资月数</span><input name="salaryMonths" type="number" min="1" max="30" value={form.salaryMonths} onChange={update} /></label><label className="field"><span>最低期望（税前）</span><input name="salaryMin" type="number" min="0" value={form.salaryMin} onChange={update} /></label><label className="field"><span>理想目标（税前）</span><input name="salaryMax" type="number" min="0" value={form.salaryMax} onChange={update} /></label></div>
            <label className="field"><span>不能接受的条件</span><textarea name="restrictions" value={form.restrictions} onChange={update} placeholder="例如 长期出差、无薪实习" /></label>
          </div></section>

          <section className="profile-section"><div><h2>提醒偏好</h2><p>偏好会保存；邮件和原生推送需配置发送渠道后启用。</p></div><div className="profile-fields toggle-list">
            <label><span><strong>截止日期提醒</strong><small>用于后续截止提醒</small></span><input name="notificationDeadline" type="checkbox" checked={form.notificationDeadline} onChange={update} /></label>
            <label><span><strong>新岗位推荐</strong><small>用于后续高匹配提醒</small></span><input name="notificationRecommendation" type="checkbox" checked={form.notificationRecommendation} onChange={update} /></label>
            <label><span><strong>每日备考计划</strong><small>用于后续练习提醒</small></span><input name="notificationPrep" type="checkbox" checked={form.notificationPrep} onChange={update} /></label>
          </div></section>
          <div className="profile-save-bar"><span>{saved ? '所有更改已保存' : '修改后记得保存'}</span><button className="button primary" type="submit" disabled={saving || !online}>{saving ? '保存中…' : '保存画像'}</button></div>
        </form>
        <aside className="account-aside">
          <section><span className="aside-icon"><Icon name="crown" /></span><h2>当前套餐</h2><strong>{entitlements?.plan?.name || '免费版'}</strong><p>{Number.isFinite(Number(majorLimit)) && Number(majorLimit) >= 0 ? `可保存 ${majorLimit} 个专业方向；` : ''}岗位匹配解释对所有套餐开放，付费套餐增加薪酬洞察和更多备考额度。</p><Link className="button primary full" to="/pricing">查看套餐权益</Link></section>
          {user?.role === 'admin' && <section><h2>产品运营</h2><p>管理用户角色与测试套餐授权。</p><Link className="button secondary full" to="/admin/users">进入用户管理</Link></section>}
          <section><h2>账户</h2><p>{user?.email}</p><button className="text-danger" type="button" onClick={logout}><Icon name="logout" size={17} />退出登录</button></section>
        </aside>
      </div>
    </div>
  );
}
