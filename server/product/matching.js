'use strict';

const MAJOR_HINTS = Object.freeze({
  '计算机科学': ['软件', '开发', '前端', '后端', '算法', '数据', '测试', '安全', '云'],
  '软件工程': ['软件', '开发', '前端', '后端', '测试', '工程师'],
  '电子信息': ['电子', '通信', '嵌入式', '硬件', '软件', '芯片'],
  '统计学': ['数据', '统计', '分析', '风控', '研究'],
  '数学': ['数据', '算法', '量化', '分析', '研究'],
  '经济学': ['经济', '商业分析', '咨询', '金融', '研究'],
  '会计学': ['会计', '财务', '审计', '税务'],
  '金融学': ['金融', '投行', '投资', '风控', '财富'],
  '市场营销': ['市场', '营销', '品牌', '增长', '销售'],
  '新闻传播': ['传播', '内容', '品牌', '公关', '媒体'],
  '广告学': ['广告', '创意', '品牌', '营销', '媒介'],
  '机械工程': ['机械', '制造', '结构', '工艺', '设备'],
  '电气工程': ['电气', '电力', '自动化', '控制', '硬件'],
  '自动化': ['自动化', '控制', '机器人', '电气', '嵌入式'],
  '工业工程': ['工业工程', '生产', '质量', '供应链', '流程'],
  '物流管理': ['物流', '供应链', '采购', '仓储', '计划'],
  '法学': ['法务', '法律', '合规', '律师', '知识产权', '风控'],
  '临床医学': ['临床', '医学', '医生', '医疗', '诊疗'],
  '护理学': ['护理', '护士', '医疗', '健康管理'],
  '药学': ['药学', '药物', '制药', '医药', '临床研究', '注册'],
  '生物科学': ['生物', '生命科学', '实验', '研发', '医药'],
  '化学': ['化学', '化工', '材料', '实验', '研发', '检测'],
  '物理学': ['物理', '光学', '半导体', '研究', '仿真'],
  '土木工程': ['土木', '结构', '施工', '工程管理', '造价'],
  '建筑学': ['建筑', '规划', '设计院', 'BIM', '施工图'],
  '环境工程': ['环境', '环保', '水处理', '可持续', '碳管理'],
  '材料科学': ['材料', '高分子', '金属', '半导体', '研发', '工艺'],
  '教育学': ['教育', '教学', '课程', '培训', '教研'],
  '汉语言文学': ['中文', '编辑', '文案', '内容', '出版', '行政'],
  '英语': ['英语', '翻译', '外贸', '国际业务', '内容', '教学'],
  '设计学': ['设计', '视觉', '交互', '用户体验', '品牌', '创意'],
  '视觉传达': ['视觉', '平面', '品牌', '包装', '设计'],
  '心理学': ['心理', '用户研究', '人力资源', '咨询', '测评'],
  '社会学': ['社会研究', '用户研究', '政策', '咨询', '公益'],
  '公共管理': ['公共管理', '政府事务', '政策', '行政', '项目管理'],
  '人力资源管理': ['人力资源', '招聘', '组织发展', '薪酬', '员工关系'],
  '旅游管理': ['旅游', '酒店', '会展', '运营', '客户服务'],
  '农学': ['农业', '农艺', '育种', '食品', '生物', '乡村'],
});

