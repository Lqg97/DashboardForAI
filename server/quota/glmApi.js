// 兼容旧调用入口；实际请求、缓存与响应解析统一走 codingPlan 适配器。
import { fetchCodingPlanQuota } from './codingPlan.js';

export async function fetchGlmQuota(opts = {}) {
  return fetchCodingPlanQuota({
    id: opts.id || 'glm',
    quotaProvider: opts.quotaProvider || 'zhipu',
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl,
  }, opts.codingPlanOptions || {});
}
