'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const moduleUrl = pathToFileURL(path.join(__dirname, '../web/src/lib/job-detail.js')).href;
const helpers = () => import(moduleUrl);

test('detail navigation only permits known local collection routes', async () => {
  const { safeReturnPath } = await helpers();
  for (const value of ['/jobs?availability=all&location=%E4%B8%8A%E6%B5%B7','/workspace?tab=custom','/pipeline','/']) assert.equal(safeReturnPath(value),value);
  for (const value of [null,'//example.com/jobs','https://example.com/jobs','/\\example.com/jobs','/jobs\n','/jobs/other','/admin','javascript:alert(1)','/%2f%2fevil']) assert.equal(safeReturnPath(value),'/jobs');
});

test('public source links reject executable schemes and credentials; facts accept text or arrays', async () => {
  const { safePublicLink, detailLines } = await helpers();
  assert.equal(safePublicLink(' https://example.com/notice?id=123 '),'https://example.com/notice?id=123');
  for (const value of ['javascript:alert(1)','file:///private','https://name:password@example.com','相见公告','//example.com']) assert.equal(safePublicLink(value),'');
  assert.deepEqual(detailLines('五险一金；餐补\n年假;餐补'),['五险一金','餐补','年假']);
  assert.deepEqual(detailLines([' 五险一金 ','餐补','餐补',null]),['五险一金','餐补']);
});

test('reminder conversions retain the same instant in different device timezones and reject impossible times', () => {
  for (const [zone,local] of [['Asia/Shanghai','2026-10-24T20:30'],['America/New_York','2026-10-24T08:30']]) {
    const script=`import {toLocalDateTime,toReminderIso} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify([toLocalDateTime('2026-10-24T12:30:00.000Z'),toReminderIso(${JSON.stringify(local)}),toReminderIso('')]));`;
    const run=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,TZ:zone}});
    assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),[local,'2026-10-24T12:30:00.000Z','']);
  }
});

test('invalid reminder dates and unsafe formatted timestamps do not render or silently normalize',async()=>{
  const { toReminderIso,toLocalDateTime,factualDate }=await helpers();
  for(const value of ['2026-02-31T12:30','2026-10-24T25:00','2026-10-24','not-a-date'])assert.throws(()=>toReminderIso(value));
  assert.equal(toLocalDateTime('not-a-date'),'');assert.equal(factualDate('not-a-date'),'未记录');
});
