import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { Icon } from '../components/Icon';
import { TagInput } from '../components/TagInput';
import { api } from '../lib/api';
import { browserTimeZone, fromCsv, toCsv } from '../lib/format';
import { useAuth } from '../context/AuthContext';

const steps = ['教育与经历', '目标与偏好', '薪酬与边界'];
const initialForm = {
  educationLevel: '', school: '', graduationYear: '', experienceYears: '', majorCategory: '', majors: [], major: '',
  skills: '', targetRoles: '', targetIndustries: '', preferredLocations: '', workModes: ['现场'],
  currency: 'CNY', salaryPeriod: 'month', salaryMin: '', salaryMax: '', salaryMonths: '12', restrictions: '',
};

function normalizeProfile(data) {
  const source = data?.profile || data || {};
  const majors = Array.isArray(source.majors) && source.majors.length ? source.majors : fromCsv(source.major);
  return {
    ...initialForm,
    ...source,
    majors,
    major: majors[0] || source.major || '',
    skills: toCsv(source.skills),
    targetRoles: toCsv(source.targetRoles),
    targetIndustries: toCsv(source.targetIndustries),
    preferredLocations: toCsv(source.preferredLocations),
    restrictions: toCsv(source.restrictions),
    workModes: Array.isArray(source.workModes) ? source.workModes : initialForm.workModes,
  };
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const { user, setUser } = useAuth();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [entitlements, setEntitlements] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([api.profile.get(controller.signal), api.billing.entitlements(controller.signal)]).then(([profileResult, entitlementResult]) => {
      if (profileResult.status === 'fulfilled') setForm(normalizeProfile(profileResult.value));
      if (entitlementResult.status === 'fulfilled') setEntitlements(entitlementResult.value);
    });
    return () => controller.abort();
  }, []);

  const majorLimit = entitlements?.values?.['profile.majors']?.limit;

  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  const toggleMode = mode => setForm(current => ({
    ...current,
    workModes: current.workModes.includes(mode) ? current.workModes.filter(item => item !== mode) : [...current.workModes, mode],
  }));

  const next = () => {
    setError('');
    if (step === 0 && (!form.educationLevel || !form.majors.length)) return setError('请填写学历并至少添加一个具体专业');
    if (step === 1 && (!form.targetRoles.trim() || !form.preferredLocations.trim())) return setError('请至少填写目标岗位和意向城市');
    setStep(value => Math.min(2, value + 1));
  };

  const finish = async () => {
    if (form.salaryMin && form.salaryMax && Number(form.salaryMin) > Number(form.salaryMax)) return setError('最低期望薪资不能高于最高期望薪资');
    if (form.experienceYears !== '' && (Number(form.experienceYears) < 0 || Number(form.experienceYears) > 60)) return setError('相关经验年数需在 0 到 60 之间');
    setSaving(true);
    setError('');
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
        skills: fromCsv(form.skills),
        targetRoles: fromCsv(form.targetRoles),
        targetIndustries: fromCsv(form.targetIndustries),
        preferredLocations: fromCsv(form.preferredLocations),
        restrictions: fromCsv(form.restrictions),
        onboardingCompleted: true,
      };
      await api.profile.update(payload);
      setUser({ ...user, profileCompleted: true, profileCompletion: 100 });
      navigate('/', { replace: true });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="onboarding-page">
      <header className="onboarding-header"><Brand /><button type="button" onClick={() => navigate('/')}>稍后完善</button></header>
      <div className="onboarding-layout">
        <aside>
          <p>建立你的求职画像</p>
          <h1>让每一次推荐<br />更贴近你的目标</h1>
          <ol>
            {steps.map((label, index) => <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}><i>{index < step ? <Icon name="check" size={15} /> : index + 1}</i><span>{label}</span></li>)}
          </ol>
        </aside>
        <section className="onboarding-form">
          <div className="onboarding-progress"><i style={{ width: `${((step + 1) / steps.length) * 100}%` }} /></div>
          <span className="step-count">第 {step + 1} 步，共 {steps.length} 步</span>
          {error && <div className="form-error" role="alert">{error}</div>}

          {step === 0 && <div className="form-section">
            <h2>先了解你的教育背景</h2><p>专业不设限，后续可以随时修改或添加跨专业方向。</p>
            <div className="field-grid two">
              <label className="field"><span>最高学历 *</span><select name="educationLevel" value={form.educationLevel} onChange={update}><option value="">请选择</option><option>高中/中专</option><option>专科</option><option>本科</option><option>硕士</option><option>博士</option><option>其他</option></select></label>
              <label className="field"><span>毕业年份</span><input name="graduationYear" type="number" min="1980" max="2100" value={form.graduationYear} onChange={update} placeholder="例如 2027" /></label>
              <label className="field"><span>学校</span><input name="school" value={form.school} onChange={update} placeholder="学校名称" /></label>
              <label className="field"><span>相关经验年数</span><input name="experienceYears" type="number" min="0" max="60" step="0.5" value={form.experienceYears} onChange={update} placeholder="0 表示应届或暂无全职经验" /></label>
              <label className="field"><span>专业大类</span><select name="majorCategory" value={form.majorCategory} onChange={update}><option value="">请选择</option><option>计算机与信息技术</option><option>工程与制造</option><option>商科与管理</option><option>经济与金融</option><option>人文与社会科学</option><option>艺术与设计</option><option>医疗与生命科学</option><option>教育与语言</option><option>法律与公共事务</option><option>其他/跨专业</option></select></label>
            </div>
            <TagInput label="具体专业" required items={form.majors} limit={majorLimit} onChange={majors => setForm(current => ({ ...current, majors, major: majors[0] || '' }))} placeholder="例如 数据科学、机械工程、市场营销" />
            <label className="field"><span>技能与证书</span><textarea name="skills" value={form.skills} onChange={update} placeholder="用逗号分隔，例如 Python、SQL、雅思 7.0" /></label>
          </div>}

          {step === 1 && <div className="form-section">
            <h2>你想去哪里、做什么</h2><p>可以同时选择多个方向，我们会分别计算岗位匹配度。</p>
            <label className="field"><span>目标岗位 *</span><textarea name="targetRoles" value={form.targetRoles} onChange={update} placeholder="例如 数据分析师、商业分析、产品经理" /></label>
            <label className="field"><span>目标行业</span><input name="targetIndustries" value={form.targetIndustries} onChange={update} placeholder="例如 互联网、新能源、咨询" /></label>
            <label className="field"><span>意向城市 *</span><input name="preferredLocations" value={form.preferredLocations} onChange={update} placeholder="例如 上海、深圳、远程" /></label>
            <fieldset className="choice-field"><legend>工作方式</legend><div>{['现场', '混合办公', '远程'].map(mode => <button className={form.workModes.includes(mode) ? 'selected' : ''} type="button" aria-pressed={form.workModes.includes(mode)} key={mode} onClick={() => toggleMode(mode)}>{form.workModes.includes(mode) && <Icon name="check" size={15} />}{mode}</button>)}</div></fieldset>
          </div>}

          {step === 2 && <div className="form-section">
            <h2>设定薪酬目标与底线</h2><p>薪资只用于筛选和比较，不会展示给招聘方。</p>
            <div className="field-grid three">
              <label className="field"><span>币种</span><select name="currency" value={form.currency} onChange={update}><option value="CNY">人民币 CNY</option><option value="AUD">澳元 AUD</option><option value="USD">美元 USD</option><option value="HKD">港币 HKD</option><option value="SGD">新币 SGD</option></select></label>
              <label className="field"><span>计薪周期</span><select name="salaryPeriod" value={form.salaryPeriod} onChange={update}><option value="hour">时薪</option><option value="week">周薪</option><option value="month">月薪</option><option value="year">年薪/年包</option></select></label>
              <label className="field"><span>薪资月数</span><input name="salaryMonths" type="number" min="1" max="30" value={form.salaryMonths} onChange={update} /></label>
              <label className="field"><span>最低期望（税前）</span><input name="salaryMin" type="number" min="0" value={form.salaryMin} onChange={update} placeholder="例如 20000" /></label>
              <label className="field"><span>理想目标（税前）</span><input name="salaryMax" type="number" min="0" value={form.salaryMax} onChange={update} placeholder="例如 30000" /></label>
            </div>
            <label className="field"><span>明确不能接受的条件</span><textarea name="restrictions" value={form.restrictions} onChange={update} placeholder="例如 纯销售、长期出差、无薪实习；用逗号分隔" /></label>
          </div>}

          <footer className="onboarding-actions">
            <button className="button secondary" type="button" onClick={() => setStep(value => Math.max(0, value - 1))} disabled={step === 0}>上一步</button>
            {step < 2 ? <button className="button primary" type="button" onClick={next}>下一步 <Icon name="chevronRight" size={18} /></button> : <button className="button primary" type="button" onClick={finish} disabled={saving}>{saving ? '正在保存…' : '完成并查看推荐'}</button>}
          </footer>
        </section>
      </div>
    </main>
  );
}
