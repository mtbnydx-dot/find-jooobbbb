#!/usr/bin/env node
'use strict';
// Run under the collection service owner. The destination contains public facts only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { enrichSourceFacts, qualitySummary } = require('../product/job-quality');
const FIELDS = ['id','active','company','position','nature','industry','location','deadline','exam','url','notice','sourceNote','origins','firstSeenAt','lastSeenAt','major','majors','degree','audience','batch','educationLevel','experience','description','requirements','skills','skillTags','workMode','employmentType','benefits','salary','salaryText','salaryMin','salaryMax','salaryCurrency','salaryPeriod','salaryMonths','pay'];

function publicCatalog(dataDir) {
  const input = JSON.parse(fs.readFileSync(path.join(dataDir,'jobs.json'),'utf8'));
  const db = new DatabaseSync(path.join(dataDir,'cloud.db'), { readOnly: true });
  let raw; let aliases={};
  try { raw = new Map(db.prepare('SELECT source_id,external_id,payload_json FROM source_records WHERE active=1').all().map(row => [`${row.source_id}:${row.external_id}`, JSON.parse(row.payload_json)]));
    aliases=JSON.parse(db.prepare("SELECT value FROM kv WHERE key='public:aliases'").get()?.value || '{}'); }
  finally { db.close(); }
  const jobs = input.jobs.filter(job => job.active !== '0' && job.source !== '自选').map(job => {
    const result = Object.fromEntries(FIELDS.filter(key => job[key] !== undefined).map(key => [key,job[key]]));
    let ids=[]; try { ids=JSON.parse(job.sourceRecordIds || '[]'); } catch (_) { /* retain facts already on job */ }
    const sources=ids.map(id=>raw.get(id)).filter(Boolean);
    for (const [key, aliases] of Object.entries({ degree:['学历'], audience:['招聘对象','应届生'], batch:['批次','类别'] })) {
      if (!result[key]) result[key]=[...new Set(sources.flatMap(row=>aliases.map(alias=>String(row[alias] || '').trim())).filter(Boolean))].join('；');
    }
    return enrichSourceFacts(result, sources);
  });
  const version=crypto.createHash('sha256').update(JSON.stringify({jobs,aliases})).digest('hex');
  return { jobs, aliases, meta: { lastSyncAt: input.meta?.lastSyncAt || '', catalogVersion: version }, dataQuality: qualitySummary(jobs), version, publishedAt: new Date().toISOString() };
}

function publish(dataDir, destination) {
  const catalog = publicCatalog(dataDir);
  if (!catalog.jobs.length) throw new Error('Public catalog empty; existing publication retained');
  if (fs.existsSync(destination)) {
    const previous=JSON.parse(fs.readFileSync(destination,'utf8'));
    if (previous.version===catalog.version) return { changed:false, count:catalog.jobs.length, version:catalog.version };
    if (previous.jobs.length>=20 && catalog.jobs.length<previous.jobs.length*.5) throw new Error('Public catalog dropped more than 50%; publication retained');
  }
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  const temporary=`${destination}.${process.pid}.tmp`;
  const fd=fs.openSync(temporary,'wx',0o644);
  try { fs.writeFileSync(fd,JSON.stringify(catalog)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary,destination);
  return { changed:true, count:catalog.jobs.length, version:catalog.version };
}
if (require.main===module) console.log(JSON.stringify(publish(process.argv[2] || process.env.DATA_DIR,process.argv[3] || process.env.PUBLIC_CATALOG_FILE)));
module.exports={ publicCatalog, publish, FIELDS };
