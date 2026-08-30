'use strict';

const crypto = require('node:crypto');

const DEFAULT_AI_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_AI_MODEL = 'deepseek-v4-flash';
const PROMPT_VERSION = 'job-fit-v1';
const DEFAULT_AI_PROFILE = [
  '教育背景：昆士兰大学传播学硕士，网络与新媒体本科。',
  '优先方向：消费者洞察、用户研究、品牌、公关、营销传播、新媒体、内容运营、传媒影视、产品运营、商业分析、管培和综合职能。',
  '优先地点：合肥最高，其次上海、杭州、南京、苏州及长三角其他城市。',
  '判断原则：结合岗位职责线索、行业、地点与岗位名称判断真实匹配度；纯技术、强工程或明显要求不符的岗位应降分。',
].join('\n');

const RECOMMENDATIONS = new Set(['强烈推荐', '推荐', '可尝试', '不推荐']);

class AiApiError extends Error {
  constructor(message, { statusCode = 502, upstreamStatus = 0, retryable = false } = {}) {
    super(message);
    this.name = 'AiApiError';
    this.statusCode = statusCode;
    this.upstreamStatus = upstreamStatus;
    this.retryable = retryable;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableValue(value[key]);
    return result;
  }
  return value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex');
}

function jobContentHash(job) {
  return sha256({
    company: job?.company || '',
    nature: job?.nature || '',
    industry: job?.industry || '',
    position: job?.position || '',
    location: job?.location || '',
    deadline: job?.deadline || '',
    exam: job?.exam || '',
    sourceNote: job?.sourceNote || '',
    classification: job?.classification || job?.source || '',
    priority: job?.priority || '',
    matchDir: job?.matchDir || '',
  });
}

function aiProfileHash(settings) {
  return sha256({
    promptVersion: PROMPT_VERSION,
    profile: settings?.profile || '',
    model: settings?.model || DEFAULT_AI_MODEL,
  });
}

function trimString(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeStringArray(value, maxItems = 8, maxLength = 100) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => trimString(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function inferredRecommendation(score) {
  if (score >= 85) return '强烈推荐';
  if (score >= 70) return '推荐';
  if (score >= 50) return '可尝试';
  return '不推荐';
}

function stripCodeFence(content) {
  const text = trimString(content, 2_000_000);
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1] : text;
}

function parseAssessmentContent(content, expectedIds) {
  let parsed;
  try {
    parsed = JSON.parse(stripCodeFence(content));
  } catch (_) {
    throw new AiApiError('DeepSeek 返回的 JSON 无法解析', { retryable: true });
  }
  const rawResults = Array.isArray(parsed) ? parsed : parsed?.results;
  if (!Array.isArray(rawResults)) throw new AiApiError('DeepSeek 返回中缺少 results 数组', { retryable: true });
  const expected = new Set(expectedIds.map(String));
  const seen = new Set();
  const results = [];
  for (const raw of rawResults) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const jobId = trimString(raw.jobId, 300);
    if (!expected.has(jobId) || seen.has(jobId)) continue;
    seen.add(jobId);
    const numericScore = Number(raw.score);
    if (!Number.isFinite(numericScore)) throw new AiApiError(`岗位 ${jobId} 缺少有效 score`, { retryable: true });
    const score = Math.max(0, Math.min(100, Math.round(numericScore)));
    const numericConfidence = Number(raw.confidence);
    const confidence = Number.isFinite(numericConfidence) ? Math.max(0, Math.min(1, numericConfidence)) : 0.5;
    const recommendation = RECOMMENDATIONS.has(raw.recommendation) ? raw.recommendation : inferredRecommendation(score);
    results.push({
      jobId,
      score,
      recommendation,
      matchedRoles: normalizeStringArray(raw.matchedRoles),
      reason: trimString(raw.reason, 600),
      risks: normalizeStringArray(raw.risks),
      confidence: Number(confidence.toFixed(3)),
    });
  }
  const missing = expectedIds.filter(id => !seen.has(String(id)));
  if (missing.length) throw new AiApiError(`DeepSeek 漏评 ${missing.length} 个岗位`, { retryable: true });
  return results;
}

