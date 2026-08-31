'use strict';

const crypto = require('node:crypto');

const DEFAULT_FIELD_MAP = Object.freeze({
  company: ['公司名称', '公司'],
  nature: ['企业性质', '性质'],
  industry: ['行业大类', '行业'],
  batch: ['批次', '招聘批次', '类别'],
  audience: ['招聘对象', '应届生'],
  location: ['工作地点', '地点'],
  position: ['招聘岗位', '岗位'],
  updatedAt: ['更新时间', '录入时间'],
  deadline: ['截止时间', '申请截止'],
  exam: ['是否需要笔试', '笔试'],
  url: ['投递方式', '网申链接/邮箱', '网申链接'],
  notice: ['官方公告', '公告链接'],
  sourceNote: ['备注/提示', '备注'],
  major: ['专业', '专业要求', '专业方向'],
  majors: ['适用专业', '专业列表'],
  degree: ['学历要求', '学历'],
  educationLevel: ['教育程度', '教育背景'],
  experience: ['经验要求', '工作经验'],
  description: ['岗位描述', '职位描述', '工作内容', '岗位职责'],
  requirements: ['任职要求', '职位要求', '岗位要求'],
  skills: ['技能要求', '技能', '关键技能'],
  skillTags: ['技能标签', '能力标签'],
  workMode: ['工作方式', '办公方式', '远程/现场'],
  employmentType: ['用工类型', '工作类型', '全职/实习'],
  benefits: ['福利待遇', '福利'],
  salary: ['薪资待遇', '薪资', '薪酬', '工资'],
  salaryText: ['薪资范围', '薪酬范围'],
  salaryMin: ['最低薪资', '薪资下限'],
  salaryMax: ['最高薪资', '薪资上限'],
  salaryCurrency: ['薪资币种', '币种'],
  salaryPeriod: ['薪资周期', '计薪周期'],
  salaryMonths: ['发薪月数', '薪数'],
  pay: ['报酬', '待遇'],
});

