import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { workspaceApi } from '../lib/workspace-api';
import { request } from '../lib/api';
import { ErrorState, LoadingState, EmptyState } from '../components/StatusViews';
import '../styles/workspace.css';

const tabs=[['searches','已保存搜索'],['offers','Offer 对比'],['study','学习计划'],['custom','自选机会']];
const offerDefault={company:'',position:'',location:'',currency:'CNY',period:'month',base:'',months:12,hoursPerWeek:'',guaranteedBonus:'',equity:'',benefits:'',note:'',deadline:'',status:'considering'};
const jobDefault={company:'',position:'',location:'',url:'',deadline:'',salary:'',description:''};
const offerStatuses={considering:'考虑中',negotiating:'沟通中',accepted:'已接受',declined:'已放弃'};
const templates={
  '投递准备':['梳理目标岗位的硬性要求','为目标岗位调整简历与作品集','核对申请链接、材料与截止时间','提交申请并记录下一步'],
  '面试冲刺':['研究公司业务与岗位职责','整理三段 STAR 经历及证据','练习专业问题并复盘薄弱点','准备向面试官提问的问题','模拟面试并记录改进点'],
  '笔试复习':['完成一次练习诊断','整理错题与薄弱知识点','完成针对性专项练习','进行计时模拟并复盘'],
};
function Field({label,name,form,setForm,type='text',required=false,...props}) {
  return <label className="field"><span>{label}</span><input {...props} name={name} type={type} required={required} value={form[name]??''} onChange={e=>setForm(current=>({...current,[name]:e.target.value}))}/></label>;
}
function Usage({count,limit}) {return <span className="workspace-usage">已保存 {count}{Number.isFinite(Number(limit))&&Number(limit)>=0?` / ${limit}`:''} · <Link to="/pricing">会员权益</Link></span>;}
function Money({value,currency}) {return value==null?<span>未披露</span>:<strong>{currency} {Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2})}</strong>;}

const searchLabels = { q:'关键词', location:'地点', major:'专业', role:'岗位方向', industry:'行业', nature:'单位性质', source:'来源', currency:'币种', salaryPeriod:'薪资周期', salaryMin:'最低薪资', salaryMax:'最高薪资', minMatch:'最低匹配分', availability:'招聘状态', qualification:'公开资格', view:'个人进度', deadlineWithin:'截止窗口', sort:'排序' };
const searchValueLabels = {
  salaryPeriod:{month:'月薪',year:'年薪',week:'周薪',hour:'时薪'},
  availability:{active:'未明确截止',all:'含已截止',expired:'已截止'},
  qualification:{all:'全部',no_conflict:'排除明确冲突',pass:'公开条件匹配',unknown:'待核对',fail:'存在明确风险'},
  view:{all:'全部可见',saved:'已收藏',unapplied:'尚未投递',applied:'已投递',hidden:'已隐藏'},
  sort:{match:'规则匹配',relevance:'关键词相关',deadline:'截止时间',salary:'薪资',latest:'首次收录'},
};
function searchSummary(filters = {}) {
  return Object.entries(filters).filter(([key, value]) => searchLabels[key] && value !== '' && value !== null && value !== undefined && !(key === 'minMatch' && !Number(value)))
    .map(([key,value]) => `${searchLabels[key]}：${searchValueLabels[key]?.[value] || (key === 'deadlineWithin' ? `${value} 天内` : value)}`).join(' · ') || '全部可见岗位';
}
function SearchCard({ search, busy, run, remove }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(search.name);
  const query = new URLSearchParams(Object.fromEntries(Object.entries(search.filters || {}).filter(([,value]) => value !== '' && value !== null && value !== undefined)));
  const destination = `/jobs?${query}`;
  return <article><div><h3>{search.name}</h3><p>{searchSummary(search.filters)}</p>
    {editing && <form className="workspace-actions" onSubmit={async event => { event.preventDefault(); if (await run(() => request(`/me/saved-searches/${encodeURIComponent(search.id)}`, { method:'PUT', body:{name,filters:search.filters} }), '搜索名称已更新')) setEditing(false); }}><input aria-label="搜索新名称" required maxLength={100} value={name} onChange={event=>setName(event.target.value)} disabled={busy}/><button className="button secondary" disabled={busy || !name.trim()}>保存名称</button><button className="button secondary" type="button" disabled={busy} onClick={()=>setEditing(false)}>取消</button></form>}
  </div><div className="workspace-actions"><Link className="button secondary" to={destination}>查看结果</Link><Link className="button secondary" to={destination} state={{editSearch:{id:search.id,name:search.name}}}>调整条件</Link><button className="button secondary" disabled={busy} onClick={()=>{setName(search.name);setEditing(true);}}>重命名</button><button className="text-danger" disabled={busy} onClick={()=>remove(()=>workspaceApi.deleteSearch(search.id),'这条搜索')}>删除</button></div></article>;
}

