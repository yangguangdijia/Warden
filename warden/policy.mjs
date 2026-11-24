import { createHash, randomUUID } from 'node:crypto';

export const assets = Object.freeze({ 'payments-api': '支付 API', worker: '后台 Worker' });
export const scenarios = Object.freeze({ incident: '巡检与证据采集', change: '加固重试策略', 'failed-check': '故障注入与自动回滚' });
export const limits = Object.freeze({ concurrent: 4, toolMs: 2000, approvalMs: 600_000, runs: 500, visibleRuns: 50 });

export class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function newRun(input, now) {
  if (!exactKeys(input, ['scenario', 'asset']) || typeof input.asset !== 'string' ||
      typeof input.scenario !== 'string' || !Object.hasOwn(assets, input.asset) || !Object.hasOwn(scenarios, input.scenario)) {
    throw new Fault(400, '请选择受支持的场景和服务。');
  }
  const at = iso(now);
  return {
    id: randomUUID(), ...input, title: scenarios[input.scenario], status: 'queued',
    createdAt: at, updatedAt: at, digest: null, evidence: [], plan: null, appliedRevision: null,
  };
}

export function makePlan(run, asset, now) {
  const plan = {
    policy: 'retry-budget/v1', asset: run.asset, fromRevision: asset.revision, from: asset.preset,
    to: 'capped', expiresAt: iso(now + limits.approvalMs),
  };
  return { plan, digest: hash(JSON.stringify([run.id, run.scenario, plan])) };
}

export function verifyPlan(run, digest) {
  if (typeof digest !== 'string' || digest !== run.digest ||
      !run.plan || run.plan.asset !== run.asset || hash(JSON.stringify([run.id, run.scenario, run.plan])) !== digest) {
    throw new Fault(409, '变更计划已失效。请刷新任务后核对摘要。');
  }
}