const TARGET_CITIES = Object.freeze(['合肥', '上海', '南京', '杭州', '苏州', '无锡', '宁波', '常州', '温州', '绍兴', '嘉兴', '芜湖', '马鞍山']);
const NON_TECH = Object.freeze([
  '运营', '新媒体', '编辑', '文案', '策划', '推广', '媒介', '传播', '品牌', '市场', '营销', '公关', '广告', '创意',
  '传媒', '影视', '短视频', '视频制作', '视频编辑', '视频剪辑', '视觉设计', '平面设计', '动画', '导演', '编导', '制片',
  '记者', '主播', '主持', '社群', '用户增长', '电商', '直播', '消费者洞察', '用户研究', '舆情', '数字媒体', '社交媒体',
  '社会化媒体', '内容营销', '整合营销', '媒介管理', '活动', '产品经理', '产品运营', '产品专员', '产品行销', '项目经理',
  '客户经理', '销售', '商务', 'MKT', 'mkt', 'Marketing', '管培', '储备干部', '管理培训生', '综合管理', '人力资源',
  'HRBP', '行政', '职能', '采购', '审计', '税务', '咨询', '商业分析', '顾问', '财富管理', '投研', '交易员', '风控',
  '合规', '柜员', '财务', '会计', '法务', '贸易', '外贸', '理赔', '核保', '精算', '信贷', '数据分析', '分析师',
  'Consultant', 'consultant', 'Associate', '分析员', 'Analyst', '教师', '培训师', '培训讲师', '翻译', '店员', '门店', '导购',
  '经纪人', '校园大使', '文员', '客户服务', '客户成功',
]);
const NON_TECH_CATEGORIES = Object.freeze([
  '市场类', '营销类', '销售类', '运营类', '职能类', '商务类', '供应链类', '品质类', '市场营销类', '销售与市场',
  '销售市场类', '职能管理类', '商务与市场', '企业职能', '产品类', '咨询类', '财经类', '财务类', '金融类', '服务类',
  '综合类', '经管类', '文科类', '不限专业', '专业不限', '品牌营销', '市场类岗位', '销售类岗位',
]);
const PURE_TECH = Object.freeze([
  'IC设计', '芯片设计', '数字设计', '模拟IC', '模拟设计', '数字IC', '射频', '嵌入式', '固件', '硬件工程师',
  '算法工程师', '软件工程师', '开发工程师', '测试工程师', '光学工程师', '电气工程师', '机械工程师', '结构工程师',
  'FPGA', 'EDA', '封装', '晶圆', '制程', '研发工程师', '系统工程师', '前端工程师', '后端工程师', '编译器',
  '量化研究', '量化策略', '数据科学家', 'IC验证', '版图', 'SoC', 'SERDES', '工艺整合', '工艺研发', '算法类', '软件类', '硬件类',
]);
const FALSE_POSITIVES = Object.freeze([
  /视觉(算法|工程师|研发|技术)/g,
  /视频(生成|编解码|算法)(算法|工程师)?/g,
  /助理(模拟|数字|芯片|IC|设计|验证|FAE|硬件|软件|电子|机械)/gi,
  /(模拟|数字|芯片|IC|硬件|软件|电子|机械|电气|结构|光学)助理工程师/gi,
  /芯片设计岗/g, /(仿真|结构设计|工业设计)岗/g, /生产营运类/g, /项目管理类/g, /体验营/g, /开放日/g,
]);
const HARD_TECH = /半导体|电子|集成电路|微电子|芯片|晶圆|机器人|智能硬件|通信|光学|光电|仪器|测量|航天|航空|军工|国防|电力|能源|机械|材料|自动化|汽车|新能源|电池/i;
const TECH_SALES = Object.freeze([/销售工程师/g, /售前/g, /技术服务/g, /FAE/gi, /现场应用/g, /项目经理/g, /PM(?![a-z])/gi, /解决方案/g, /技术支持/g, /售后工程师/g, /应用工程师/g]);
const HARD_TECH_SAFE = Object.freeze([
  '市场', '营销', '品牌', '运营', '新媒体', '内容', '编辑', '文案', '策划', '推广', '媒介', '传播', '公关', '广告',
  '创意', '传媒', '影视', '短视频', '电商', '直播', '消费者洞察', '用户研究', '舆情', '管培', '储备干部', '管理培训生',
  '人力资源', 'HRBP', '行政', '财务', '会计', '法务', '合规', '采购', '审计', '税务', '贸易', '外贸', '文员',
  '校园大使', '翻译', ...NON_TECH_CATEGORIES,
]);

const DIRECTION_KEYWORDS = Object.freeze({
  '消费者洞察/用户研究（高对口）': ['消费者洞察', '用户研究', '舆情'],
  '公关/品牌/营销传播（高对口）': ['公关', '品牌', '营销', '传播', '媒介', '广告', '创意', '整合营销', '内容营销', '媒介管理'],
  '新媒体/内容/运营（高对口）': ['运营', '新媒体', '内容', '编辑', '文案', '策划', '推广', '社群', '用户增长', '电商', '直播', '数字媒体', '社交媒体', '社会化媒体', '活动'],
  '传媒/影视/设计（高对口）': ['传媒', '影视', '短视频', '视频制作', '视频编辑', '视频剪辑', '视觉设计', '平面设计', '动画', '导演', '编导', '制片', '记者', '主播', '主持'],
  '产品/项目': ['产品经理', '产品运营', '产品专员', '产品行销', '项目经理'],
  '销售/商务/客户': ['客户经理', '销售', '商务', 'MKT', 'Marketing', '客户服务', '客户成功'],
  '咨询/金融/文职': ['审计', '税务', '咨询', '商业分析', '顾问', '财富管理', '投研', '交易员', '风控', '合规', '柜员', '财务', '会计', '法务', '贸易', '外贸', '数据分析', '分析师', 'Consultant', 'Associate', 'Analyst'],
  '职能/管培/综合': ['管培', '储备干部', '管理培训生', '综合管理', '人力资源', 'HRBP', '行政', '职能', '采购'],
});
const BIG_COMPANIES = Object.freeze(['哔哩哔哩', '联想', '德勤', '珀莱雅', '招商银行', 'Babycare', '京东方', '恩智浦', '乐鑫', '歌尔', '华为', '安克创新', '海信', '中国电信', '拼多多', '欧莱雅', '麦肯锡', 'BCG', '普华永道', '毕马威', '高盛', '科大讯飞', '阿里']);