const EDUCATION_LEVELS = Object.freeze([
  { rank: 5, pattern: /博士|ph\.?d\.?|doctorate/i, label: '博士' },
  { rank: 4, pattern: /硕士|研究生|master(?:'s)?/i, label: '硕士' },
  { rank: 3, pattern: /本科|学士|bachelor(?:'s)?|undergraduate/i, label: '本科' },
  { rank: 2, pattern: /大专|专科|associate(?:'s)?|college diploma/i, label: '专科' },
  { rank: 1, pattern: /高中|中专|职高|high school/i, label: '高中/中专' },
]);

const QUALIFICATION_LABELS = Object.freeze({ pass: '通过', fail: '不满足', unknown: '未知' });

function text(value) {
  return String(value || '').trim().toLowerCase();
}

function values(value) {
  if (Array.isArray(value)) return value.map(text).filter(Boolean);
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { return values(JSON.parse(value)); } catch (_) { /* plain text below */ }
  }
  return String(value || '').split(/[,，、|/]/).map(text).filter(Boolean);
}

function jobSearchText(job) {
  return [
    job.company, job.position, job.location, job.industry, job.nature, job.matchDir,
    job.major, job.majors, job.degree, job.notice, job.exam, job.sourceNote,
    job.description, job.requirements, job.skills, job.skillTags, job.workMode,
    job.employmentType, job.benefits,
  ].flatMap(values).join(' ');
}

function normalizeCurrency(value) {
  const candidate = String(value || '').trim().toUpperCase();
  if (['RMB', '¥', '￥'].includes(candidate)) return 'CNY';
  if (['A$', 'AU$', 'AUD'].includes(candidate)) return 'AUD';
  if (['US$', 'USD', '$'].includes(candidate)) return 'USD';
  if (['HK$', 'HKD'].includes(candidate)) return 'HKD';
  if (['S$', 'SGD'].includes(candidate)) return 'SGD';
  if (['£', 'GBP'].includes(candidate)) return 'GBP';
  if (['€', 'EUR'].includes(candidate)) return 'EUR';
  return /^[A-Z]{3}$/.test(candidate) ? candidate : 'CNY';
}

function normalizeSalaryPeriod(value) {
  const normalized = text(value);
  if (['year', 'annual', 'annually', '年', '年薪'].includes(normalized) || /(?:per\s+year|per\s+annum|每年|\/年)/i.test(normalized)) return 'year';
  if (['week', 'weekly', '周', '周薪'].includes(normalized) || /(?:per\s+week|每周|\/周)/i.test(normalized)) return 'week';
  if (['hour', 'hourly', '时', '小时', '时薪'].includes(normalized) || /(?:per\s+hour|每小时|\/h(?:our)?\b)/i.test(normalized)) return 'hour';
  return 'month';
}

function salaryMultiplier(unit) {
  const normalized = text(unit);
  if (normalized === 'k' || normalized === '千') return 1000;
  if (normalized === 'w' || normalized === '万') return 10_000;
  return 1;
}

function optionalSalaryNumber(value) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return Number.NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function salaryMonthsRange(value, { explicit = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1 && value <= 36 ? { min: value, max: value } : null;
  }
  const source = String(value).trim();
  const pattern = explicit
    ? /^(\d{1,2}(?:\.\d+)?)\s*(?:(?:-|~|—|–|\/|至)\s*(\d{1,2}(?:\.\d+)?))?\s*(?:薪|个月(?:工资|薪酬)?)?$/i
    : /(?:^|[^\d])(\d{1,2}(?:\.\d+)?)\s*(?:(?:-|~|—|–|\/|至)\s*(\d{1,2}(?:\.\d+)?))?\s*(?:薪|个月(?:工资|薪酬)?)/i;
  const match = pattern.exec(source);
  if (!match) return null;
  let min = Number(match[1]);
  let max = match[2] ? Number(match[2]) : min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max > 36) return null;
  if (min > max) [min, max] = [max, min];
  return { min, max };
}

function salaryMonthsFields(range) {
  if (!range) return {};
  return {
    salaryMonths: range.min === range.max ? range.min : null,
    salaryMonthsMin: range.min,
    salaryMonthsMax: range.max,
  };
}

function normalizeSalary(job) {
  const embedded = job.compensation && typeof job.compensation === 'object' ? job.compensation : {};
  const directMin = optionalSalaryNumber(job.salaryMin ?? job.salary_min ?? embedded.min);
  const directMax = optionalSalaryNumber(job.salaryMax ?? job.salary_max ?? embedded.max);
  const directPeriod = text(job.salaryPeriod ?? job.salary_period ?? embedded.period) || 'month';
  const directCurrency = job.salaryCurrency ?? job.salary_currency ?? embedded.currency;
  const directSalaryMonths = salaryMonthsRange(job.salaryMonths ?? job.salary_months ?? embedded.salaryMonths ?? embedded.months, { explicit: true });
  if (Number.isFinite(directMin) || Number.isFinite(directMax)) {
    return {
      min: Number.isFinite(directMin) ? directMin : directMax,
      max: Number.isFinite(directMax) ? directMax : directMin,
      currency: String(directCurrency || '').trim() ? normalizeCurrency(directCurrency) : 'UNKNOWN',
      period: normalizeSalaryPeriod(directPeriod),
      source: 'structured',
      ...salaryMonthsFields(directSalaryMonths),
    };
  }
  // Parse only fields that explicitly represent compensation. Dates, URLs and cohort years in
  // titles/notices commonly look like numeric ranges and must never become salary samples.
  const source = [job.salary, job.salaryText, typeof job.compensation === 'string' ? job.compensation : '', job.pay]
    .map(value => String(value || '').trim()).filter(Boolean).join(' ');
  if (!source) return null;
  const normalizedSource = source.replace(/(?<=\d),(?=\d{3}(?:\D|$))/g, '');
  const match = /(\d+(?:\.\d+)?)\s*([kKwW千万元]?)\s*(?:-|~|—|–|至)\s*(?:A\$|AU\$|AUD|US\$|USD|HK\$|HKD|S\$|SGD|GBP|EUR|CNY|RMB|[£€$¥￥])?\s*(\d+(?:\.\d+)?)\s*([kKwW千万元]?)/i.exec(normalizedSource);
  if (!match) return null;
  let leftUnit = match[2];
  let rightUnit = match[4];
  if (!leftUnit && rightUnit) leftUnit = rightUnit;
  if (!rightUnit && leftUnit) rightUnit = leftUnit;
  let min = Number(match[1]) * salaryMultiplier(leftUnit);
  let max = Number(match[3]) * salaryMultiplier(rightUnit);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min > max) [min, max] = [max, min];
  const statedCurrency = String(job.salaryCurrency ?? job.salary_currency ?? '').trim();
  const parsedSalaryMonths = directSalaryMonths || salaryMonthsRange(source);
  return {
    min,
    max,
    currency: statedCurrency ? normalizeCurrency(statedCurrency)
      : /A\$|AU\$|\bAUD\b|澳元/i.test(source) ? 'AUD'
      : /HK\$|\bHKD\b|港币/i.test(source) ? 'HKD'
        : /S\$|\bSGD\b|新币/i.test(source) ? 'SGD'
          : /£|\bGBP\b/i.test(source) ? 'GBP'
            : /€|\bEUR\b/i.test(source) ? 'EUR'
              : /US\$|\bUSD\b|美元|\$/i.test(source) ? 'USD'
                : /\bCNY\b|\bRMB\b|人民币|[¥￥]/i.test(source) ? 'CNY' : 'UNKNOWN',
    period: /年薪|\/年|每年|annual|year|annum|\bp\.?a\.?\b/i.test(source) ? 'year'
      : /时薪|每小时|hour|hourly|\/h\b/i.test(source) ? 'hour'
        : /每周|weekly|week|\/周/i.test(source) ? 'week' : 'month',
    source: 'text',
    raw: String(job.salary || job.pay || '').trim(),
    ...salaryMonthsFields(parsedSalaryMonths),
  };
}

function salaryForPeriod(salary, period) {
  if (!salary) return null;
  const target = normalizeSalaryPeriod(period);
  const sourcePeriod = normalizeSalaryPeriod(salary.period);
  if (sourcePeriod === target) return { ...salary, period: target };

  const explicitMonths = Number.isFinite(Number(salary.salaryMonthsMin)) && Number.isFinite(Number(salary.salaryMonthsMax));
  const monthsMin = explicitMonths ? Number(salary.salaryMonthsMin) : 12;
  const monthsMax = explicitMonths ? Number(salary.salaryMonthsMax) : 12;
  let annualMin;
  let annualMax;
  if (sourcePeriod === 'year') {
    annualMin = salary.min;
    annualMax = salary.max;
  } else if (sourcePeriod === 'week') {
    annualMin = salary.min * 52;
    annualMax = salary.max * 52;
  } else if (sourcePeriod === 'hour') {
    annualMin = salary.min * 2080;
    annualMax = salary.max * 2080;
  } else {
    annualMin = salary.min * monthsMin;
    annualMax = salary.max * monthsMax;
  }

  let min;
  let max;
  if (target === 'year') {
    min = annualMin;
    max = annualMax;
  } else if (target === 'week') {
    min = annualMin / 52;
    max = annualMax / 52;
  } else if (target === 'hour') {
    min = annualMin / 2080;
    max = annualMax / 2080;
  } else if (sourcePeriod === 'year' && explicitMonths) {
    // With an explicit 13/14-pay package, bound the monthly base conservatively:
    // the smallest annual figure divided by the largest month count, and vice versa.
    min = annualMin / monthsMax;
    max = annualMax / monthsMin;
  } else {
    min = annualMin / 12;
    max = annualMax / 12;
  }
  return { ...salary, min, max, period: target };
}

function displayValue(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean).join('；');
  return String(value ?? '').trim();
}

function requirementSnippet(job, directKeys, matcher) {
  for (const key of directKeys) {
    const value = displayValue(job[key]);
    if (value && matcher(value)) return value;
  }
  const requirements = displayValue(job.requirements);
  if (!requirements) return '';
  return requirements.split(/[\n；;。]/).map(item => item.trim()).find(item => item && matcher(item)) || '';
}

function educationLevel(value) {
  const source = displayValue(value);
  return EDUCATION_LEVELS.find(level => level.pattern.test(source)) || null;
}

function parseEducationRequirement(requirement) {
  const source = displayValue(requirement);
  if (!source) return null;
  if (/学历不限|不限学历|无学历要求|education\s+not\s+required/i.test(source)) return { unrestricted: true };
  const mentioned = EDUCATION_LEVELS.filter(level => level.pattern.test(source));
  if (!mentioned.length) return null;
  const explicitlyOptional = /优先|preferred|加分|更佳/i.test(source);
  const explicitlyRequired = /及以上|以上|或以上|至少|最低|必须|要求|required|minimum|\+/i.test(source);
  if (explicitlyOptional && !explicitlyRequired) return null;
  return { minRank: Math.min(...mentioned.map(level => level.rank)), label: mentioned.sort((a, b) => a.rank - b.rank)[0].label };
}

function cohortYear(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return null;
  if (number >= 0 && number <= 99) return 2000 + number;
  return number >= 1900 && number <= 2200 ? number : null;
}

function parseCohortRequirement(requirement) {
  const source = displayValue(requirement);
  if (!source) return null;
  if (/不限届|届次不限|应往届|往届(?:生)?可|毕业时间不限/i.test(source)) return { unrestricted: true };
  const after = /(?:20)?(\d{2})\s*(?:届|年毕业)?\s*(?:及以后|以后|起)/.exec(source);
  if (after) return { minYear: cohortYear(after[1]) };
  const before = /(?:20)?(\d{2})\s*(?:届|年毕业)?\s*(?:及以前|以前|之前)/.exec(source);
  if (before) return { maxYear: cohortYear(before[1]) };

  const years = new Set();
  const segments = source.match(/(?:(?:20)?\d{2})(?:\s*(?:-|~|—|–|\/|、|，|,|至)\s*(?:(?:20)?\d{2}))*\s*(?:届|年毕业)/g) || [];
  for (const segment of segments) {
    const found = [...segment.matchAll(/(?<!\d)(20\d{2}|\d{2})(?!\d)/g)].map(match => cohortYear(match[1])).filter(Boolean);
    if (found.length === 2 && /-|~|—|–|至/.test(segment) && Math.abs(found[1] - found[0]) <= 10) {
      const min = Math.min(...found);
      const max = Math.max(...found);
      for (let year = min; year <= max; year += 1) years.add(year);
    } else {
      found.forEach(year => years.add(year));
    }
  }
  const classOf = /class\s+of\s+(20\d{2})/i.exec(source);
  if (classOf) years.add(Number(classOf[1]));
  return years.size ? { years: [...years].sort() } : null;
}

function experienceYears(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const source = displayValue(value);
  if (/应届|无经验|fresh graduate/i.test(source)) return 0;
  const year = /(\d+(?:\.\d+)?)\s*(?:年|years?)/i.exec(source);
  if (year) return Number(year[1]);
  const month = /(\d+(?:\.\d+)?)\s*(?:个月|months?)/i.exec(source);
  return month ? Number(month[1]) / 12 : null;
}

function parseExperienceRequirement(requirement) {
  const source = displayValue(requirement);
  if (!source) return null;
  if (/经验不限|不限经验|无经验要求|无需经验|应届(?:生)?可|接受应届|fresh graduates? (?:welcome|accepted)/i.test(source)) return { unrestricted: true };
  const minimum = /(?:至少|最低|min(?:imum)?\.?\s*)\s*(\d+(?:\.\d+)?)\s*(年|个月|years?|months?)/i.exec(source)
    || /(\d+(?:\.\d+)?)\s*(年|years?)\s*(?:及以上|以上|起|\+)/i.exec(source)
    || /(\d+(?:\.\d+)?)\s*\+\s*(years?|年)/i.exec(source);
  if (minimum) return { minYears: Number(minimum[1]) * (/个月|months?/i.test(minimum[2]) ? 1 / 12 : 1) };
  const maximum = /(?:不超过|至多|最多)\s*(\d+(?:\.\d+)?)\s*(年|个月|years?|months?)|(?:\b|^)(\d+(?:\.\d+)?)\s*(年|个月|years?|months?)\s*(?:以内|以下)/i.exec(source);
  if (maximum) {
    const amount = Number(maximum[1] || maximum[3]);
    const unit = maximum[2] || maximum[4];
    return { maxYears: amount * (/个月|months?/i.test(unit) ? 1 / 12 : 1) };
  }
  const range = /(\d+(?:\.\d+)?)\s*(?:-|~|—|–|至)\s*(\d+(?:\.\d+)?)\s*(年|years?)/i.exec(source);
  if (range) return { minYears: Number(range[1]) };
  const plain = /(\d+(?:\.\d+)?)\s*(年|个月|years?|months?)(?:[^\d]{0,12})(?:经验|experience)/i.exec(source)
    || /(?:经验|experience)(?:[^\d]{0,12})(\d+(?:\.\d+)?)\s*(年|个月|years?|months?)/i.exec(source);
  return plain ? { minYears: Number(plain[1]) * (/个月|months?/i.test(plain[2]) ? 1 / 12 : 1) } : null;
}

function qualificationCheck({ key, label, requirement, candidate, parsed, candidateValue, pass, passMessage, failMessage }) {
  if (!requirement) {
    return { key, label, status: 'unknown', published: false, requirement: '', candidate: displayValue(candidate), message: `岗位未公开${label}硬条件` };
  }
  if (parsed?.unrestricted) {
    return { key, label, status: 'pass', published: true, requirement, candidate: displayValue(candidate), message: `${label}：岗位公开说明不限` };
  }
  if (!parsed) {
    return { key, label, status: 'unknown', published: true, requirement, candidate: displayValue(candidate), message: `${label}要求已公开，但无法可靠解析` };
  }
  if (candidateValue === null || candidateValue === undefined) {
    return { key, label, status: 'unknown', published: true, requirement, candidate: '', message: `岗位公开了${label}要求，画像尚未填写对应信息` };
  }
  const passed = Boolean(pass(parsed, candidateValue));
  return {
    key, label, status: passed ? 'pass' : 'fail', published: true, requirement,
    candidate: displayValue(candidate), message: passed ? passMessage(requirement, candidate) : failMessage(requirement, candidate),
  };
}

function evaluateQualifications(job, profile) {
  const degreeRequirement = requirementSnippet(job, ['degree', 'education', 'educationLevel'], value => /学历|学位|博士|硕士|研究生|本科|学士|大专|专科|高中|bachelor|master|ph\.?d|doctorate/i.test(value));
  const cohortRequirement = requirementSnippet(job, ['audience', 'cohort', 'graduationCohort', 'graduateYear', 'graduationYear', 'recruitmentTarget', 'batch'], value => /届|毕业|应届|往届|class\s+of/i.test(value));
  const workRequirement = requirementSnippet(job, ['experience', 'experienceRequirement', 'workExperience'], value => /经验|应届|\d+\s*(?:年|个月|years?|months?)/i.test(value));
  const candidateEducation = profile?.educationLevel || profile?.degree || '';
  const candidateGraduation = cohortYear(profile?.graduationYear ?? profile?.graduateYear);
  const candidateExperience = experienceYears(profile?.experienceYears ?? profile?.workExperienceYears ?? profile?.yearsExperience ?? profile?.experience);

  const checks = [
    qualificationCheck({
      key: 'education', label: '学历', requirement: degreeRequirement, candidate: candidateEducation,
      parsed: parseEducationRequirement(degreeRequirement), candidateValue: educationLevel(candidateEducation)?.rank ?? null,
      pass: (parsed, candidate) => candidate >= parsed.minRank,
      passMessage: requirement => `学历达到公开要求：${requirement}`,
      failMessage: (requirement, candidate) => `学历可能不满足公开要求：岗位要求“${requirement}”，画像为“${candidate}”`,
    }),
    qualificationCheck({
      key: 'graduation', label: '毕业届次', requirement: cohortRequirement, candidate: candidateGraduation || '',
      parsed: parseCohortRequirement(cohortRequirement), candidateValue: candidateGraduation,
      pass: (parsed, candidate) => parsed.years ? parsed.years.includes(candidate)
        : (parsed.minYear === undefined || candidate >= parsed.minYear) && (parsed.maxYear === undefined || candidate <= parsed.maxYear),
      passMessage: requirement => `毕业年份符合公开届次：${requirement}`,
      failMessage: (requirement, candidate) => `毕业年份不在公开招聘届次内：岗位要求“${requirement}”，画像为“${candidate}”`,
    }),
    qualificationCheck({
      key: 'experience', label: '经验', requirement: workRequirement,
      candidate: candidateExperience === null ? '' : `${candidateExperience} 年`, parsed: parseExperienceRequirement(workRequirement),
      candidateValue: candidateExperience,
      pass: (parsed, candidate) => (parsed.minYears === undefined || candidate >= parsed.minYears) && (parsed.maxYears === undefined || candidate <= parsed.maxYears),
      passMessage: requirement => `经验年限符合公开要求：${requirement}`,
      failMessage: (requirement, candidate) => `经验年限可能不满足公开要求：岗位要求“${requirement}”，画像为“${candidate}”`,
    }),
  ];
  const failures = checks.filter(check => check.status === 'fail');
  const unresolvedPublished = checks.some(check => check.published && check.status === 'unknown');
  const evaluated = checks.some(check => check.status === 'pass' || check.status === 'fail');
  const status = failures.length ? 'fail' : unresolvedPublished || !evaluated ? 'unknown' : 'pass';
  return {
    status,
    label: QUALIFICATION_LABELS[status],
    checks,
    risks: failures.map(check => check.message),
    penalty: Math.min(60, failures.length * 25),
  };
}

function includesAny(haystack, needles) {
  return needles.some(item => item && haystack.includes(item));
}

function normalizeFilterList(value) {
  return values(value);
}

function hintsForMajor(major) {
  const normalized = text(major);
  const key = Object.keys(MAJOR_HINTS).find(item => normalized.includes(text(item)) || text(item).includes(normalized));
  return key ? MAJOR_HINTS[key].map(text) : [];
}

function jobPassesFilters(job, filters = {}) {
  const haystack = jobSearchText(job);
  const q = text(filters.q);
  if (q && !haystack.includes(q)) return false;
  const locations = normalizeFilterList(filters.location);
  if (locations.length && !includesAny(text(job.location), locations)) return false;
  const roles = normalizeFilterList(filters.role);
  if (roles.length && !includesAny(`${text(job.position)} ${text(job.matchDir)}`, roles)) return false;
  const industries = normalizeFilterList(filters.industry);
  if (industries.length && !includesAny(text(job.industry), industries)) return false;
  const majors = normalizeFilterList(filters.major);
  if (majors.length) {
    const explicit = `${text(job.major)} ${values(job.majors).join(' ')}`;
    const hinted = majors.some(major => includesAny(haystack, hintsForMajor(major)));
    if (!includesAny(explicit, majors) && !hinted) return false;
  }
  const requestedCurrency = filters.currency ? normalizeCurrency(filters.currency) : '';
  const salaryMin = filters.salaryMin === undefined || filters.salaryMin === '' ? null : Number(filters.salaryMin);
  const salaryMax = filters.salaryMax === undefined || filters.salaryMax === '' ? null : Number(filters.salaryMax);
  if (salaryMin !== null || salaryMax !== null || requestedCurrency) {
    const normalized = normalizeSalary(job);
    if (!normalized) return false;
    if (requestedCurrency && normalized.currency !== requestedCurrency) return false;
    const requestedPeriod = normalizeSalaryPeriod(filters.salaryPeriod || 'month');
    const monthly = salaryForPeriod(normalized, requestedPeriod);
    if (salaryMin !== null && (!Number.isFinite(salaryMin) || monthly.max < salaryMin)) return false;
    if (salaryMax !== null && (!Number.isFinite(salaryMax) || monthly.min > salaryMax)) return false;
  }
  return true;
}

function matchJob(job, profile) {
  const qualification = evaluateQualifications(job, profile);
  if (!profile || ![profile.majors, profile.targetRoles, profile.locations, profile.industries, profile.skills, profile.workModes].some(items => items?.length)) {
    return {
      score: 0,
      label: '待完善画像',
      reasons: ['完善专业、目标岗位、技能和城市后可生成个性化解释'],
      gaps: [],
      risks: qualification.risks,
      qualification,
      dimensions: { role: 0, location: 0, industry: 0, major: 0, skills: 0, workMode: 0, salary: 0 },
    };
  }
  const haystack = jobSearchText(job);
  const position = `${text(job.position)} ${text(job.matchDir)}`;
  const dimensions = { role: 0, location: 0, industry: 0, major: 0, skills: 0, workMode: 0, salary: 0 };
  const reasons = [];
  const gaps = [];

  const roles = (profile.targetRoles || []).map(text).filter(Boolean);
  if (roles.length && includesAny(position, roles)) {
    dimensions.role = 30;
    reasons.push(`目标岗位匹配：${profile.targetRoles.find(role => position.includes(text(role)))}`);
  } else if (roles.length) {
    gaps.push('岗位名称与目标方向不直接匹配');
  }

  const locations = (profile.locations || []).map(text).filter(Boolean);
  if (locations.length && includesAny(text(job.location), locations)) {
    dimensions.location = 15;
    reasons.push(`目标城市匹配：${job.location}`);
  } else if (locations.length) {
    gaps.push('工作地点不在首选城市');
  }

  const industries = (profile.industries || []).map(text).filter(Boolean);
  if (industries.length && includesAny(text(job.industry), industries)) {
    dimensions.industry = 10;
    reasons.push(`目标行业匹配：${job.industry}`);
  }

  const matchedMajor = (profile.majors || []).find(major => {
    const normalized = text(major);
    return haystack.includes(normalized) || includesAny(haystack, hintsForMajor(major));
  });
  if (matchedMajor) {
    dimensions.major = 15;
    reasons.push(`专业能力方向相关：${matchedMajor}`);
  } else if ((profile.majors || []).length) {
    gaps.push('岗位信息未体现专业相关性');
  }

  const skills = (profile.skills || []).map(text).filter(Boolean);
  const matchedSkills = (profile.skills || []).filter(skill => haystack.includes(text(skill)));
  if (matchedSkills.length) {
    dimensions.skills = Math.min(15, 5 + matchedSkills.length * 5);
    reasons.push(`技能关键词匹配：${matchedSkills.slice(0, 3).join('、')}`);
  } else if (skills.length && (job.requirements || job.skills || job.skillTags || job.description)) {
    gaps.push('公开要求中未找到已填写技能的直接匹配');
  }

  const workModes = (profile.workModes || []).map(text).filter(Boolean);
  const jobMode = `${text(job.workMode)} ${text(job.nature)} ${text(job.location)} ${text(job.description)}`;
  const matchedMode = (profile.workModes || []).find(mode => jobMode.includes(text(mode)));
  if (matchedMode) {
    dimensions.workMode = 5;
    reasons.push(`工作方式匹配：${matchedMode}`);
  }

  const salary = salaryForPeriod(normalizeSalary(job), profile.salaryPeriod || 'month');
  const expectedMin = profile.salaryMin === null || profile.salaryMin === undefined || profile.salaryMin === '' ? Number.NaN : Number(profile.salaryMin);
  const expectedMax = profile.salaryMax === null || profile.salaryMax === undefined || profile.salaryMax === '' ? Number.NaN : Number(profile.salaryMax);
  const hasExpected = Number.isFinite(expectedMin) || Number.isFinite(expectedMax);
  if (salary && hasExpected && salary.currency === profile.salaryCurrency) {
    const lower = Number.isFinite(expectedMin) ? expectedMin : 0;
    const upper = Number.isFinite(expectedMax) ? expectedMax : Number.POSITIVE_INFINITY;
    if (salary.max >= lower && salary.min <= upper) {
      dimensions.salary = 10;
      reasons.push('公开薪资区间与期望有交集');
    } else {
      gaps.push('公开薪资区间与期望不重合');
    }
  }

  const restrictionHits = (profile.restrictions || []).filter(item => haystack.includes(text(item)));
  if (restrictionHits.length) gaps.push(`需核对个人限制：${restrictionHits.slice(0, 3).join('、')}`);

  const risks = [...qualification.risks];
  qualification.risks.forEach(risk => gaps.push(`资格风险：${risk}`));
  if (restrictionHits.length) risks.push(`个人限制可能冲突：${restrictionHits.slice(0, 3).join('、')}`);

  const rawScore = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  const score = Math.max(0, Math.min(100, rawScore - Math.min(20, restrictionHits.length * 10) - qualification.penalty));
  const label = qualification.status === 'fail' ? '硬条件风险'
    : score >= 80 ? '高度匹配' : score >= 60 ? '值得优先' : score >= 40 ? '可以探索' : '谨慎评估';
  if (!reasons.length) reasons.push('暂未发现画像中的明确匹配信号');
  return { score, label, reasons, gaps, risks, qualification, dimensions };
}

module.exports = {
  jobPassesFilters,
  matchJob,
  evaluateQualifications,
  normalizeCurrency,
  normalizeSalary,
  salaryForPeriod,
};