function endpointFor(baseUrl) {
  let parsed;
  try { parsed = new URL(String(baseUrl || DEFAULT_AI_BASE_URL)); } catch (_) { throw new AiApiError('DeepSeek Base URL 无效', { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new AiApiError('DeepSeek Base URL 仅支持 http/https', { statusCode: 400 });
  return `${parsed.href.replace(/\/+$/, '')}/chat/completions`;
}

function upstreamError(status, message = '') {
  const detail = trimString(message, 300);
  if (status === 401) return new AiApiError('DeepSeek API Key 无效', { statusCode: 400, upstreamStatus: status });
  if (status === 402) return new AiApiError('DeepSeek 账户余额不足', { statusCode: 400, upstreamStatus: status });
  if (status === 429) return new AiApiError('DeepSeek 请求过于频繁，请稍后重试', { statusCode: 429, upstreamStatus: status, retryable: true });
  if ([500, 502, 503, 504].includes(status)) return new AiApiError('DeepSeek 服务暂时不可用', { statusCode: 502, upstreamStatus: status, retryable: true });
  return new AiApiError(`DeepSeek 请求失败（${status}）${detail ? `：${detail}` : ''}`, { upstreamStatus: status });
}

function promptJobs(jobs) {
  return jobs.map(job => ({
    jobId: String(job.id),
    company: trimString(job.company, 200),
    nature: trimString(job.nature, 100),
    industry: trimString(job.industry, 160),
    position: trimString(job.position, 500),
    location: trimString(job.location, 200),
    deadline: trimString(job.deadline, 50),
    exam: trimString(job.exam, 100),
    sourceHint: trimString(job.sourceNote, 400),
    ruleClassification: trimString(job.classification || job.source, 50),
    rulePriority: trimString(job.priority, 50),
    ruleMatchedDirection: trimString(job.matchDir, 300),
  }));
}

function buildMessages(jobs, profile) {
  const formatExample = {
    results: [{
      jobId: '原样返回输入 jobId',
      score: 82,
      recommendation: '推荐',
      matchedRoles: ['品牌传播'],
      reason: '一句话说明岗位与候选人经历、方向和地点的匹配关系',
      risks: ['可能需要作品集'],
      confidence: 0.86,
    }],
  };
  return [
    {
      role: 'system',
      content: [
        '你是严谨的校招岗位匹配评估器。只依据用户画像和输入岗位，不补造岗位职责或候选人经历。',
        '逐个岗位给出 0-100 整数分数；85+ 强烈推荐，70-84 推荐，50-69 可尝试，低于 50 不推荐。',
        '地点、方向、岗位性质、技术门槛都应进入判断。规则初筛结果仅供参考，你可以纠正它。',
        '必须返回一个合法 json 对象，不得输出 Markdown 或额外说明，并保持每个输入 jobId 恰好出现一次。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '候选人画像：',
        profile,
        '',
        `请评估以下 ${jobs.length} 个岗位。输出 json 格式示例：`,
        JSON.stringify(formatExample),
        '',
        '岗位数据：',
        JSON.stringify(promptJobs(jobs)),
      ].join('\n'),
    },
  ];
}

class DeepSeekClient {
  constructor({ fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 90_000, maxAttempts = 3 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('DeepSeekClient 需要 fetch');
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
    this.maxAttempts = Math.max(1, Math.min(5, Number(maxAttempts) || 3));
  }

  async assessJobs(jobs, settings) {
    if (!Array.isArray(jobs) || !jobs.length) return { results: [], usage: {} };
    if (jobs.length > 20) throw new AiApiError('单批 AI 评估最多 20 个岗位', { statusCode: 400 });
    const apiKey = trimString(settings?.apiKey, 20_000);
    if (!apiKey) throw new AiApiError('尚未配置 DeepSeek API Key', { statusCode: 409 });
    const model = trimString(settings?.model || DEFAULT_AI_MODEL, 160);
    const profile = trimString(settings?.profile || DEFAULT_AI_PROFILE, 20_000);
    const body = {
      model,
      messages: buildMessages(jobs, profile),
      response_format: { type: 'json_object' },
      thinking: { type: 'disabled' },
      temperature: 0.1,
      max_tokens: Math.max(1200, Math.min(8000, jobs.length * 420)),
    };
    let lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await this._post(endpointFor(settings?.baseUrl), apiKey, body);
        const content = response?.choices?.[0]?.message?.content;
        if (!trimString(content, 2_000_000)) throw new AiApiError('DeepSeek 返回空内容', { retryable: true });
        return {
          results: parseAssessmentContent(content, jobs.map(job => String(job.id))),
          usage: {
            inputTokens: Number(response?.usage?.prompt_tokens || 0),
            outputTokens: Number(response?.usage?.completion_tokens || 0),
            totalTokens: Number(response?.usage?.total_tokens || 0),
          },
          model: trimString(response?.model || model, 160),
        };
      } catch (error) {
        lastError = error instanceof AiApiError ? error : new AiApiError(`DeepSeek 网络请求失败：${trimString(error?.message || error, 300)}`, { retryable: true });
        if (!lastError.retryable || attempt >= this.maxAttempts) break;
        await this.sleep(300 * (2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  async testConnection(settings) {
    const startedAt = Date.now();
    const synthetic = {
      id: '__connection_test__', company: '连接测试', nature: '', industry: '', position: '品牌传播实习生',
      location: '上海', deadline: '', exam: '', sourceNote: '仅用于验证接口', classification: '符合条件', priority: '中', matchDir: '品牌传播',
    };
    const response = await this.assessJobs([synthetic], settings);
    return { model: response.model || settings.model, latencyMs: Date.now() - startedAt, usage: response.usage };
  }

  async _post(url, apiKey, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw upstreamError(response.status, payload?.error?.message || '');
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new AiApiError('DeepSeek 请求超时', { retryable: true });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  AiApiError,
  DeepSeekClient,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_PROFILE,
  PROMPT_VERSION,
  aiProfileHash,
  jobContentHash,
  parseAssessmentContent,
};
