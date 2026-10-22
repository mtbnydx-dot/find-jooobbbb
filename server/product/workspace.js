'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeJobFilters } = require('./job-filters');
const ROLES = ['user', 'content_editor', 'admin'];
const FALLBACK = { 'savedSearches.limit': 3, 'offers.limit': 3, 'studyPlans.limit': 2 };
function fail(message, statusCode = 400, code = 'INVALID_INPUT') {
  const { ProductError } = require('./platform');
  throw new ProductError(message, statusCode, code);
}
function text(value, name, max = 500, required = false) {
  if (value != null && typeof value !== 'string') fail(`${name}格式不正确`);
  const result = String(value || '').trim();
  if ((required && !result) || result.length > max || result.includes('\0')) fail(`${name}为空或过长`);
  return result;
}
function number(value, name, fallback = null, max = 100000000) {
  if (value === '' || value == null) return fallback;
  if (!['string','number'].includes(typeof value)) fail(`${name}格式不正确`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > max) fail(`${name}超出有效范围`);
  return result;
}
function date(value, name) {
  const result = text(value, name, 10);
  if (result && (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0,10) !== result)) fail(`${name}需为有效日期`);
  return result;
}
function url(value) {
  const result = text(value, '申请链接', 2000);
  if (!result) return '';
  try { const parsed = new URL(result); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('请填写有效的 HTTP/HTTPS 链接'); }
  catch { fail('请填写有效的 HTTP/HTTPS 链接'); }
  return result;
}
function own(platform, user) { platform.requireRole(user, ROLES); return platform.store.db; }
function quota(platform, user, table, key) {
  const limit = Number(platform.store.getUserPlan(user.id)?.entitlements?.[key] ?? FALLBACK[key]);
  const used = Number(platform.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(user.id).n);
  if (limit >= 0 && used >= limit) fail('已达到当前套餐的保存上限，可删除不再需要的项目或升级会员', 403, 'ENTITLEMENT_LIMIT');
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
function stamp(platform) { return new Date(platform.clock()).toISOString(); }
function row(row) { return row ? { ...JSON.parse(row.payload_json), id:row.id, createdAt:row.created_at, updatedAt:row.updated_at } : null; }
function list(platform, user, table) { return own(platform,user).prepare(`SELECT * FROM ${table} WHERE user_id=? ORDER BY updated_at DESC,id`).all(user.id).map(row); }
function save(platform, user, table, key, input, id = '') {
  const db = own(platform,user);
  return transaction(db, () => {
    const existing = id ? db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id,user.id) : null;
    if (id && !existing) fail('记录不存在',404,'NOT_FOUND');
    if (!existing) quota(platform,user,table,key);
    const current = stamp(platform);
    const recordId = id || randomUUID();
    db.prepare(`INSERT INTO ${table}(id,user_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`).run(recordId,user.id,JSON.stringify(input),existing?.created_at || current,current);
    return row(db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(recordId,user.id));
  });
}
function remove(platform,user,table,id) {
  if (!own(platform,user).prepare(`DELETE FROM ${table} WHERE id=? AND user_id=?`).run(id,user.id).changes) fail('记录不存在',404,'NOT_FOUND');
  return {deleted:true};
}
function cleanFilters(input = {}) {
  return normalizeJobFilters(input, { requireSalaryCurrency: true });
}
function searchSignature(filters) {
  return JSON.stringify(Object.entries(cleanFilters(filters)).sort(([left], [right]) => left.localeCompare(right)));
}
function storedSearchSignature(record) {
  // Old versions allowed unchecked enums. One legacy record must not prevent new saves.
  try { return searchSignature(JSON.parse(record.payload_json).filters); }
  catch (_) { return null; }
}
function saveSearch(platform, user, input, id = '') {
  const db = own(platform, user);
  const name = text(input.name, '搜索名称', 100, true);
  const filters = cleanFilters(input.filters);
  return transaction(db, () => {
    const records = db.prepare('SELECT * FROM saved_searches WHERE user_id=? ORDER BY created_at,id').all(user.id);
    const existing = id ? records.find(record => record.id === id) : null;
    if (id && !existing) fail('搜索不存在', 404, 'NOT_FOUND');
    const signature = searchSignature(filters);
    const changed = existing && storedSearchSignature(existing) !== signature;
    const duplicate = records.find(record => record.id !== id && storedSearchSignature(record) === signature);
    // Repeating a save must not consume another plan slot or rename prior work.
    if (duplicate) {
      if (changed) fail('已有相同筛选条件的搜索，请打开已有搜索或调整条件', 409, 'DUPLICATE_SEARCH');
      if (!id) return { item: row(duplicate), duplicate: true };
    }
    if (!existing) quota(platform, user, 'saved_searches', 'savedSearches.limit');
    const current = stamp(platform);
    const recordId = id || randomUUID();
    db.prepare('INSERT INTO saved_searches(id,user_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at')
      .run(recordId, user.id, JSON.stringify({ name, filters }), existing?.created_at || current, current);
    // A changed query establishes a fresh notification baseline, not an old-query backlog.
    if (changed && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_search_delivery'").get()) {
      db.prepare('DELETE FROM saved_search_delivery WHERE search_id=? AND user_id=?').run(recordId, user.id);
    }
    return { item: row(db.prepare('SELECT * FROM saved_searches WHERE id=? AND user_id=?').get(recordId, user.id)), duplicate: false };
  });
}
function offerInput(input) {
  const period = text(input.period || 'month','薪资周期');
  if (!['month','year','week','hour'].includes(period)) fail('薪资周期不支持');
  const currency = text(input.currency || 'CNY','币种',3).toUpperCase();
  if (!['CNY','AUD','USD','HKD','SGD','EUR','GBP','JPY','CAD','NZD'].includes(currency)) fail('请选择支持的币种');
  const status = text(input.status || 'considering','状态');
  if (!['considering','negotiating','accepted','declined'].includes(status)) fail('Offer 状态不支持');
  const base = number(input.base,'固定薪资');
  const months = number(input.months,'发薪月数',12,30);
  const hoursPerWeek = number(input.hoursPerWeek,'每周工时',null,168);
  const bonus = number(input.guaranteedBonus,'保证奖金');
  if (period === 'month' && months < 1) fail('发薪月数至少为1');
  const annualBase = base === null ? null : period === 'year' ? base : period === 'month' ? base * months : period === 'week' ? base * 52 : hoursPerWeek ? base * hoursPerWeek * 52 : null;
  return { company:text(input.company,'公司',150,true),position:text(input.position,'岗位',150,true),location:text(input.location,'地点',150),currency,period,base,months,hoursPerWeek,
    guaranteedBonus:bonus,annualBase,knownAnnualCash:annualBase === null ? null : Math.round((annualBase + (bonus ?? 0))*100)/100,
    bonusDisclosed:bonus !== null, equity:text(input.equity,'股权',1000),benefits:text(input.benefits,'福利',2000),note:text(input.note,'备注',4000),deadline:date(input.deadline,'答复日期'),status };
}
function studyInput(input) {
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 40) fail('每个计划需要 1 至 40 个任务');
  return {title:text(input.title,'计划名称',150,true),targetDate:date(input.targetDate,'目标日期'),trackId:text(input.trackId,'学习方向',200),
    tasks:input.tasks.map((task,index)=>({id:text(task.id || `task-${index}`,'任务编号',100,true),title:text(task.title,'任务名称',300,true),done:task.done === true}))};
}
function initializeWorkspace(platform) {
  for (const table of ['saved_searches','user_offers','study_plans']) platform.store.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS ${table}_user_idx ON ${table}(user_id,updated_at);`);
}
function workspaceExport(platform,user) {
  return { savedSearches:list(platform,user,'saved_searches'),offers:list(platform,user,'user_offers'),studyPlans:list(platform,user,'study_plans') };
}
function workspaceNotifications(platform,user) {
  const db=own(platform,user); const current=stamp(platform);
  const profile=platform.getProfile(user.id);
  const insert=db.prepare('INSERT OR IGNORE INTO user_notifications(user_id,id,title,body,link,created_at) VALUES(?,?,?,?,?,?)');
  // Compare date-only deadlines in the user's timezone, not the server timezone.
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en',{timeZone:profile?.timeZone || 'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(platform.clock())).map(part=>[part.type,part.value]));
  const today=`${parts.year}-${parts.month}-${parts.day}`;
  for (const offer of list(platform,user,'user_offers')) {
    const days=(Date.parse(offer.deadline)-Date.parse(today))/86400000;
    if (['considering','negotiating'].includes(offer.status) && days >= 0 && days <= 3) insert.run(user.id,`offer:${offer.id}:${offer.deadline}`,'Offer 即将到答复日',`${offer.company} · ${offer.deadline} 前确认下一步`,'/workspace?tab=offers',current);
  }
  if (profile?.notificationPrep !== false) for (const plan of list(platform,user,'study_plans')) {
    if (plan.targetDate && plan.targetDate <= today && plan.tasks.some(task=>!task.done)) insert.run(user.id,`study:${plan.id}:${plan.targetDate}`,'学习计划待完成',`${plan.title} · 查看剩余任务`,'/workspace?tab=study',current);
  }
}
function saveCustomJob(platform,user,input,id='') {
  const db=own(platform,user);
  return transaction(db,()=>{
    const records=platform.store.listUserCustomJobs(user.id);
    const existing=id?records.find(item=>item.id===id):null;
    if(id&&!existing)fail('自选机会不存在',404,'NOT_FOUND');
    const job={id:id||`private-${randomUUID()}`,company:text(input.company,'公司',150,true),position:text(input.position,'岗位',150,true),location:text(input.location,'地点',150),url:url(input.url),deadline:date(input.deadline,'截止日期'),salary:text(input.salary,'薪资',200),description:text(input.description,'说明',4000),active:'1',source:'自选',firstSeenAt:existing?.firstSeenAt||stamp(platform),updatedAt:stamp(platform)};
    const duplicate=records.find(item=>item.id!==id && item.company.toLowerCase()===job.company.toLowerCase() && item.position.toLowerCase()===job.position.toLowerCase() && String(item.location||'').toLowerCase()===job.location.toLowerCase());
    if(duplicate)fail('你已经添加过这个公司、岗位和地点的自选机会',409,'DUPLICATE_JOB');
    if(!existing&&records.length>=1000)fail('自选岗位已达1000条，请整理后再添加',403,'ENTITLEMENT_LIMIT');
    db.prepare('INSERT INTO user_custom_jobs(user_id,job_id,job_json,migrated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,job_id) DO UPDATE SET job_json=excluded.job_json').run(user.id,job.id,JSON.stringify(job),stamp(platform));
    if(!existing)platform.store.updateJobState(user.id,job.id,{status:'saved',saved:true,favorite:false,hidden:false,note:'',nextAction:'',appliedAt:'',followUpAt:''});
    return {job:platform.getJob(job.id,user)};
  });
}
function registerWorkspaceRoutes(router,{platform,requireAuth}) {
  const route=(method,path,fn,status=200)=>router[method](path,requireAuth,(req,res,next)=>{try{res.status(status).json({ok:true,...fn(req.productUser,req)});}catch(error){next(error);}});
  route('get','/me/workspace',(user)=>({...workspaceExport(platform,user),customJobs:platform.store.listUserCustomJobs(user.id),limits:platform.store.getUserPlan(user.id).entitlements}));
  route('post','/me/saved-searches',(user,req)=>saveSearch(platform,user,req.body),201);
  route('put','/me/saved-searches/:id',(user,req)=>saveSearch(platform,user,req.body,req.params.id));
  route('delete','/me/saved-searches/:id',(user,req)=>remove(platform,user,'saved_searches',req.params.id));
  route('get','/me/saved-searches/:id/results',(user,req)=>{
    const item=list(platform,user,'saved_searches').find(item=>item.id===req.params.id);if(!item) fail('搜索不存在',404,'NOT_FOUND');
    return {item,...platform.listJobs({user,filters:item.filters,cursor:req.query.cursor || '',limit:24})};
  });
  for (const [path,table,key,clean] of [['offers','user_offers','offers.limit',offerInput],['study-plans','study_plans','studyPlans.limit',studyInput]]) {
    route('post',`/me/${path}`,(user,req)=>({item:save(platform,user,table,key,clean(req.body))}),201);
    route('put',`/me/${path}/:id`,(user,req)=>({item:save(platform,user,table,key,clean(req.body),req.params.id)}));
    route('delete',`/me/${path}/:id`,(user,req)=>remove(platform,user,table,req.params.id));
  }
  route('post','/me/custom-jobs',(user,req)=>saveCustomJob(platform,user,req.body),201);
  route('put','/me/custom-jobs/:id',(user,req)=>saveCustomJob(platform,user,req.body,req.params.id));
  route('delete','/me/custom-jobs/:id',(user,req)=>transaction(own(platform,user),()=>{
    const db=platform.store.db;
    if(!db.prepare('DELETE FROM user_custom_jobs WHERE user_id=? AND job_id=?').run(user.id,req.params.id).changes)fail('自选机会不存在',404,'NOT_FOUND');
    db.prepare('DELETE FROM job_states WHERE user_id=? AND job_id=?').run(user.id,req.params.id);
    platform._rankings?.clear();
    return {deleted:true};
  }));
}

module.exports={initializeWorkspace,registerWorkspaceRoutes,workspaceExport,workspaceNotifications,offerInput,cleanFilters};