function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('|');
  if (typeof value === 'object') {
    if (value.link) return text(value.link);
    if (value.text) return text(value.text);
    if (value.name) return text(value.name);
    if (value.value !== undefined) return text(value.value);
  }
  return String(value).trim();
}

function read(record, fieldMap, key) {
  const mapped = fieldMap[key] || DEFAULT_FIELD_MAP[key] || key;
  if (Array.isArray(mapped)) {
    for (const candidate of mapped) {
      const value = text(record[candidate]);
      if (value) return value;
    }
    return '';
  }
  return text(record[mapped]);
}

function compact(value) {
  return text(value).toLowerCase().replace(/[\s\u3000·•|｜,，、/\\()（）\[\]【】_-]+/g, '');
}

function canonicalLocation(value) {
  const parts = text(value)
    .toLowerCase()
    .split(/[|｜,，、/\\;；]+/)
    .map(part => compact(part).replace(/市$/u, ''))
    .filter(Boolean);
  if (!parts.length) return '';
  return [...new Set(parts)].sort((a, b) => a.localeCompare(b, 'zh-CN')).join('|');
}

function canonicalKeyForJob(job) {
  const company = compact(job.company);
  const position = compact(job.position);
  const location = canonicalLocation(job.location);
  const basis = `${company}|${position}|${location}`;
  return crypto.createHash('sha1').update(basis, 'utf8').digest('hex').slice(0, 24);
}

function stripFalsePositives(job, includeTechSales = false) {
  let cleaned = job;
  for (const pattern of FALSE_POSITIVES) cleaned = cleaned.replace(pattern, '');
  if (includeTechSales) for (const pattern of TECH_SALES) cleaned = cleaned.replace(pattern, '');
  return cleaned;
}

function hasRealNonTech(job) {
  const cleaned = stripFalsePositives(job);
  return NON_TECH.some(keyword => cleaned.includes(keyword)) || NON_TECH_CATEGORIES.some(keyword => cleaned.includes(keyword));
}

function hasPureTech(job) {
  return PURE_TECH.some(keyword => job.includes(keyword));
}

function isTargetPool(row) {
  const audienceYears = row.audience.match(/\d{2,4}/g) || [];
  const includes2027 = audienceYears.some(year => year === '27' || year === '2027');
  return row.batch.startsWith('秋招') && includes2027 && TARGET_CITIES.some(city => row.location.includes(city));
}

function classifyRow(row) {
  if (!isTargetPool(row)) return '全部岗位';
  const job = row.position;
  const hardTech = HARD_TECH.test(`${row.industry}${row.company}`);
  if (hardTech) {
    const cleaned = stripFalsePositives(job, true);
    if (!HARD_TECH_SAFE.some(keyword => cleaned.includes(keyword))) return '全部岗位';
    return hasPureTech(job) ? '可试试' : '符合条件';
  }
  if (!hasRealNonTech(job)) return '全部岗位';
  return hasPureTech(job) ? '可试试' : '符合条件';
}

function directions(position) {
  const result = [];
  for (const [name, keywords] of Object.entries(DIRECTION_KEYWORDS)) {
    if (keywords.some(keyword => position.includes(keyword))) result.push(name);
  }
  return result.join('、');
}

