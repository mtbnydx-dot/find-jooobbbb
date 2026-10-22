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
  const platform=new ProductPlatform({dataDir,clock:()=>clock,jobService:{snapshot:()=>({jobs:[{id:'public',active:'1',company:'公开企业',position:'设计师',location:'上海'}]})}}).initialize();
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
  for(let i=0;i<3;i++){const saved=await f.call('/me/saved-searches',{name:`搜索${i}`,filters:{location:'上海'}});assert.equal(saved.status,201);first ||= saved.item;}
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
