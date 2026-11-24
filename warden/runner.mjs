import { Worker } from 'node:worker_threads';
import { limits } from './policy.mjs';

export async function toolEvidence(run, signal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./tool-worker.mjs', import.meta.url), {
    workerData: { asset: run.asset, tool: run.scenario === 'incident' ? 'collect_metrics' : 'read_retry_policy' },
    env: {}, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 2 },
  });
  let timer;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      timer = setTimeout(() => reject(new Error('Tool deadline exceeded')), limits.toolMs);
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('Tool worker exited without evidence')));
      worker.once('message', resolve);
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