function priority(row, classification) {
  if (classification === '可试试') return '⭐ 低';
  if (classification !== '符合条件') return '';
  let score = 0;
  if (row.location.includes('合肥')) score += 3;
  if (['上海', '杭州', '南京', '苏州'].some(city => row.location.includes(city))) score += 2;
  if (['消费者洞察', '用户研究', '舆情', '公关', '品牌', '营销', '传播', '媒介', '广告', '新媒体', '内容', '短视频', '社交媒体', '数字媒体'].some(keyword => row.position.includes(keyword))) score += 4;
  else if (['运营', '编辑', '文案', '策划', '推广', '电商', '直播'].some(keyword => row.position.includes(keyword))) score += 3;
  if (['产品经理', '产品运营'].some(keyword => row.position.includes(keyword))) score += 2;
  if (['传媒', '影视', '视觉设计', '平面设计'].some(keyword => row.position.includes(keyword))) score += 2;
  if (BIG_COMPANIES.some(company => row.company.includes(company))) score += 1;
  if (['外企', '央国企', '银行'].includes(row.nature)) score += 1;
  if (score >= 7) return '⭐⭐⭐ 高';
  if (score >= 4) return '⭐⭐ 中';
  return '⭐ 低';
}

function rowFromRecord(record, fieldMap) {
  return {
    externalId: text(record._id || record.id),
    company: read(record, fieldMap, 'company'),
    nature: read(record, fieldMap, 'nature'),
    industry: read(record, fieldMap, 'industry'),
    batch: read(record, fieldMap, 'batch'),
    audience: read(record, fieldMap, 'audience'),
    location: read(record, fieldMap, 'location'),
    position: read(record, fieldMap, 'position'),
    updatedAt: read(record, fieldMap, 'updatedAt'),
    deadline: read(record, fieldMap, 'deadline'),
    exam: read(record, fieldMap, 'exam'),
    url: read(record, fieldMap, 'url'),
    notice: read(record, fieldMap, 'notice'),
    sourceNote: read(record, fieldMap, 'sourceNote'),
    major: read(record, fieldMap, 'major'),
    majors: read(record, fieldMap, 'majors'),
    degree: read(record, fieldMap, 'degree'),
    educationLevel: read(record, fieldMap, 'educationLevel'),
    experience: read(record, fieldMap, 'experience'),
    description: read(record, fieldMap, 'description'),
    requirements: read(record, fieldMap, 'requirements'),
    skills: read(record, fieldMap, 'skills'),
    skillTags: read(record, fieldMap, 'skillTags'),
    workMode: read(record, fieldMap, 'workMode'),
    employmentType: read(record, fieldMap, 'employmentType'),
    benefits: read(record, fieldMap, 'benefits'),
    salary: read(record, fieldMap, 'salary'),
    salaryText: read(record, fieldMap, 'salaryText'),
    salaryMin: read(record, fieldMap, 'salaryMin'),
    salaryMax: read(record, fieldMap, 'salaryMax'),
    salaryCurrency: read(record, fieldMap, 'salaryCurrency'),
    salaryPeriod: read(record, fieldMap, 'salaryPeriod'),
    salaryMonths: read(record, fieldMap, 'salaryMonths'),
    pay: read(record, fieldMap, 'pay'),
  };
}

function richness(job) {
  return [
    'company', 'position', 'location', 'deadline', 'url', 'notice', 'industry', 'sourceNote',
    'major', 'majors', 'degree', 'educationLevel', 'experience', 'description', 'requirements',
    'skills', 'skillTags', 'workMode', 'employmentType', 'benefits',
    'salary', 'salaryText', 'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'salaryMonths', 'pay',
  ].reduce((score, key) => score + (job[key] ? Math.min(key === 'description' || key === 'requirements' ? 200 : 40, job[key].length) : 0), 0);
}

function preferenceKey(job) {
  return [
    'deadline', 'url', 'notice', 'exam', 'nature', 'industry', 'sourceNote', 'major', 'degree',
    'description', 'requirements', 'skills', 'workMode', 'employmentType', 'salary', 'benefits',
  ]
    .map(key => text(job[key]))
    .join('\u001f');
}

