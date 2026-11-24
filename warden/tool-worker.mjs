import { parentPort, workerData } from 'node:worker_threads';

const telemetry = Object.freeze({
  'payments-api': { latency: 486, errorRate: '1.8%', samples: 400, note: '超时样本集中于上游调用，建议先核对重试放大。' },
  worker: { latency: 238, errorRate: '0.4%', samples: 280, note: '重试队列短时增长，建议先对比消费者延迟。' },
});

if (!parentPort || !Object.hasOwn(telemetry, workerData.asset) ||
    !['collect_metrics', 'read_retry_policy'].includes(workerData.tool)) {
  throw new Error('Unknown tool or asset');
}

if (workerData.tool === 'collect_metrics') {
  const metric = telemetry[workerData.asset];
  parentPort.postMessage([
    { source: 'metrics.fixture / 15 min', detail: `模拟样本 ${metric.samples} 条 · P95 ${metric.latency} ms · 错误率 ${metric.errorRate}` },
    { source: 'triage.rules / v1', detail: metric.note },
  ]);
} else {
  parentPort.postMessage([
    { source: 'retry-policy.fixture', detail: '目标策略将重试上限约束为 2 次。执行前保留原策略，执行后探测 20 个模拟请求。' },
  ]);
}