function OfferForm({offer,setOffer,offerId,setOfferId,busy,run}) {
  return <form id="offer-form" className="workspace-form" onSubmit={async e=>{e.preventDefault();if(await run(()=>workspaceApi.saveOffer(offer,offerId),'Offer 已保存，答复日期临近时会显示站内提醒')){setOffer(offerDefault);setOfferId('');}}}>
    <h3>{offerId?'编辑 Offer':'记录一份 Offer'}</h3>
    <div className="workspace-fields">
      <Field label="公司" name="company" form={offer} setForm={setOffer} required maxLength={150}/>
      <Field label="岗位" name="position" form={offer} setForm={setOffer} required maxLength={150}/>
      <Field label="工作地点" name="location" form={offer} setForm={setOffer}/>
      <label className="field"><span>币种</span><select value={offer.currency} onChange={e=>setOffer({...offer,currency:e.target.value})}>{['CNY','AUD','USD','HKD','SGD','EUR','GBP','JPY','CAD','NZD'].map(value=><option key={value}>{value}</option>)}</select></label>
      <Field label="固定薪资（税前，可留空）" name="base" type="number" min="0" step="0.01" form={offer} setForm={setOffer}/>
      <label className="field"><span>薪资周期</span><select value={offer.period} onChange={e=>setOffer({...offer,period:e.target.value})}><option value="month">月薪</option><option value="year">年薪</option><option value="week">周薪</option><option value="hour">时薪</option></select></label>
      {offer.period==='month'&&<Field label="发薪月数" name="months" type="number" min="1" max="30" form={offer} setForm={setOffer}/>}
      {offer.period==='hour'&&<Field label="每周工时" name="hoursPerWeek" type="number" min="0" max="168" form={offer} setForm={setOffer}/>}
      <Field label="年度保证奖金（未知留空）" name="guaranteedBonus" type="number" min="0" step="0.01" form={offer} setForm={setOffer}/>
      <Field label="答复截止日期" name="deadline" type="date" form={offer} setForm={setOffer}/>
      <label className="field"><span>当前决定</span><select value={offer.status} onChange={e=>setOffer({...offer,status:e.target.value})}>{Object.entries(offerStatuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <Field label="股权与浮动奖金" name="equity" form={offer} setForm={setOffer} placeholder="不计入已知年现金"/>
      <Field label="福利与工作方式" name="benefits" form={offer} setForm={setOffer} placeholder="年假、远程、住房、搬迁补贴等"/>
    </div>
    <label className="field"><span>私人备注</span><textarea value={offer.note} onChange={e=>setOffer({...offer,note:e.target.value})} maxLength={4000}/></label>
    <div className="workspace-actions"><button className="button primary" disabled={busy}>{busy?'保存中…':'保存 Offer'}</button>{offerId&&<button className="button secondary" type="button" onClick={()=>{setOffer(offerDefault);setOfferId('');}}>取消编辑</button>}</div>
  </form>;
}
export function WorkspacePage() {
  const [params,setParams]=useSearchParams();
  const tab=tabs.some(([key])=>key===params.get('tab'))?params.get('tab'):'searches';
  const [data,setData]=useState(null),[error,setError]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const [offer,setOffer]=useState(offerDefault),[offerId,setOfferId]=useState('');
  const [study,setStudy]=useState({title:'',targetDate:'',template:'面试冲刺',tasks:templates['面试冲刺'].join('\n')});
  const [job,setJob]=useState(jobDefault),[customId,setCustomId]=useState('');
  useEffect(()=>{const controller=new AbortController();workspaceApi.get(controller.signal).then(setData).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[revision]);
  const run=async(action,success)=>{
    setBusy(true);setError('');setMessage('');
    try {
      const result=await action();setMessage(success);
      // Keep controls disabled until refreshed records arrive; a second checklist
      // edit must not overwrite a first edit using the previous tasks array.
      try {setData(await workspaceApi.get());}
      catch(e){setData(null);setError(`操作已完成，但刷新失败：${e.message}。请刷新后继续。`);}
      return result;
    }catch(e){setError(e.message);return null;}finally{setBusy(false);}
  };
  const remove=(action,label)=>{if(window.confirm(`删除${label}？此操作会移除这条个人记录。`))run(action,'记录已删除');};
  if(!data&&error)return <div className="page"><ErrorState message={error} onRetry={()=>{setError('');setRevision(value=>value+1);}}/></div>;
  if(!data)return <div className="page"><LoadingState rows={5}/></div>;
  return <div className="page workspace-page">
    <header className="page-header"><div><h1>求职工具</h1><p>把值得追踪的机会、待遇和准备计划留在一起。这里的内容仅你可见。</p></div><Link className="button secondary" to="/jobs">继续找岗位</Link></header>
    <nav className="workspace-tabs" aria-label="求职工具">{tabs.map(([key,label])=><button key={key} className={tab===key?'active':''} type="button" aria-current={tab===key?'page':undefined} onClick={()=>{setParams({tab:key});setError('');setMessage('');}}>{label}</button>)}</nav>
    {error&&<div className="form-error" role="alert">{error}</div>}{message&&<div className="form-success" role="status">{message}</div>}
    {tab==='searches'&&<section className="workspace-section"><div className="section-title-row"><h2>不用每次重新筛选</h2><Usage count={data.savedSearches.length} limit={data.limits['savedSearches.limit']}/></div><p>在“找岗位”应用筛选后保存搜索，下次按相同条件查看当前结果。画像或岗位事实变化后，匹配结果可能变化。</p><p>保存搜索不等于订阅通知。<Link to="/account-services">前往通知设置开启新岗位提醒</Link>；首次开启及调整条件后先建立基线，不推送历史结果。</p>
      {data.savedSearches.length?<div className="workspace-list">{data.savedSearches.map(search=><SearchCard key={search.id} {...{search,busy,run,remove}}/>)}</div>:<EmptyState title="保存一次，下次直接用" description="例如“上海品牌岗位”或“远程数据分析”。搜索结果始终来自当前岗位库。" action={<Link className="button primary" to="/jobs">去设置搜索条件</Link>}/>}</section>}
    {tab==='offers'&&<section className="workspace-section"><div className="section-title-row"><h2>比较真正拿到的机会</h2><Usage count={data.offers.length} limit={data.limits['offers.limit']}/></div><p>固定现金与保证奖金单独计算；股权、浮动奖金不计入确定收入。不同币种分别显示，不自动换算。</p>
      {!!data.offers.length&&<div className="offer-comparison" role="region" aria-label="Offer 比较表" tabIndex="0"><table><thead><tr><th>公司 / 岗位</th><th>年化固定薪资</th><th>保证奖金</th><th>已知年现金</th><th>福利与股权</th><th>决定与操作</th></tr></thead><tbody>{data.offers.map(item=><tr key={item.id}><td><strong>{item.company}</strong><span>{item.position}</span><small>{item.location}</small></td><td><Money value={item.annualBase} currency={item.currency}/><small>{item.period==='month'?`${item.months} 薪`:item.period==='hour'?`每周 ${item.hoursPerWeek||'未知'} 小时 × 52 周`:'税前年化'}</small></td><td><Money value={item.guaranteedBonus} currency={item.currency}/></td><td><Money value={item.knownAnnualCash} currency={item.currency}/>{!item.bonusDisclosed&&<small>奖金未披露，仅比较固定部分</small>}</td><td><span>{item.benefits||'福利未记录'}</span><small>{item.equity||'股权未记录'}</small></td><td><span>{offerStatuses[item.status]}</span><small>{item.deadline?`${item.deadline} 前答复`:'未设置答复日'}</small><div className="workspace-actions"><button type="button" onClick={()=>{setOffer({...offerDefault,...item});setOfferId(item.id);document.getElementById('offer-form')?.scrollIntoView({behavior:'smooth',block:'start'});}}>编辑</button><button type="button" className="text-danger" disabled={busy} onClick={()=>remove(()=>workspaceApi.deleteOffer(item.id),'这条 Offer')}>删除</button></div></td></tr>)}</tbody></table></div>}
      <OfferForm {...{offer,setOffer,offerId,setOfferId,busy,run}}/>
    </section>}
    {tab==='study'&&<section className="workspace-section"><div className="section-title-row"><h2>每一天知道该准备什么</h2><Usage count={data.studyPlans.length} limit={data.limits['studyPlans.limit']}/></div>
      <div className="study-plan-list">{data.studyPlans.map(plan=><article key={plan.id}><header><div><h3>{plan.title}</h3><p>{plan.targetDate?`目标 ${plan.targetDate} · `:''}{plan.tasks.filter(task=>task.done).length}/{plan.tasks.length} 项已完成</p></div><button className="text-danger" disabled={busy} onClick={()=>remove(()=>workspaceApi.deleteStudy(plan.id),'这个学习计划')}>删除</button></header><progress value={plan.tasks.filter(task=>task.done).length} max={plan.tasks.length} aria-label={`${plan.title}完成进度`}/><div className="study-checklist">{plan.tasks.map((task,index)=><label key={`${task.id}-${index}`}><input type="checkbox" checked={task.done} disabled={busy} onChange={()=>run(()=>workspaceApi.saveStudy({...plan,tasks:plan.tasks.map((item,i)=>i===index?{...item,done:!item.done}:item)},plan.id),'计划进度已更新')}/><span className={task.done?'done':''}>{task.title}</span></label>)}</div><Link to="/prep">打开备考练习</Link></article>)}</div>
      <form className="workspace-form" onSubmit={async e=>{e.preventDefault();const tasks=study.tasks.split('\n').map(item=>item.trim()).filter(Boolean).map((title,index)=>({id:`task-${index}`,title,done:false}));if(await run(()=>workspaceApi.saveStudy({title:study.title,targetDate:study.targetDate,tasks}),'学习计划已创建'))setStudy({...study,title:'',targetDate:''});}}><h3>制定新计划</h3><div className="workspace-fields"><Field label="计划名称" name="title" form={study} setForm={setStudy} required placeholder="例如 下周产品运营面试"/><Field label="目标日期" name="targetDate" type="date" form={study} setForm={setStudy}/><label className="field"><span>使用准备清单</span><select value={study.template} onChange={e=>setStudy({...study,template:e.target.value,tasks:templates[e.target.value].join('\n')})}>{Object.keys(templates).map(key=><option key={key}>{key}</option>)}</select></label></div><label className="field"><span>任务清单（每行一项，可自行修改）</span><textarea value={study.tasks} onChange={e=>setStudy({...study,tasks:e.target.value})} rows="6" required/></label><button className="button primary" disabled={busy}>{busy?'创建中…':'创建学习计划'}</button></form></section>}
    {tab==='custom'&&<section className="workspace-section"><div className="section-title-row"><h2>把站外机会也纳入进度</h2><span>{data.customJobs.length} 个私人机会</span></div><p>添加来自企业官网、招聘会或朋友推荐的机会，仅自己可见。公开岗位请直接收藏，无需重复添加。</p>
      {!!data.customJobs.length&&<div className="workspace-list">{data.customJobs.map(item=><article key={item.id}><div><h3>{item.company} · {item.position}</h3><p>{item.location||'地点未记录'}{item.deadline?` · ${item.deadline} 截止`:''}</p></div><div className="workspace-actions"><Link className="button secondary" to={`/jobs/${encodeURIComponent(item.id)}`} state={{returnTo:'/workspace?tab=custom'}}>管理进度</Link><button type="button" onClick={()=>{setJob({...jobDefault,...item});setCustomId(item.id);document.getElementById('custom-job-form')?.scrollIntoView({behavior:'smooth'});}}>修改信息</button><button type="button" className="text-danger" disabled={busy} onClick={()=>remove(()=>workspaceApi.deleteCustomJob(item.id),'这个私人机会及其进度、备注')}>删除</button></div></article>)}</div>}
      <form id="custom-job-form" className="workspace-form" onSubmit={async e=>{e.preventDefault();if(await run(()=>workspaceApi.customJob(job,customId),customId?'私人机会信息已更新，进度和备注保留':'私人机会已添加到收藏和求职进度')){setJob(jobDefault);setCustomId('');}}}><h3>{customId?'修改自选机会':'添加自选机会'}</h3><div className="workspace-fields"><Field label="公司名称" name="company" form={job} setForm={setJob} required/><Field label="岗位名称" name="position" form={job} setForm={setJob} required/><Field label="工作地点" name="location" form={job} setForm={setJob}/><Field label="申请链接" name="url" type="url" form={job} setForm={setJob} placeholder="https://"/><Field label="截止日期" name="deadline" type="date" form={job} setForm={setJob}/><Field label="薪资原文" name="salary" form={job} setForm={setJob} placeholder="例如 15–20K · 13薪"/></div><label className="field"><span>岗位说明</span><textarea value={job.description} onChange={e=>setJob({...job,description:e.target.value})} maxLength={4000}/></label><div className="workspace-actions"><button className="button primary" disabled={busy}>{busy?'保存中…':customId?'保存机会信息':'添加到我的进度'}</button>{customId&&<button type="button" className="button secondary" onClick={()=>{setJob(jobDefault);setCustomId('');}}>取消修改</button>}</div></form></section>}
  </div>;
}