function classificationRank(value) {
  return value === '符合条件' ? 3 : value === '可试试' ? 2 : 1;
}

function classifyRecords(records, source, runAt = new Date().toISOString()) {
  if (!Array.isArray(records)) throw new Error('采集结果不是数组');
  const fieldMap = { ...DEFAULT_FIELD_MAP, ...(source?.fieldMap || {}) };
  const deduped = new Map();
  const stats = { raw: records.length, invalid: 0, all: 0, fit: 0, tryable: 0, duplicates: 0 };
  for (let index = 0; index < records.length; index++) {
    const raw = records[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { stats.invalid++; continue; }
    const row = rowFromRecord(raw, fieldMap);
    if (!row.company || !row.position) { stats.invalid++; continue; }
    const classification = classifyRow(row);
    if (classification === '符合条件') stats.fit++;
    else if (classification === '可试试') stats.tryable++;
    else stats.all++;
    const key = canonicalKeyForJob(row);
    const recordId = row.externalId || `row_${index + 1}`;
    const candidate = {
      id: `cloud-${key}`,
      canonicalKey: key,
      source: classification,
      classification,
      origins: JSON.stringify([source.name]),
      originIds: JSON.stringify([source.id]),
      sourceRecordIds: JSON.stringify([`${source.id}:${recordId}`]),
      active: '1',
      firstSeenAt: runAt,
      lastSeenAt: runAt,
      missingAt: '',
      isCustom: '',
      priority: priority(row, classification),
      matchDir: directions(row.position),
      company: row.company,
      nature: row.nature,
      industry: row.industry,
      position: row.position,
      location: row.location,
      deadline: row.deadline,
      exam: row.exam,
      url: row.url,
      notice: row.notice,
      sourceNote: row.sourceNote,
      major: row.major,
      majors: row.majors,
      degree: row.degree,
      educationLevel: row.educationLevel,
      experience: row.experience,
      description: row.description,
      requirements: row.requirements,
      skills: row.skills,
      skillTags: row.skillTags,
      workMode: row.workMode,
      employmentType: row.employmentType,
      benefits: row.benefits,
      salary: row.salary,
      salaryText: row.salaryText,
      salaryMin: row.salaryMin,
      salaryMax: row.salaryMax,
      salaryCurrency: row.salaryCurrency,
      salaryPeriod: row.salaryPeriod,
      salaryMonths: row.salaryMonths,
      pay: row.pay,
      ddlRemind: row.deadline || '常年/尽快',
      status: '未投递',
      appliedAt: '',
      statusUpdatedAt: '',
      note: '',
    };
    const old = deduped.get(key);
    if (!old) {
      deduped.set(key, candidate);
      continue;
    }
    stats.duplicates++;
    const ids = new Set([...JSON.parse(old.sourceRecordIds), ...JSON.parse(candidate.sourceRecordIds)]);
    const candidateRank = classificationRank(candidate.classification);
    const oldRank = classificationRank(old.classification);
    const candidateRichness = richness(candidate);
    const oldRichness = richness(old);
    const preferCandidate = candidateRank > oldRank ||
      (candidateRank === oldRank && candidateRichness > oldRichness) ||
      (candidateRank === oldRank && candidateRichness === oldRichness && preferenceKey(candidate).localeCompare(preferenceKey(old), 'zh-CN') > 0);
    const chosen = preferCandidate ? candidate : old;
    chosen.sourceRecordIds = JSON.stringify([...ids].sort());
    deduped.set(key, chosen);
  }
  return { jobs: [...deduped.values()], stats: { ...stats, canonical: deduped.size } };
}

module.exports = {
  DEFAULT_FIELD_MAP,
  TARGET_CITIES,
  canonicalKeyForJob,
  classifyRecords,
  classifyRow,
};
