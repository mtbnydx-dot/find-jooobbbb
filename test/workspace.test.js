'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('../server/node_modules/express');
const {ProductPlatform,createProductRouter} = require('../server/product');
const {offerInput} = require('../server/product/workspace');

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-tests-'));
  let clock=Date.parse('2026-10-23T10:00:00Z');
  const platform=new ProductPlatform({dataDir,clock:()=>clock,jobService:{snapshot:()=>({jobs:[{id:'public',active:'1',company:'公开企业',position:'设计师',location:'上海'},{id:'expired',active:'1',company:'历史公开企业',position:'设计师',location:'上海',deadline:'2026-10-01'}]})}}).initialize();
  const app=express();app.use('/api/v1',createProductRouter({platform}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));platform.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const account=await platform.register({email:'workspace-a@example.com',password:'workspace-test-password'});
  const other=await platform.register({email:'workspace-b@example.com',password:'workspace-test-password'});
  const call=async(route,body,method=body?'POST':'GET',token=account.token)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,...await response.json()};
  };
  return {platform,account,other,call,setClock:value=>{clock=value;}};
}

test('workspace routes require auth, saved searches obey persisted limits and user isolation',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/me/workspace',undefined,'GET','wrong')).status,401);
  let first;
  for(let i=0;i<3;i++){const saved=await f.call('/me/saved-searches',{name:`搜索${i}`,filters:{location:['上海','北京','深圳'][i]}});assert.equal(saved.status,201);first ||= saved.item;}
  assert.equal((await f.call('/me/saved-searches',{name:'超额',filters:{}})).status,403);
  assert.equal((await f.call('/me/workspace',undefined,'GET',f.other.token)).savedSearches.length,0);
  assert.equal((await f.call(`/me/saved-searches/${first.id}`,undefined,'DELETE',f.other.token)).status,404);
  assert.equal((await f.call(`/me/saved-searches/${first.id}/results`,undefined,'GET',f.other.token)).status,404);
  const results=await f.call(`/me/saved-searches/${first.id}/results`);assert.equal(results.items[0].id,'public');
  assert.equal((await f.call('/me/entitlements')).values['savedSearches.limit'].used,3);
  assert.equal((await f.call(`/me/saved-searches/${first.id}`,undefined,'DELETE')).status,200);
  assert.equal((await f.call('/me/saved-searches',{name:'替换',filters:{}})).status,201);
  assert.equal((await f.call('/me/saved-searches',{name:'坏值',filters:{salaryMin:100}})).status,400);
});

test('saved searches retain recruitment state and the full shared filter contract',async t=>{
  const f=await fixture(t);
  const input={name:'完整条件',filters:{q:'设计',location:'上海',major:'设计',role:'设计师',industry:'互联网',nature:'国企',source:'公开文档',currency:'CNY',salaryPeriod:'month',salaryMin:10000,salaryMax:20000,sort:'relevance',availability:'expired',qualification:'unknown',view:'saved',minMatch:35,deadlineWithin:30}};
  const saved=await f.call('/me/saved-searches',input);assert.equal(saved.status,201);
  for(const [key,value] of Object.entries(input.filters))assert.equal(String(saved.item.filters[key]),String(value),key);
  const exportResult=await f.call('/me/workspace');assert.deepEqual(exportResult.savedSearches[0].filters,saved.item.filters);
  const update=await f.call(`/me/saved-searches/${saved.item.id}`,{name:'历史上海',filters:{location:'上海',availability:'expired'}},'PUT');assert.equal(update.status,200);
  const results=await f.call(`/me/saved-searches/${saved.item.id}/results`);assert.deepEqual(results.items.map(item=>item.id),['expired']);
  assert.equal((await f.call(`/me/saved-searches/${saved.item.id}`,{name:'越权',filters:{}},'PUT',f.other.token)).status,404);
  assert.equal((await f.call('/me/saved-searches',{name:'坏状态',filters:{availability:'made_up'}})).status,400);
});

