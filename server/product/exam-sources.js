'use strict';

// Outbound official references only. Public availability is not a redistribution
// licence; no external question text or PDF is mirrored in this registry.
const EXAM_SOURCES = Object.freeze([
  {
    id: 'gwy-2027-syllabus', examType: 'xingce', year: 2027,
    title: '2027 年度国考公共科目笔试考试大纲与官方例题',
    publisher: '国家公务员局',
    url: 'http://bm.scs.gov.cn/pp/gkweb/core/web/ui/business/article/articledetail.html?ArticleId=8a81f6d8a129c66701a133a8b15b00df&id=0000000062b7b2b60162bccd55ec0006&eid=0000000062b7b2b60162bccdd5860007',
    kind: 'syllabus_with_samples', availability: 'external_reference',
    description: '2026 年 10 月发布的 2027 招录年度大纲。含六模块官方例题；大纲例题不等于已经考过的历年真题。',
    rightsStatus: 'permission_not_confirmed',
    rightsNote: '仅提供官方来源入口；未确认商业转载授权，不将例题全文收入会员题库。',
    checkedAt: '2026-10-23',
  },
  {
    id: 'gwy-2026-syllabus', examType: 'xingce', year: 2026,
    title: '2026 年度国考公共科目笔试考试大纲与官方例题',
    publisher: '国家公务员局（国家林业和草原局官方转载）',
    url: 'https://www.forestry.gov.cn/c/www/gsgg/645383.jhtml',
    kind: 'syllabus_with_samples', availability: 'external_reference',
    description: '用于核对考试范围和官方示例；不是历年完整真题卷，也不计入站内可答题量。',
    rightsStatus: 'permission_not_confirmed',
    rightsNote: '仅提供官方来源入口；未确认商业转载授权，不将例题全文收入会员题库。',
    checkedAt: '2026-10-23',
  },
  {
    id: 'vocational-2026-syllabus', examType: 'vocational', year: 2026,
    title: '2026 年版事业单位公开招聘分类考试公共科目笔试考试大纲',
    publisher: '人力资源和社会保障部人事考试中心（湖南人事考试网发布）',
    url: 'https://rst.hunan.gov.cn/rst/hnrsksw/c103117/c103119/202606/t20260608_33995613.html',
    kind: 'syllabus_with_samples', availability: 'external_reference',
    description: '职业能力倾向测验与公务员行测不是同一科目，应按报考类别查看对应大纲。',
    rightsStatus: 'permission_required',
    rightsNote: '大纲声明未经许可不得转载、修改或营利使用；本平台只提供原站入口，不复制全文或题目。',
    checkedAt: '2026-10-23',
  },
]);

module.exports = { EXAM_SOURCES };
