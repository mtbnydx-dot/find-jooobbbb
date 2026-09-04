/* 秋招云端看板 — 岗位、信息源与运行中心，全 DOM API */
(function () {
  'use strict';

  const STATUS_LIST = ['未投递', '已投递', '笔试', '一面', '二面', 'offer', '挂'];
  const STATUS_CLS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6'];
  const PAGE_SIZE = 60;
  const KIND_LABELS = { feishu: '飞书', tencent: '腾讯文档', html: '网页表格', json: 'JSON', xlsx: 'Excel' };
  const $ = id => document.getElementById(id);
  const configuredOpsBase = document.querySelector('meta[name="ops-public-base"]')?.content.replace(/\/+$/, '') || '/ops';
  const OPS_API_ROOT = configuredOpsBase === '/ops' ? '/api' : `${configuredOpsBase}/api`;
  const apiRoute = route => String(route || '').startsWith('/api') ? `${OPS_API_ROOT}${String(route).slice(4)}` : route;

  let allJobs = [];
  let sources = [];
  let runs = [];
  let notifications = [];
  let research = [];
  let overview = {};
  let aiDashboardData = {};
  let aiRuns = [];
  let aiFormLoaded = false;
  let aiPollTimer = null;
  let activeFilter = 'all';
  let editingJob = null;
  let editingSource = null;
  let displayLimit = PAGE_SIZE;
  let pwd = '';
  let aiPwd = '';
  let editPasswordRequired = true;
  let aiEditPasswordRequired = true;
  let aiEditPasswordConfigured = false;
  let loginSourceId = '';
  let loginTimer = null;

  function classificationOf(job) { return job.classification || job.source || '全部岗位'; }
  function isCustom(job) { return job.isCustom === '1' || job.source === '自选'; }
  const FILTERS = [
    { key: 'all', label: '全部', fn: () => true },
    { key: 'urgent', label: '7天内截止', fn: job => { const days = daysLeft(job.deadline); return days !== null && days >= 0 && days <= 7 && job.status === '未投递'; } },
    { key: 's0', label: '未投递', fn: job => job.status === '未投递' },
    { key: 's1', label: '已投递', fn: job => job.status === '已投递' },
    { key: 's2', label: '笔试', fn: job => job.status === '笔试' },
    { key: 's3', label: '一面', fn: job => job.status === '一面' },
    { key: 's4', label: '二面', fn: job => job.status === '二面' },
    { key: 's5', label: 'offer', fn: job => job.status === 'offer' },
    { key: 's6', label: '挂了', fn: job => job.status === '挂' },
    { key: 'self', label: '自选', fn: isCustom },
    { key: 'fit', label: '符合条件', fn: job => classificationOf(job) === '符合条件' },
    { key: 'ai-recommended', label: 'AI 推荐', fn: job => aiAssessmentOf(job)?.fresh && Number(job.aiAssessment.score) >= 70 },
    { key: 'try', label: '可试试', fn: job => classificationOf(job) === '可试试' },
    { key: 'pool', label: '岗位池', fn: job => classificationOf(job) === '全部岗位' },
  ];

  function clear(element) { while (element && element.firstChild) element.removeChild(element.firstChild); }
  function safeUrl(raw) {
    try {
      const url = new URL(String(raw || ''));
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (_) { /* ignore */ }
    return null;
  }
  function button(label, className, action, id) {
    const item = document.createElement('button');
    item.type = 'button'; item.className = className || 'btn'; item.textContent = label;
    if (action) item.dataset.action = action;
    if (id) item.dataset.sourceId = id;
    return item;
  }
  function parseArray(value) {
    try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; }
  }
  function originLabel(job) {
    const names = parseArray(job.origins);
    return names.length ? names.join('、') : '历史导入';
  }
  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', { timeZone: 'Australia/Brisbane', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  async function api(route, options) {
    const response = await fetch(apiRoute(route), options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      if (data.code === 'PRODUCT_ADMIN_REQUIRED') {
        throw new Error(`${data.error || '需要管理员权限'}；请点击顶部“用户端 / 管理员登录”后刷新`);
      }
      throw new Error(data.error || `请求失败（${response.status}）`);
    }
    return data;
  }
  function askPassword(message) {
    if (!editPasswordRequired) return '';
    if (pwd) return pwd;
    const value = prompt(message || '请输入编辑密码：');
    if (value === null || !value.trim()) return null;
    return value.trim();
  }
  function askAiPassword(message) {
    if (!aiEditPasswordRequired) return '';
    if (!aiEditPasswordConfigured) {
      toast('服务器尚未配置 AI 画像密码');
      return null;
    }
    if (aiPwd) return aiPwd;
    const value = prompt(message || '请输入 AI 画像密码：');
    if (value === null || !value.trim()) return null;
    return value.trim();
  }
  function updatePasswordUi() {
    document.querySelectorAll('.password-only').forEach(element => { element.hidden = !editPasswordRequired; });
  }
  function toast(message) {
    const item = $('toast');
    item.textContent = message;
    item.classList.add('show');
    clearTimeout(item._timer);
    item._timer = setTimeout(() => item.classList.remove('show'), 2600);
  }

  function daysLeft(deadline) {
    if (!deadline) return null;
    const value = String(deadline).trim();
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return null;
    const date = new Date(value.replace(/\//g, '-') + 'T23:59:59');
    if (Number.isNaN(date.getTime())) return null;
    return Math.ceil((date - Date.now()) / 86_400_000);
  }
  function makeChip(label, className) {
    const item = document.createElement('span'); item.className = `chip ${className}`; item.textContent = label; return item;
  }
  function makeStatusPill(status) {
    const item = document.createElement('span'); item.className = `status-pill ${status || 'never'}`;
    item.textContent = ({ success: '成功', failed: '失败', running: '运行中', queued: '排队中', never: '未运行' })[status] || status || '未运行';
    return item;
  }
  function makeDDL(deadline) {
    const item = document.createElement('span');
    const days = daysLeft(deadline);
    if (days === null) { item.className = 'ddl gray'; item.textContent = '招满为止'; }
    else if (days < 0) { item.className = 'ddl off'; item.textContent = '已截止'; }
    else if (days <= 3) { item.className = 'ddl red'; item.textContent = `剩${days}天`; }
    else if (days <= 7) { item.className = 'ddl amber'; item.textContent = `剩${days}天`; }
    else { item.className = 'ddl blue'; item.textContent = `剩${days}天`; }
    return item;
  }
  function makePriority(value) {
    const text = String(value || '');
    if (text.includes('高')) return makeChip('高优先级', 'pri-high');
    if (text.includes('中')) return makeChip('中优先级', 'pri-mid');
    if (text.includes('低')) return makeChip('低优先级', 'pri-mid');
    return null;
  }
  function aiAssessmentOf(job) { return job && job.aiAssessment && Number.isFinite(Number(job.aiAssessment.score)) ? job.aiAssessment : null; }
  function recommendationClass(value) {
    if (value === '强烈推荐') return 'strong';
    if (value === '推荐') return 'good';
    if (value === '可尝试') return 'try';
    return 'no';
  }
  function makeAiResult(job, { detail = true } = {}) {
    const assessment = aiAssessmentOf(job);
    if (!assessment) { const empty = document.createElement('span'); empty.className = 'ai-empty'; empty.textContent = '未评估'; return empty; }
    const root = document.createElement('div');
    const line = document.createElement('div'); line.className = 'ai-score';
    const score = document.createElement('strong'); score.textContent = assessment.score;
    const rec = document.createElement('span'); rec.className = `ai-rec ${recommendationClass(assessment.recommendation)}`; rec.textContent = assessment.recommendation;
    line.append(score, rec);
    if (!assessment.fresh) { const stale = document.createElement('span'); stale.className = 'ai-stale'; stale.textContent = '已过期'; stale.title = '岗位内容、画像或模型已变化，等待重新评估'; line.appendChild(stale); }
    root.appendChild(line);
    if (detail && assessment.reason) { const reason = document.createElement('div'); reason.className = 'ai-reason'; reason.textContent = assessment.reason; root.appendChild(reason); }
    if (detail && Array.isArray(assessment.matchedRoles) && assessment.matchedRoles.length) { const roles = document.createElement('div'); roles.className = 'ai-top-role'; roles.textContent = assessment.matchedRoles.join(' · '); root.appendChild(roles); }
    return root;
  }
  function makeStatusButton(job) {
    const item = document.createElement('button');
    const index = STATUS_LIST.indexOf(job.status);
    item.className = `st ${index >= 0 ? STATUS_CLS[index] : 's0'}`;
    item.textContent = `${job.status || '未投递'} ▾`;
    item.dataset.id = job.id;
    item.type = 'button';
    return item;
  }
  function makeLink(label, raw) {
    const href = safeUrl(raw);
    if (!href) return null;
    const link = document.createElement('a'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label;
    return link;
  }

  function renderStats() {
    const total = allJobs.length;
    const applied = allJobs.filter(job => ['已投递', '笔试', '一面', '二面', 'offer'].includes(job.status)).length;
    const ongoing = allJobs.filter(job => ['笔试', '一面', '二面'].includes(job.status)).length;
    const offers = allJobs.filter(job => job.status === 'offer').length;
    const urgent = allJobs.filter(job => { const days = daysLeft(job.deadline); return days !== null && days >= 0 && days <= 7 && job.status === '未投递'; }).length;
    const definitions = [
      { number: total, label: '总岗位', className: '', filter: 'all' },
      { number: applied, label: '已投递', className: 'blue', filter: 's1' },
      { number: ongoing, label: '进行中', className: 'amber', filter: '__ongoing__' },
      { number: offers, label: 'Offer', className: 'green', filter: 's5' },
      { number: urgent, label: '7天内截止', className: 'red', filter: 'urgent' },
      { number: allJobs.filter(isCustom).length, label: '自选', className: 'teal', filter: 'self' },
      { number: allJobs.filter(job => classificationOf(job) === '符合条件').length, label: '符合条件', className: '', filter: 'fit' },
      { number: allJobs.filter(job => aiAssessmentOf(job)?.fresh && Number(job.aiAssessment.score) >= 70).length, label: 'AI 推荐', className: 'green', filter: 'ai-recommended' },
    ];
    const root = $('stats'); clear(root);
    for (const definition of definitions) {
      const card = document.createElement('div'); card.className = `stat ${definition.className}`;
      const number = document.createElement('div'); number.className = 'num'; number.textContent = definition.number;
      const label = document.createElement('div'); label.className = 'lbl'; label.textContent = definition.label;
      card.append(number, label);
      card.addEventListener('click', () => { activeFilter = definition.filter; displayLimit = PAGE_SIZE; renderJobs(); });
      root.appendChild(card);
    }
  }
  function renderTabs() {
    const root = $('tabs'); clear(root);
    const filters = FILTERS.concat([{ key: '__ongoing__', label: '进行中', fn: job => ['笔试', '一面', '二面'].includes(job.status) }]);
    for (const filter of filters) {
      const item = document.createElement('button'); item.type = 'button'; item.className = `tab${filter.key === activeFilter ? ' on' : ''}`;
      item.textContent = filter.label; item.dataset.filter = filter.key; root.appendChild(item);
    }
  }
  function filteredJobs() {
    const query = ($('search').value || '').trim().toLowerCase();
    const priority = $('priFilter').value;
    const classification = $('sourceFilter').value;
    const aiFilter = $('aiFilter').value;
    const filter = FILTERS.concat([{ key: '__ongoing__', fn: job => ['笔试', '一面', '二面'].includes(job.status) }]).find(item => item.key === activeFilter) || FILTERS[0];
    let list = allJobs.filter(filter.fn);
    if (priority === '自选') list = list.filter(isCustom);
    else if (priority) list = list.filter(job => String(job.priority || '').includes(priority));
    if (classification === '自选') list = list.filter(isCustom);
    else if (classification) list = list.filter(job => classificationOf(job) === classification);
    if (aiFilter === 'strong') list = list.filter(job => aiAssessmentOf(job)?.fresh && Number(job.aiAssessment.score) >= 85);
    else if (aiFilter === 'recommended') list = list.filter(job => aiAssessmentOf(job)?.fresh && Number(job.aiAssessment.score) >= 70);
    else if (aiFilter === 'scored') list = list.filter(job => aiAssessmentOf(job));
    else if (aiFilter === 'unscored') list = list.filter(job => !aiAssessmentOf(job));
    else if (aiFilter === 'stale') list = list.filter(job => aiAssessmentOf(job) && !job.aiAssessment.fresh);
    if (query) list = list.filter(job => {
      const assessment = aiAssessmentOf(job);
      return `${job.company || ''}${job.position || ''}${job.location || ''}${job.industry || ''}${job.sourceNote || ''}${job.note || ''}${assessment?.reason || ''}${(assessment?.matchedRoles || []).join('')}`.toLowerCase().includes(query);
    });
    const fitView = activeFilter === 'fit' || classification === '符合条件';
    const aiView = activeFilter === 'ai-recommended' || Boolean(aiFilter);
    return list.slice().sort((a, b) => {
      if (fitView || aiView) {
        const aAi = aiAssessmentOf(a); const bAi = aiAssessmentOf(b);
        const aFresh = aAi?.fresh ? 1 : 0; const bFresh = bAi?.fresh ? 1 : 0;
        if (aFresh !== bFresh) return bFresh - aFresh;
        if (aFresh && Number(aAi.score) !== Number(bAi.score)) return Number(bAi.score) - Number(aAi.score);
      }
      if (fitView) {
        const rank = value => String(value || '').includes('高') ? 0 : String(value || '').includes('中') ? 1 : String(value || '').includes('低') ? 2 : 3;
        const difference = rank(a.priority) - rank(b.priority);
        if (difference) return difference;
      }
      const aDays = daysLeft(a.deadline); const bDays = daysLeft(b.deadline);
      if (aDays !== null && bDays !== null) return aDays - bDays;
      if (aDays !== null) return -1;
      if (bDays !== null) return 1;
      return String(a.company || '').localeCompare(String(b.company || ''), 'zh-CN');
    });
  }
  function renderJobTable(list) {
    const root = $('tableWrap'); clear(root);
    const table = document.createElement('table');
    const head = document.createElement('thead'); const headRow = document.createElement('tr');
    ['公司', '岗位', '地点', '来源', '截止', '优先级', 'AI 匹配', '状态', '链接', '操作'].forEach(label => { const cell = document.createElement('th'); cell.textContent = label; headRow.appendChild(cell); });
    head.appendChild(headRow); table.appendChild(head);
    const body = document.createElement('tbody');
    if (!list.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 10; cell.className = 'empty-row'; cell.textContent = '没有符合当前筛选的岗位'; row.appendChild(cell); body.appendChild(row); }
    for (const job of list) {
      const row = document.createElement('tr');
      const company = document.createElement('td'); company.className = 'company'; company.textContent = job.company; row.appendChild(company);
      const position = document.createElement('td'); position.className = 'position'; const positionText = document.createElement('div'); positionText.textContent = job.position; position.appendChild(positionText); if (job.sourceNote) { const sourceNote = document.createElement('div'); sourceNote.className = 'source-note'; sourceNote.textContent = `来源提示：${job.sourceNote}`; position.appendChild(sourceNote); } row.appendChild(position);
      const location = document.createElement('td'); location.className = 'location'; location.textContent = job.location || '—'; row.appendChild(location);
      const origin = document.createElement('td'); origin.className = 'location'; origin.textContent = originLabel(job); origin.title = originLabel(job); row.appendChild(origin);
      const deadline = document.createElement('td'); deadline.appendChild(makeDDL(job.deadline)); row.appendChild(deadline);
      const priority = document.createElement('td');
      if (isCustom(job)) priority.appendChild(makeChip('自选', 'self')); else { const value = makePriority(job.priority); if (value) priority.appendChild(value); else priority.textContent = '—'; }
      row.appendChild(priority);
      const ai = document.createElement('td'); ai.className = 'ai-fit-cell'; ai.appendChild(makeAiResult(job)); row.appendChild(ai);
      const status = document.createElement('td'); status.appendChild(makeStatusButton(job)); row.appendChild(status);
      const links = document.createElement('td'); links.className = 'notice'; const apply = makeLink('投递', job.url); const notice = makeLink('公告', job.notice);
      if (apply) links.appendChild(apply); if (notice) { if (apply) links.appendChild(document.createTextNode(' · ')); links.appendChild(notice); } if (!apply && !notice) links.textContent = '—'; row.appendChild(links);
      const operations = document.createElement('td'); const operationRow = document.createElement('div'); operationRow.className = 'ops'; operationRow.appendChild(isCustom(job) ? button(job.source === '自选' ? '删除' : '取消自选', 'btn danger', 'delete-job', job.id) : button('+自选', 'btn', 'mark-job', job.id)); operations.appendChild(operationRow); row.appendChild(operations); body.appendChild(row);
    }
    table.appendChild(body); root.appendChild(table);
  }
  function renderJobCards(list) {
    const root = $('cards'); clear(root);
    if (!list.length) { const empty = document.createElement('div'); empty.className = 'empty-row'; empty.textContent = '没有符合当前筛选的岗位'; root.appendChild(empty); return; }
    for (const job of list) {
      const card = document.createElement('article'); card.className = 'card'; const top = document.createElement('div'); top.className = 'top'; const left = document.createElement('div');
      const company = document.createElement('div'); company.className = 'company'; company.textContent = job.company; left.append(company, makeDDL(job.deadline)); top.appendChild(left); card.appendChild(top);
      const position = document.createElement('div'); position.className = 'pos'; position.textContent = job.position; card.appendChild(position);
      const meta = document.createElement('div'); meta.className = 'meta';
      if (isCustom(job)) meta.appendChild(makeChip('自选', 'self')); else { const item = makePriority(job.priority); if (item) meta.appendChild(item); }
      if (job.location) meta.appendChild(makeChip(job.location, 'loc')); meta.appendChild(makeChip(originLabel(job), 'loc')); meta.appendChild(makeStatusButton(job)); card.appendChild(meta);
      if (job.sourceNote) { const sourceNote = document.createElement('div'); sourceNote.className = 'source-note'; sourceNote.textContent = `来源提示：${job.sourceNote}`; card.appendChild(sourceNote); }
      if (job.note) { const note = document.createElement('div'); note.className = 'note'; note.textContent = `备注：${job.note}`; card.appendChild(note); }
      if (aiAssessmentOf(job)) { const ai = document.createElement('div'); ai.className = 'ai-card-result'; ai.appendChild(makeAiResult(job)); card.appendChild(ai); }
      const actions = document.createElement('div'); actions.className = 'btns'; const apply = makeLink('投递链接', job.url); if (apply) actions.appendChild(apply); const notice = makeLink('官方公告', job.notice); if (notice) actions.appendChild(notice);
      actions.append(button('更新状态', 'btn-update', 'edit-job', job.id), isCustom(job) ? button(job.source === '自选' ? '删除' : '取消自选', 'btn-del', 'delete-job', job.id) : button('+自选', 'btn-update', 'mark-job', job.id)); card.appendChild(actions); root.appendChild(card);
    }
  }
  function renderPager(total, shown) {
    let root = $('pager');
    if (!root) { root = document.createElement('div'); root.id = 'pager'; root.style.cssText = 'text-align:center;padding:16px 0;color:var(--sub);font-size:13px'; $('tableWrap').parentNode.insertBefore(root, $('cards').nextSibling); }
    clear(root); if (total <= shown) return; const label = document.createElement('span'); label.textContent = `已显示 ${shown} / ${total} 条`; root.appendChild(label); const more = button('加载更多', 'btn'); more.style.marginLeft = '12px'; more.addEventListener('click', () => { displayLimit += PAGE_SIZE; renderJobs(); }); root.appendChild(more);
  }
  function renderJobs() { renderStats(); renderTabs(); const list = filteredJobs(); const shown = list.slice(0, displayLimit); renderJobTable(shown); renderJobCards(shown); renderPager(list.length, shown.length); }

  function switchView(name) {
    document.querySelectorAll('.view').forEach(view => view.classList.toggle('on', view.id === `${name}View`));
    document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('on', item.dataset.view === name));
    $('btnAdd').style.display = name === 'jobs' ? '' : 'none';
    if (name === 'ai') loadAi({ refreshJobs: true }).catch(error => toast(error.message));
    else if (name !== 'jobs') loadCloud().catch(error => toast(error.message));
  }
  function renderCloudSummary() {
    const root = $('cloudSummary'); clear(root); const items = [[overview.enabledSources || 0, '启用来源'], [overview.records || 0, '有效原始记录'], [overview.running || overview.queueLength || 0, '运行中/排队'], [overview.failed24h || 0, '24小时失败'], [overview.lastRun ? formatTime(overview.lastRun) : '—', '最近完成']];
    for (const [value, label] of items) { const box = document.createElement('div'); box.className = 'cloud-metric'; const strong = document.createElement('strong'); strong.textContent = value; const span = document.createElement('span'); span.textContent = label; box.append(strong, span); root.appendChild(box); }
  }
  function emptyPanel(root, title, subtitle) { const item = document.createElement('div'); item.className = 'empty-panel'; const strong = document.createElement('strong'); strong.textContent = title; const text = document.createElement('span'); text.textContent = subtitle; item.append(strong, text); root.appendChild(item); }
  function renderSources() {
    renderCloudSummary(); $('sourceHint').textContent = `${sources.length} 个来源 · 单并发排队执行`; const root = $('sourceList'); clear(root);
    if (!sources.length) { emptyPanel(root, '还没有信息源', '添加飞书、腾讯文档或其他查看链接后即可在云端自动同步。'); return; }
    const table = document.createElement('table'); table.className = 'admin-table'; const head = document.createElement('thead'); const headRow = document.createElement('tr'); ['名称', '平台/链接', '计划', '状态', '最近运行', '记录', '操作'].forEach(label => { const cell = document.createElement('th'); cell.textContent = label; headRow.appendChild(cell); }); head.appendChild(headRow); table.appendChild(head); const body = document.createElement('tbody');
    for (const source of sources) {
      const row = document.createElement('tr'); const name = document.createElement('td'); const title = document.createElement('div'); title.className = 'name'; title.textContent = source.name; const detail = document.createElement('div'); detail.className = 'muted mono'; detail.textContent = source.id; name.append(title, detail); row.appendChild(name);
      const platform = document.createElement('td'); const kind = document.createElement('div'); kind.className = 'name'; kind.textContent = `${KIND_LABELS[source.kind] || source.kind}${source.enabled ? '' : ' · 已停用'}`; const url = document.createElement('div'); url.className = 'muted'; url.textContent = source.url; platform.append(kind, url); row.appendChild(platform);
      const schedule = document.createElement('td'); schedule.className = 'mono'; schedule.textContent = source.schedule; row.appendChild(schedule); const status = document.createElement('td'); status.appendChild(makeStatusPill(source.lastStatus)); if (source.lastError) { const error = document.createElement('div'); error.className = 'run-error'; error.textContent = source.lastError; status.appendChild(error); } row.appendChild(status);
      const last = document.createElement('td'); last.textContent = formatTime(source.lastRunAt); row.appendChild(last); const count = document.createElement('td'); count.textContent = source.lastCount; row.appendChild(count); const operations = document.createElement('td'); const items = document.createElement('div'); items.className = 'ops'; items.append(button('运行', 'btn primary', 'run-source', source.id), button('登录', 'btn', 'login-source', source.id), button('编辑', 'btn', 'edit-source', source.id), button('移除', 'btn danger', 'archive-source', source.id)); operations.appendChild(items); row.appendChild(operations); body.appendChild(row);
    }
    table.appendChild(body); root.appendChild(table);
  }
  function renderRuns() {
    const root = $('runList'); clear(root);
    if (!runs.length) emptyPanel(root, '尚无运行记录', '手动运行信息源或等待定时任务后会显示在这里。');
    else {
      const table = document.createElement('table'); table.className = 'admin-table'; const head = document.createElement('thead'); const headRow = document.createElement('tr'); ['ID', '信息源', '触发', '状态', '开始/完成', '原始', '唯一', '新增/更新/失效', '错误'].forEach(label => { const cell = document.createElement('th'); cell.textContent = label; headRow.appendChild(cell); }); head.appendChild(headRow); table.appendChild(head); const body = document.createElement('tbody');
      for (const run of runs) { const row = document.createElement('tr'); [run.id, run.sourceName, run.trigger].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell); }); const status = document.createElement('td'); status.appendChild(makeStatusPill(run.status)); row.appendChild(status); const time = document.createElement('td'); time.textContent = `${formatTime(run.startedAt)} / ${formatTime(run.finishedAt)}`; row.appendChild(time); [run.fetchedCount, run.canonicalCount, `${run.insertedCount} / ${run.updatedCount} / ${run.inactiveCount}`].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell); }); const error = document.createElement('td'); error.className = 'run-error'; error.textContent = run.error || '—'; row.appendChild(error); body.appendChild(row); }
      table.appendChild(body); root.appendChild(table);
    }
    renderFeed($('notificationList'), notifications, item => ({ title: item.title, time: item.createdAt, body: item.body })); renderFeed($('researchList'), research, item => ({ title: `${item.company} · ${item.title}`, time: item.foundAt, body: item.snippet, url: item.url }));
  }
  function renderFeed(root, items, mapper) {
    clear(root); if (!items.length) { emptyPanel(root, '暂无内容', '任务运行后会自动保存在这里。'); return; }
    for (const raw of items.slice(0, 20)) { const data = mapper(raw); const item = document.createElement('article'); item.className = 'feed-item'; const title = data.url ? makeLink(data.title, data.url) : null; const heading = title || document.createElement('strong'); if (!title) heading.textContent = data.title; item.appendChild(heading); const time = document.createElement('time'); time.textContent = formatTime(data.time); item.appendChild(time); if (data.body) { const body = document.createElement('p'); body.textContent = data.body; item.appendChild(body); } root.appendChild(item); }
  }
  async function loadCloud() {
    const [overviewData, sourceData, runData, notificationData, researchData] = await Promise.all([api('/api/cloud/overview'), api('/api/cloud/sources'), api('/api/cloud/runs?limit=50'), api('/api/cloud/notifications?limit=30'), api('/api/cloud/research?limit=30')]);
    overview = overviewData; sources = sourceData.sources || []; runs = runData.runs || []; notifications = notificationData.notifications || []; research = researchData.results || []; renderSources(); renderRuns();
  }

  function fillAiForm(settings) {
    if (!settings) return;
    $('aiBaseUrl').value = settings.baseUrl || 'https://api.deepseek.com';
    $('aiModel').value = settings.model || 'deepseek-v4-flash';
    $('aiProfile').value = settings.profile || '';
    $('aiScope').value = settings.scope || 'candidates';
    $('aiMaxJobs').value = settings.maxJobs || 100;
    $('aiBatchSize').value = settings.batchSize || 8;
    $('aiEnabled').checked = settings.enabled !== false;
    $('aiAutoRun').checked = Boolean(settings.autoRun);
    $('aiApiKey').value = '';
    $('aiClearKey').checked = false;
    const source = settings.keySource === 'environment' ? '环境变量' : settings.keySource === 'saved' ? '服务器数据库' : '';
    $('aiKeyHint').textContent = settings.apiKeyConfigured ? `已配置${source ? ` · ${source}` : ''}（留空保持）` : '尚未配置';
    $('aiConfigHint').textContent = settings.apiKeyConfigured ? `已连接配置 · ${settings.model}` : 'API Key 不会回传到浏览器';
    aiFormLoaded = true;
  }

  function renderAiSummary() {
    const root = $('aiSummary'); clear(root); const settings = aiDashboardData.settings || {}; const stats = aiDashboardData.stats || {};
    const latest = aiDashboardData.latestRun;
    const items = [
      [settings.apiKeyConfigured ? '已配置' : '未配置', 'DeepSeek Key'],
      [stats.candidateJobs || 0, '当前评估范围'],
      [stats.freshCount || 0, '有效 AI 结果'],
      [stats.staleCount || 0, '待评估 / 已过期'],
      [latest ? makeStatusPill(latest.status).textContent : '—', '最近运行'],
    ];
    for (const [value, label] of items) { const box = document.createElement('div'); box.className = 'cloud-metric'; const strong = document.createElement('strong'); strong.textContent = value; const span = document.createElement('span'); span.textContent = label; box.append(strong, span); root.appendChild(box); }
  }

  function renderAiRuns() {
    const root = $('aiRunList'); clear(root);
    if (!aiRuns.length) { emptyPanel(root, '尚无 AI 运行', '配置 API Key 后点击“评估待处理岗位”。'); return; }
    const table = document.createElement('table'); table.className = 'admin-table'; const head = document.createElement('thead'); const headRow = document.createElement('tr');
    ['ID', '触发 / 范围', '状态', '候选 / 缓存', '评估 / 失败', '输入 / 输出 Token', '开始 / 完成', '错误'].forEach(label => { const cell = document.createElement('th'); cell.textContent = label; headRow.appendChild(cell); }); head.appendChild(headRow); table.appendChild(head); const body = document.createElement('tbody');
    for (const run of aiRuns) {
      const row = document.createElement('tr'); const id = document.createElement('td'); id.textContent = run.id; row.appendChild(id);
      const scope = document.createElement('td'); scope.textContent = `${run.trigger} · ${run.scope === 'all' ? '全部' : '候选'}${run.force ? ' · 强制' : ''}`; row.appendChild(scope);
      const status = document.createElement('td'); status.appendChild(makeStatusPill(run.status)); row.appendChild(status);
      [`${run.candidateCount} / ${run.cachedCount}`, `${run.assessedCount} / ${run.failedCount}`, `${run.inputTokens} / ${run.outputTokens}`, `${formatTime(run.startedAt)} / ${formatTime(run.finishedAt)}`].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell); });
      const error = document.createElement('td'); error.className = 'run-error'; error.textContent = run.error || '—'; row.appendChild(error); body.appendChild(row);
    }
    table.appendChild(body); root.appendChild(table);
  }

  function renderAiTop() {
    const root = $('aiTopList'); clear(root);
    const jobs = allJobs.filter(job => aiAssessmentOf(job)?.fresh).sort((a, b) => Number(b.aiAssessment.score) - Number(a.aiAssessment.score)).slice(0, 30);
    if (!jobs.length) { emptyPanel(root, '还没有有效 AI 结果', '运行评估后，高匹配岗位会按分数显示在这里。'); return; }
    const table = document.createElement('table'); table.className = 'admin-table'; const head = document.createElement('thead'); const headRow = document.createElement('tr');
    ['分数', '公司', '岗位', '地点', '匹配理由', '投递'].forEach(label => { const cell = document.createElement('th'); cell.textContent = label; headRow.appendChild(cell); }); head.appendChild(headRow); table.appendChild(head); const body = document.createElement('tbody');
    for (const job of jobs) {
      const row = document.createElement('tr'); const score = document.createElement('td'); score.appendChild(makeAiResult(job, { detail: false })); row.appendChild(score);
      [job.company, job.position, job.location || '—'].forEach(value => { const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell); });
      const reason = document.createElement('td'); reason.className = 'ai-fit-cell'; reason.textContent = job.aiAssessment.reason || '—'; row.appendChild(reason);
      const apply = document.createElement('td'); apply.className = 'notice'; const link = makeLink('投递', job.url || job.notice); if (link) apply.appendChild(link); else apply.textContent = '—'; row.appendChild(apply); body.appendChild(row);
    }
    table.appendChild(body); root.appendChild(table);
  }

  function scheduleAiPoll() {
    clearTimeout(aiPollTimer); aiPollTimer = null;
    const active = aiDashboardData.queue?.current || Number(aiDashboardData.queue?.queued || 0) > 0 || aiRuns.some(run => ['queued', 'running'].includes(run.status));
    if (active) aiPollTimer = setTimeout(() => loadAi({ refreshJobs: true }).catch(error => toast(error.message)), 2500);
  }

  async function loadAi({ refreshJobs = false, forceForm = false } = {}) {
    const requests = [api('/api/cloud/ai'), api('/api/cloud/ai/runs?limit=30')];
    if (refreshJobs) requests.push(api('/api/jobs'));
    const [dashboard, runData, jobData] = await Promise.all(requests);
    aiDashboardData = dashboard; aiRuns = runData.runs || [];
    if (jobData) allJobs = jobData.jobs || [];
    if (forceForm || !aiFormLoaded) fillAiForm(dashboard.settings);
    renderAiSummary(); renderAiRuns(); renderAiTop(); renderJobs(); scheduleAiPoll();
  }

  function aiSettingsPayload(aiPassword) {
    return {
      aiPassword,
      enabled: $('aiEnabled').checked,
      autoRun: $('aiAutoRun').checked,
      baseUrl: $('aiBaseUrl').value.trim(),
      model: $('aiModel').value.trim(),
      apiKey: $('aiApiKey').value.trim(),
      clearApiKey: $('aiClearKey').checked,
      profile: $('aiProfile').value.trim(),
      scope: $('aiScope').value,
      maxJobs: Number($('aiMaxJobs').value),
      batchSize: Number($('aiBatchSize').value),
    };
  }

  async function persistAiSettings(aiPassword) {
    const data = await api('/api/cloud/ai/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(aiSettingsPayload(aiPassword)) });
    aiPwd = aiPassword; aiDashboardData.settings = data.settings; fillAiForm(data.settings); return data.settings;
  }

  async function saveAiSettings() {
    const aiPassword = askAiPassword(); if (aiPassword === null) return; const control = $('btnAiSave'); control.disabled = true; control.textContent = '保存中…';
    try { await persistAiSettings(aiPassword); await loadAi({ refreshJobs: true }); toast('AI 配置已保存'); } catch (error) { aiPwd = ''; toast(error.message); } finally { control.disabled = false; control.textContent = '保存配置'; }
  }

  async function testAi() {
    const aiPassword = askAiPassword(); if (aiPassword === null) return; const control = $('btnAiTest'); control.disabled = true; control.textContent = '测试中…';
    try { await persistAiSettings(aiPassword); const data = await api('/api/cloud/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiPassword }) }); toast(`连接成功 · ${data.result.model} · ${data.result.latencyMs}ms`); await loadAi({ refreshJobs: false }); } catch (error) { aiPwd = ''; toast(error.message); } finally { control.disabled = false; control.textContent = '测试连接'; }
  }

  async function runAi(force = false) {
    if (force && !confirm('强制重评会忽略缓存并再次产生 API 费用，确定继续？')) return;
    const aiPassword = askAiPassword(); if (aiPassword === null) return; const control = force ? $('btnAiForce') : $('btnAiRun'); const old = control.textContent; control.disabled = true; control.textContent = '提交中…';
    try {
      await persistAiSettings(aiPassword);
      const data = await api('/api/cloud/ai/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiPassword, scope: $('aiScope').value, limit: Number($('aiMaxJobs').value), force }) });
      toast(data.duplicate ? `AI 任务 #${data.runId} 已在队列中` : `AI 任务 #${data.runId} 已加入队列`); await loadAi({ refreshJobs: true });
    } catch (error) { aiPwd = ''; toast(error.message); } finally { control.disabled = false; control.textContent = old; }
  }

  function openEdit(job) {
    editingJob = job; $('mTitle').textContent = job.company; $('mSub').textContent = job.position; $('mPwd').value = pwd; if ($('mNote')) $('mNote').value = job.note || ''; const root = $('mStatus'); clear(root);
    for (const status of STATUS_LIST) { const item = button(status, ''); item.dataset.status = status; if (status === job.status) item.classList.add('on'); root.appendChild(item); }
    $('editMask').classList.add('show');
  }
  function closeEdit() { $('editMask').classList.remove('show'); editingJob = null; }
  async function saveEdit() {
    const selected = document.querySelector('#mStatus button.on'); const password = $('mPwd').value.trim(); if (!selected) return toast('请选择状态'); if (editPasswordRequired && !password) return toast('请输入编辑密码'); const save = $('mSave'); save.disabled = true; save.textContent = '保存中…';
    try { const data = await api(`/api/jobs/${encodeURIComponent(editingJob.id)}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, status: selected.dataset.status, note: $('mNote') ? $('mNote').value.trim() : editingJob.note || '' }) }); pwd = password; Object.assign(allJobs.find(job => job.id === editingJob.id) || {}, data.job); closeEdit(); renderJobs(); toast('状态和备注已更新'); } catch (error) { toast(error.message); } finally { save.disabled = false; save.textContent = '保存'; }
  }
  function openAdd() { ['aCompany', 'aPosition', 'aDeadline', 'aLocation', 'aUrl', 'aNote'].forEach(id => { $(id).value = ''; }); $('aPwd').value = pwd; $('addMask').classList.add('show'); }
  function closeAdd() { $('addMask').classList.remove('show'); }
  async function saveAdd() {
    const password = $('aPwd').value.trim(); const company = $('aCompany').value.trim(); const position = $('aPosition').value.trim(); if (!company || !position) return toast('公司和岗位必填'); if (editPasswordRequired && !password) return toast('请输入编辑密码'); const deadline = $('aDeadline').value; const save = $('aSave'); save.disabled = true; save.textContent = '添加中…';
    try { const data = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, company, position, deadline: deadline ? deadline.replace(/-/g, '/') : '', location: $('aLocation').value.trim(), url: $('aUrl').value.trim(), note: $('aNote').value.trim() }) }); pwd = password; allJobs.push(data.job); closeAdd(); renderJobs(); toast('自选岗位已保存在云端'); } catch (error) { toast(error.message); } finally { save.disabled = false; save.textContent = '添加'; }
  }
  async function markCustom(job) { if (!confirm(`把「${job.company}」标记为自选岗位？`)) return; const password = askPassword(); if (password === null) return; try { const data = await api(`/api/jobs/${encodeURIComponent(job.id)}/mark-custom`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); pwd = password; Object.assign(job, data.job); renderJobs(); toast('已标记为自选'); } catch (error) { pwd = ''; toast(error.message); } }
  async function deleteCustom(job) { const imported = job.source !== '自选'; if (!confirm(imported ? `取消「${job.company}」的自选标记？岗位仍会保留在来源列表中。` : `确定删除自选岗位「${job.company}」吗？`)) return; const password = askPassword(); if (password === null) return; try { const data = await api(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); pwd = password; if (data.unmarked && data.job) Object.assign(job, data.job); else allJobs = allJobs.filter(item => item.id !== job.id); renderJobs(); toast(data.unmarked ? '已取消自选' : '已删除'); } catch (error) { pwd = ''; toast(error.message); } }

  function openSource(source) {
    editingSource = source || null; $('sTitle').textContent = source ? '编辑信息源' : '添加信息源'; $('sId').value = source?.id || ''; $('sName').value = source?.name || ''; $('sKind').value = source?.kind || 'feishu'; $('sUrl').value = source?.url || ''; $('sTableId').value = source?.tableId || ''; $('sSheetName').value = source?.sheetName || ''; $('sSchedule').value = source?.schedule || '10:00,22:00'; $('sAuthProfile').value = source?.authProfile || ''; $('sEnabled').checked = source ? source.enabled : true; $('sFieldMap').value = JSON.stringify(source?.fieldMap || {}, null, 2); $('sConfig').value = JSON.stringify(source?.config || {}, null, 2); $('sPwd').value = pwd; $('sourceMask').classList.add('show');
  }
  function closeSource() { $('sourceMask').classList.remove('show'); editingSource = null; }
  async function saveSource() {
    const password = $('sPwd').value.trim(); if (editPasswordRequired && !password) return toast('请输入编辑密码'); let fieldMap; let config; try { fieldMap = JSON.parse($('sFieldMap').value || '{}'); config = JSON.parse($('sConfig').value || '{}'); } catch (_) { return toast('字段映射或高级配置不是有效 JSON'); }
    const payload = { password, name: $('sName').value.trim(), kind: $('sKind').value, url: $('sUrl').value.trim(), tableId: $('sTableId').value.trim(), sheetName: $('sSheetName').value.trim(), schedule: $('sSchedule').value.trim(), authProfile: $('sAuthProfile').value.trim() || $('sKind').value, enabled: $('sEnabled').checked, fieldMap, config }; const save = $('sSave'); save.disabled = true; save.textContent = '保存中…';
    try { const id = $('sId').value; await api(id ? `/api/cloud/sources/${encodeURIComponent(id)}` : '/api/cloud/sources', { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); pwd = password; closeSource(); await loadCloud(); toast(id ? '信息源已更新' : '信息源已添加'); } catch (error) { toast(error.message); } finally { save.disabled = false; save.textContent = '保存信息源'; }
  }
  async function aiPasswordForSourceRun() {
    let settings = aiDashboardData.settings;
    if (!settings) {
      const data = await api('/api/cloud/ai/settings');
      settings = data.settings;
      aiDashboardData.settings = settings;
    }
    if (!settings?.enabled || !settings?.autoRun) return '';
    return askAiPassword('当前已开启自动 AI 评估，请输入 AI 画像密码：');
  }
  async function runSource(sourceId) { const password = askPassword(); if (password === null) return; try { const aiPassword = await aiPasswordForSourceRun(); if (aiPassword === null) return; const data = await api(`/api/cloud/sources/${encodeURIComponent(sourceId)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, aiPassword }) }); pwd = password; if (aiPassword) aiPwd = aiPassword; toast(data.duplicate ? '该来源已在队列中' : `任务 #${data.runId} 已加入队列`); await loadCloud(); } catch (error) { pwd = ''; aiPwd = ''; toast(error.message); } }
  async function archiveSource(sourceId) { const source = sources.find(item => item.id === sourceId); if (!source || !confirm(`移除信息源「${source.name}」？历史运行记录仍会保留，仅由它提供的岗位会转为失效。`)) return; const password = askPassword(); if (password === null) return; try { await api(`/api/cloud/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); pwd = password; await loadCloud(); toast('信息源已移除'); } catch (error) { pwd = ''; toast(error.message); } }
  async function runAll() { const password = askPassword(); if (password === null) return; try { const aiPassword = await aiPasswordForSourceRun(); if (aiPassword === null) return; const data = await api('/api/cloud/run-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, aiPassword }) }); pwd = password; if (aiPassword) aiPwd = aiPassword; toast(`已处理 ${data.runs.length} 个来源`); await loadCloud(); } catch (error) { pwd = ''; aiPwd = ''; toast(error.message); } }
  async function reconcileJobs() {
    const password = askPassword(); if (password === null) return;
    const control = $('btnReconcile'); const old = control.textContent; control.disabled = true; control.textContent = '检查中…';
    try {
      const preview = await api('/api/cloud/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, dryRun: true }) });
      if (!preview.duplicatesRemoved && !preview.legacyDeactivated) { toast('数据已经整洁，无需处理'); return; }
      const message = `将合并 ${preview.duplicateGroups} 组重复岗位（减少 ${preview.duplicatesRemoved} 条），并把 ${preview.legacyDeactivated} 条无有效来源的历史岗位转为失效。个人状态、备注和 AI 结果会保留，继续吗？`;
      if (!confirm(message)) return;
      control.textContent = '整理中…';
      const result = await api('/api/cloud/reconcile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, dryRun: false }) });
      pwd = password;
      await loadCloud();
      await loadAi({ refreshJobs: true });
      toast(`已合并 ${result.duplicatesRemoved} 条重复岗位，当前 ${result.activeAfter} 条有效岗位`);
    } catch (error) { pwd = ''; toast(error.message); } finally { control.disabled = false; control.textContent = old; }
  }
  async function runSystem(kind) { const password = askPassword(); if (password === null) return; try { await api(`/api/cloud/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); pwd = password; toast('任务已加入队列'); await loadCloud(); } catch (error) { pwd = ''; toast(error.message); } }
  async function startLogin(sourceId) {
    const password = askPassword(); if (password === null) return; const source = sources.find(item => item.id === sourceId); loginSourceId = sourceId; $('loginTitle').textContent = `登录 · ${source?.name || sourceId}`; $('loginStatus').textContent = '正在打开云端浏览器…'; $('loginMask').classList.add('show');
    try { const data = await api(`/api/cloud/sources/${encodeURIComponent(sourceId)}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); pwd = password; $('loginStatus').textContent = data.message || '请扫码登录'; await refreshLogin(); clearInterval(loginTimer); loginTimer = setInterval(refreshLogin, 3000); } catch (error) { $('loginStatus').textContent = error.message; }
  }
  async function refreshLogin() { if (!loginSourceId) return; $('loginImage').src = apiRoute(`/api/cloud/sources/${encodeURIComponent(loginSourceId)}/login.png?t=${Date.now()}`); try { const status = await api(`/api/cloud/sources/${encodeURIComponent(loginSourceId)}/login`); $('loginStatus').textContent = status.message; if (status.status === 'ready') clearInterval(loginTimer); } catch (error) { $('loginStatus').textContent = error.message; } }
  async function closeLogin() { clearInterval(loginTimer); loginTimer = null; if (loginSourceId) await api(`/api/cloud/sources/${encodeURIComponent(loginSourceId)}/login`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) }).catch(() => {}); loginSourceId = ''; $('loginMask').classList.remove('show'); }
  async function exportExcel() {
    const password = askPassword(); if (password === null) return;
    try { const response = await fetch(apiRoute('/api/cloud/export.xlsx'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }); if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '导出失败'); } pwd = password; const blob = await response.blob(); const href = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = href; link.download = 'job-tracker-cloud.xlsx'; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000); toast('Excel 已生成'); } catch (error) { pwd = ''; toast(error.message); }
  }

  document.addEventListener('click', event => {
    const view = event.target.closest('[data-view]'); if (view) return switchView(view.dataset.view); const filter = event.target.closest('[data-filter]'); if (filter) { activeFilter = filter.dataset.filter; displayLimit = PAGE_SIZE; return renderJobs(); }
    const status = event.target.closest('.st'); if (status) { const job = allJobs.find(item => item.id === status.dataset.id); if (job) openEdit(job); return; } const statusChoice = event.target.closest('#mStatus button'); if (statusChoice) { document.querySelectorAll('#mStatus button').forEach(item => item.classList.remove('on')); statusChoice.classList.add('on'); return; }
    const action = event.target.closest('[data-action]'); if (!action) return; const sourceId = action.dataset.sourceId;
    if (action.dataset.action === 'edit-job') { const job = allJobs.find(item => item.id === sourceId); if (job) openEdit(job); } else if (action.dataset.action === 'mark-job') { const job = allJobs.find(item => item.id === sourceId); if (job) markCustom(job); } else if (action.dataset.action === 'delete-job') { const job = allJobs.find(item => item.id === sourceId); if (job) deleteCustom(job); } else if (action.dataset.action === 'run-source') runSource(sourceId); else if (action.dataset.action === 'login-source') startLogin(sourceId); else if (action.dataset.action === 'edit-source') openSource(sources.find(item => item.id === sourceId)); else if (action.dataset.action === 'archive-source') archiveSource(sourceId);
  });

  $('mSave').addEventListener('click', saveEdit); $('aSave').addEventListener('click', saveAdd); $('sSave').addEventListener('click', saveSource); $('btnAdd').addEventListener('click', openAdd); $('btnExport').addEventListener('click', exportExcel); $('btnAddSource').addEventListener('click', () => openSource(null)); $('btnRunAll').addEventListener('click', runAll); $('btnReconcile').addEventListener('click', reconcileJobs); $('btnDaily').addEventListener('click', () => runSystem('daily-check')); $('btnResearch').addEventListener('click', () => runSystem('research')); $('btnRefreshRuns').addEventListener('click', () => loadCloud().catch(error => toast(error.message))); $('loginRefresh').addEventListener('click', refreshLogin); $('loginClose').addEventListener('click', closeLogin);
  $('btnAiSave').addEventListener('click', saveAiSettings); $('btnAiTest').addEventListener('click', testAi); $('btnAiRun').addEventListener('click', () => runAi(false)); $('btnAiForce').addEventListener('click', () => runAi(true)); $('btnAiRefresh').addEventListener('click', () => loadAi({ refreshJobs: true, forceForm: true }).catch(error => toast(error.message)));
  $('editMask').addEventListener('click', event => { if (event.target === $('editMask')) closeEdit(); }); $('addMask').addEventListener('click', event => { if (event.target === $('addMask')) closeAdd(); }); $('sourceMask').addEventListener('click', event => { if (event.target === $('sourceMask')) closeSource(); }); $('search').addEventListener('input', () => { displayLimit = PAGE_SIZE; renderJobs(); }); $('priFilter').addEventListener('change', () => { displayLimit = PAGE_SIZE; renderJobs(); }); $('sourceFilter').addEventListener('change', () => { displayLimit = PAGE_SIZE; renderJobs(); }); $('aiFilter').addEventListener('change', () => { displayLimit = PAGE_SIZE; renderJobs(); });

  (async function init() {
    try { const [health, data] = await Promise.all([api('/api/health'), api('/api/jobs')]); editPasswordRequired = Boolean(health.editPasswordRequired); aiEditPasswordRequired = health.aiEditPasswordRequired !== false; aiEditPasswordConfigured = Boolean(health.aiEditPasswordConfigured); updatePasswordUi(); allJobs = data.jobs || []; const timestamp = data.meta?.lastSyncAt; $('syncTime').textContent = timestamp ? `更新于 ${formatTime(timestamp)} · ${data.total} 个唯一岗位` : `${data.total || 0} 个岗位 · 尚未运行云同步`; renderJobs(); }
    catch (error) { clear($('tableWrap')); const item = document.createElement('div'); item.className = 'empty-row'; item.textContent = `加载失败：${error.message}`; $('tableWrap').appendChild(item); }
  })();
})();