test('equivalent saved searches are idempotent at quota; names and existing searches can be edited',async t=>{
  const f=await fixture(t);
  const first=await f.call('/me/saved-searches',{name:'原始名称',filters:{location:'上海'}});
  await f.call('/me/saved-searches',{name:'北京',filters:{location:'北京'}});
  await f.call('/me/saved-searches',{name:'深圳',filters:{location:'深圳'}});
  const duplicate=await f.call('/me/saved-searches',{name:'不要覆盖原名',filters:{...first.item.filters,location:' 上海 '}});
  assert.equal(duplicate.status,201);assert.equal(duplicate.duplicate,true);assert.equal(duplicate.item.id,first.item.id);assert.equal(duplicate.item.name,'原始名称');
  assert.equal((await f.call('/me/workspace')).savedSearches.length,3);
  const renamed=await f.call(`/me/saved-searches/${first.item.id}`,{name:'重命名',filters:first.item.filters},'PUT');assert.equal(renamed.status,200);assert.equal(renamed.item.name,'重命名');
  assert.equal((await f.call(`/me/saved-searches/${first.item.id}`,{name:'与北京重复',filters:{location:'北京'}},'PUT')).status,409);
  assert.equal((await f.call(`/me/saved-searches/${first.item.id}`,{name:'改为杭州',filters:{location:'杭州'}},'PUT')).status,200);
  const other=await f.call('/me/saved-searches',{name:'另一位用户上海',filters:{location:'上海'}},'POST',f.other.token);assert.equal(other.duplicate,false);
});

test('renaming retains subscription baseline; changed conditions reset it without touching other searches',async t=>{
  const f=await fixture(t);
  const one=await f.call('/me/saved-searches',{name:'上海',filters:{location:'上海'}});
  const two=await f.call('/me/saved-searches',{name:'北京',filters:{location:'北京'}});
  const db=f.platform.store.db,now=new Date(f.platform.clock()).toISOString();
  for(const search of [one.item,two.item]){
    db.prepare('INSERT INTO saved_search_delivery(search_id,user_id,initialized_at) VALUES(?,?,?)').run(search.id,f.account.user.id,now);
    db.prepare('INSERT INTO saved_search_seen(search_id,job_id) VALUES(?,?)').run(search.id,'public');
  }
  assert.equal((await f.call(`/me/saved-searches/${one.item.id}`,{name:'改名',filters:one.item.filters},'PUT')).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM saved_search_seen WHERE search_id=?').get(one.item.id).n,1);
  assert.equal((await f.call(`/me/saved-searches/${one.item.id}`,{name:'深圳',filters:{location:'深圳'}},'PUT')).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM saved_search_seen WHERE search_id=?').get(one.item.id).n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM saved_search_delivery WHERE search_id=?').get(two.item.id).n,1);
});

test('legacy duplicate searches can be renamed without deleting or merging their records',async t=>{
  const f=await fixture(t);
  const first=(await f.call('/me/saved-searches',{name:'旧搜索一',filters:{location:'上海'}})).item;
  const db=f.platform.store.db,now=new Date(f.platform.clock()).toISOString();
  db.prepare('INSERT INTO saved_searches(id,user_id,payload_json,created_at,updated_at) VALUES(?,?,?,?,?)').run('legacy-duplicate',f.account.user.id,JSON.stringify({name:'旧搜索二',filters:{location:'上海'}}),now,now);
  const renamed=await f.call(`/me/saved-searches/${first.id}`,{name:'旧搜索一改名',filters:{location:' 上海 '}},'PUT');
  assert.equal(renamed.status,200);assert.equal(renamed.item.id,first.id);assert.equal(renamed.item.name,'旧搜索一改名');
  const records=(await f.call('/me/workspace')).savedSearches;assert.equal(records.length,2);assert.equal(records.find(item=>item.id==='legacy-duplicate').name,'旧搜索二');
  assert.equal((await f.call('/me/saved-searches',{name:'新的重复',filters:{location:'上海'}})).duplicate,true);
});

test('Offer calculations preserve unknowns and never convert currencies or count uncertain equity',()=>{
  const base={company:'A',position:'设计师',base:10000,period:'month',months:13,currency:'CNY',guaranteedBonus:5000,equity:'可能价值100万元'};
  const offer=offerInput(base);assert.equal(offer.annualBase,130000);assert.equal(offer.knownAnnualCash,135000);
  assert.equal(offerInput({...base,base:'',guaranteedBonus:''}).knownAnnualCash,null);
  assert.equal(offerInput({...base,guaranteedBonus:''}).bonusDisclosed,false);
  assert.equal(offerInput({...base,currency:'AUD',base:40,period:'hour',hoursPerWeek:38,guaranteedBonus:0}).annualBase,79040);
  assert.equal(offerInput({...base,period:'hour',hoursPerWeek:''}).annualBase,null);
  assert.throws(()=>offerInput({...base,deadline:'2026-02-31'}));
  assert.throws(()=>offerInput({...base,base:-1}));
});

