'use strict';
// Explicit, auditable one-off import. Never invoked by startup or a scheduler.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ProductPlatform } = require('../product');
const { initializeAnnouncements } = require('../product/announcement-enrichment');
const args = process.argv.slice(2);
const argument = key => args[args.indexOf(key) + 1];
const data = require('../product/reviewed-announcements-20261023.json');
if (!args.includes('--catalog')) throw new Error('--catalog is required');
const catalog = JSON.parse(fs.readFileSync(argument('--catalog'), 'utf8'));
const expected = new Map((catalog.jobs || []).map(job => [String(job.id),job]));
const compatible = entry => expected.has(entry.jobId) && Object.entries(entry.expected || {}).every(([key,value]) => String(expected.get(entry.jobId)[key] || '') === value);
const planned = data.entries.filter(compatible);
const skipped = data.entries.filter(entry => !compatible(entry)).map(entry => ({ jobId:entry.jobId, reason:expected.has(entry.jobId) ? 'catalog_identity_changed_review_again' : 'not_in_this_catalog' }));
for (const entry of planned) {
  if (expected.get(entry.jobId).company !== entry.company) throw new Error(`Company changed; review again: ${entry.jobId}`);
  if (!entry.evidence.every(evidence => evidence.quote && evidence.sourceUrl === entry.evidenceUrl)) throw new Error('Invalid evidence');
}
const plan = { reviewedAt:data.reviewedAt, jobs:planned.length, fields:planned.reduce((sum,entry)=>sum+Object.keys(entry.facts).length,0), skipped, scope:'announcement overlays only; no source catalog writes' };
if (!args.includes('--apply')) console.log(JSON.stringify({dryRun:true,...plan}));
else {
  if (!args.includes('--data-dir') || !args.includes('--actor-id')) throw new Error('--data-dir and --actor-id are required for apply');
  const platform = new ProductPlatform({dataDir:path.resolve(argument('--data-dir')),jobService:{snapshot:()=>catalog}}).initialize();
  try {
    const actor = platform.store.getUser(argument('--actor-id')); platform.requireRole(actor,['admin']);
    const service = initializeAnnouncements(platform);
    const core = () => Object.fromEntries(['users','profiles','job_states','subscriptions','exam_sessions'].map(table => [table,crypto.createHash('sha256').update(JSON.stringify(platform.store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).digest('hex')]));
    const before = core();
    const applied = platform.store.transaction(() => {
      const results = planned.map(entry => {
        const {run,items} = service.submitManualEvidence(actor,entry);
        const result = service.approve(actor,items[0].id,{fields:Object.keys(entry.facts),reason:entry.reason,confirmIdentity:true});
        return {jobId:entry.jobId,runId:run.id,itemId:result.item.id,fields:Object.keys(entry.facts),availability:result.job.availability.status};
      });
      if (JSON.stringify(core()) !== JSON.stringify(before)) throw new Error('Personal data changed; rolling back import');
      return results;
    });
    console.log(JSON.stringify({applied:true,...plan,personalDataUnchanged:true,results:applied}));
  } finally { platform.close(); }
}
