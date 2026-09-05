'use strict';
const { deadlineFact } = require('./job-facts');
const { zonedParts } = require('./runtime');
const classification = job => job.classification || job.source;
const custom = job => job.isCustom === '1' || job.source === '自选';
const fresh = job => job.aiAssessment?.fresh === true;
const score = job => fresh(job) ? Number(job.aiAssessment.score) : -1;

function legacyQuery(jobs, query, now = Date.now()) {
  const active = jobs.filter(job => query.includeInactive === '1' || job.active !== '0');
  const today = Date.parse(`${zonedParts(now, 'Asia/Shanghai').date}T00:00:00Z`);
  const days = new Map(active.map(job => { const date = deadlineFact(job.deadline).date; return [job.id, date ? Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86400000) : null]; }));
  const urgent = job => days.get(job.id) !== null && days.get(job.id) >= 0 && days.get(job.id) <= 7 && job.status === '未投递';
  const ongoing = job => ['笔试', '一面', '二面'].includes(job.status);
  const filters = {
    all: () => true, urgent, self: custom, fit: job => classification(job) === '符合条件',
    try: job => classification(job) === '可试试', pool: job => classification(job) === '全部岗位',
    '__ongoing__': ongoing, 'ai-recommended': job => score(job) >= 70,
  };
  ['未投递','已投递','笔试','一面','二面','offer','挂'].forEach((status, i) => { filters[`s${i}`] = job => job.status === status; });
  const count = predicate => active.filter(predicate).length;
  const stats = { total: active.length, applied: count(job => ['已投递','笔试','一面','二面','offer'].includes(job.status)), ongoing: count(ongoing), offer: count(job => job.status === 'offer'), urgent: count(urgent), custom: count(custom), fit: count(filters.fit), recommended: count(filters['ai-recommended']) };
  let list = active.filter(filters[query.view] || filters.all);
  if (query.status) list = list.filter(job => job.status === query.status);
  if (query.custom === '1' || query.priority === '自选' || query.classification === '自选') list = list.filter(custom);
  if (query.priority && query.priority !== '自选') list = list.filter(job => String(job.priority || '').includes(query.priority));
  if (query.classification && query.classification !== '自选') list = list.filter(job => classification(job) === query.classification);
  const aiFilters = { strong: job => score(job) >= 85, recommended: job => score(job) >= 70, scored: fresh, unscored: job => !job.aiAssessment, stale: job => job.aiAssessment && !fresh(job) };
  if (aiFilters[query.ai]) list = list.filter(aiFilters[query.ai]);
  const search = String(query.q || '').trim().toLowerCase();
  if (search) list = list.filter(job => [job.company,job.position,job.location,job.industry,job.sourceNote,job.note,fresh(job) ? job.aiAssessment.reason : '',fresh(job) ? job.aiAssessment.matchedRoles?.join('') : ''].join('').toLowerCase().includes(search));
  if (query.view || query.sort) {
    const fit = query.view === 'fit' || query.classification === '符合条件';
    const ai = fit || query.view === 'ai-recommended' || query.ai || query.sort === 'ai';
    const rank = job => String(job.priority).includes('高') ? 0 : String(job.priority).includes('中') ? 1 : 2;
    list.sort((a,b) => (ai ? score(b)-score(a) : 0) || (fit ? rank(a)-rank(b) : 0) || (days.get(a.id) ?? Infinity)-(days.get(b.id) ?? Infinity) || String(a.company).localeCompare(String(b.company),'zh-CN') || String(a.id).localeCompare(String(b.id)));
  }
  const total = list.length;
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const limit = query.limit === undefined ? total : Math.max(1,Math.min(2000,Math.floor(Number(query.limit) || 60)));
  return { jobs: list.slice(offset,offset+limit), total, offset, limit, stats };
}
module.exports = { legacyQuery };