test('offers and study progress remain private, export fully and generate deduplicated reminders',async t=>{
  const f=await fixture(t);
  const offer=await f.call('/me/offers',{company:'私人公司',position:'设计师',base:12000,months:13,guaranteedBonus:5000,deadline:'2026-10-24'});
  assert.equal(offer.status,201);
  assert.equal((await f.call(`/me/offers/${offer.item.id}`,{company:'攻击替换',position:'bad'},'PUT',f.other.token)).status,404);
  const study=await f.call('/me/study-plans',{title:'面试准备',targetDate:'2026-10-23',tasks:[{id:'task',title:'准备STAR案例',done:false}]});assert.equal(study.status,201);
  const updated=await f.call(`/me/study-plans/${study.item.id}`,{...study.item,tasks:[{id:'task',title:'准备STAR案例',done:true}]},'PUT');assert.equal(updated.item.tasks[0].done,true);
  const notices=await f.call('/me/notifications');assert.equal(notices.items.filter(item=>item.id.startsWith('offer:')).length,1);
  assert.equal((await f.call('/me/notifications')).items.filter(item=>item.id.startsWith('offer:')).length,1);
  const other=await f.call('/me/workspace',undefined,'GET',f.other.token);assert.equal(other.offers.length,0);assert.equal(other.studyPlans.length,0);
  const exported=await f.call('/me/export');assert.equal(exported.offers[0].company,'私人公司');assert.equal(exported.studyPlans[0].tasks[0].done,true);
  const deleted=await f.call('/me/account',{password:'workspace-test-password',confirmation:'DELETE'},'DELETE');assert.equal(deleted.status,200);
  assert.equal(f.platform.store.db.prepare('SELECT COUNT(*) AS n FROM user_offers WHERE user_id=?').get(f.account.user.id).n,0);
});

test('private job entry deduplicates, is editable in personal pipeline and never leaks to others',async t=>{
  const f=await fixture(t);
  const input={company:'私人内推',position:'设计师',location:'杭州',url:'https://example.com/job'};
  const created=await f.call('/me/custom-jobs',input);assert.equal(created.status,201);assert.equal(created.job.userState.saved,true);
  assert.equal((await f.call('/me/custom-jobs',input)).status,409);
  assert.equal((await f.call('/me/custom-jobs',{...input,company:'无效链接',url:'javascript:alert(1)'})).status,400);
  assert.equal((await f.call(`/jobs/${created.job.id}`,undefined,'GET',f.other.token)).status,404);
  assert.equal((await f.call(`/me/jobs/${created.job.id}`,{status:'interview',note:'私人准备'},'PUT')).status,200);
  assert.equal((await f.call('/me/pipeline')).items[0].company,'私人内推');
  assert.equal((await f.call(`/me/custom-jobs/${created.job.id}`,{...input,company:'已修正公司'},'PUT',f.other.token)).status,404);
  assert.equal((await f.call(`/me/custom-jobs/${created.job.id}`,{...input,company:'已修正公司'},'PUT')).status,200);
  assert.equal((await f.call(`/jobs/${created.job.id}`)).job.userState.note,'私人准备');
  assert.equal((await f.call('/jobs',undefined,'GET',f.other.token)).jobs.some(job=>job.id===created.job.id),false);
  assert.equal((await f.call(`/me/custom-jobs/${created.job.id}`,undefined,'DELETE',f.other.token)).status,404);
  assert.equal((await f.call(`/me/custom-jobs/${created.job.id}`,undefined,'DELETE')).status,200);
  assert.equal((await f.call('/me/pipeline')).items.length,0);
});

test('expiration prevents new paid-capacity records but preserves editing and export of existing records',async t=>{
  const f=await fixture(t);f.platform.store.setUserPlan(f.account.user.id,'pro');
  const rows=[];for(let i=0;i<4;i++)rows.push((await f.call('/me/offers',{company:`公司${i}`,position:'设计师',base:1000})).item);
  f.platform.store.db.prepare('UPDATE subscriptions SET current_period_end=? WHERE user_id=?').run('2026-10-23T10:01:00Z',f.account.user.id);
  f.setClock(Date.parse('2026-10-23T11:00:00Z'));
  assert.equal((await f.call('/me/offers',{company:'第五家',position:'设计师'})).status,403);
  assert.equal((await f.call(`/me/offers/${rows[0].id}`,{...rows[0],note:'仍可整理'},'PUT')).status,200);
  assert.equal((await f.call('/me/workspace')).offers.length,4);
});
