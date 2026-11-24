import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Fault, exactKeys, hash, iso, limits } from '../warden/policy.mjs';
import { authorize, envPort, equalHex, listen, readJson, requireTokens, runService, send, uuid } from './common.mjs';
import { capped, invalid, target, validPreset } from './lab.mjs';
import { executorTools, matchesConfig } from './sources.mjs';
import { taskStore } from './store.mjs';

const kind = 'warden.ops.v1';
const operations = new Set(['inspect', 'propose_change', 'propose_failed_change']);
const reviewFile = new URL('../ops-bridge/review.html', import.meta.url);
const taskRoute = /^\/internal\/tasks\/([^/]+)$/;
const approvalRoute = /^\/approvals\/([^/]+)$/;
const rule = 'rule-based';
const retryMs = 1000;
const checksum = (task) => hash(JSON.stringify([task.id, task.operation, task.plan]));

function verifyEnvelope(messages, key, now) {
  if (!Array.isArray(messages)) throw new Fault(400, 'USER message is required');
  const text = messages.findLast((message) => message?.role === 'user')?.content;
  if (typeof text !== 'string' || text.length > 2048) throw new Fault(400, 'USER message must contain the signed JSON envelope');
  let value;
  try { value = JSON.parse(text); } catch { throw new Fault(400, 'USER message JSON is invalid'); }
  const fields = ['kind', 'taskId', 'operation', 'expiresAt', 'signature'];
  if (!exactKeys(value, fields) || value.kind !== kind || typeof value.taskId !== 'string' || !uuid.test(value.taskId) ||
      !operations.has(value.operation) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now()) {
    throw new Fault(400, 'Invalid or expired operations envelope');
  }
  // The validated document is a flat object. Count source keys to reject duplicates that JSON.parse collapses.
  const keys = [...text.matchAll(/"(?:[^"\\]|\\[\s\S])*"\s*(:)?/g)].filter((match) => match[1]);
  if (keys.length !== fields.length) throw new Fault(400, 'Duplicate envelope key');
  const expected = createHmac('sha256', key).update(JSON.stringify([kind, value.taskId, value.operation, value.expiresAt])).digest('hex');
  if (!equalHex(value.signature, expected)) throw new Fault(401, 'Invalid operations signature');
  return { id: value.taskId.toLowerCase(), operation: value.operation };
}

function validRunId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id);
}

function stream(res, run, reply) {
  const emit = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  emit('RUN_STARTED', run);
  return Promise.resolve().then(reply).then((task) => {
    if (res.destroyed) return;
    const messageId = randomUUID();
    emit('TEXT_MESSAGE_START', { messageId, role: 'assistant' });
    emit('TEXT_MESSAGE_CONTENT', { messageId, delta: task.summary });
    emit('TEXT_MESSAGE_END', { messageId });
    emit('STATE_SNAPSHOT', { snapshot: task });
    if (task.status === 'failed') emit('RUN_ERROR', { message: task.summary, code: task.error });
    else emit('RUN_FINISHED', run);
  }).catch((error) => {
    if (!res.destroyed) emit('RUN_ERROR', { message: error instanceof Fault ? error.message : 'Operations task could not be completed' });
  }).finally(() => res.end());
}

export async function startExecutor({
  dataDir = process.env.OPS_DATA_DIR, port = 0, host = process.env.OPS_BIND_HOST ?? '127.0.0.1',
  tokens = { agent: process.env.OPS_AGENT_TOKEN, bridge: process.env.OPS_BRIDGE_TOKEN,
    approver: process.env.OPS_APPROVER_TOKEN, lab: process.env.OPS_LAB_TOKEN },
  prometheusUrl = process.env.OPS_PROMETHEUS_URL ?? 'http://127.0.0.1:9090/',
  labUrl = process.env.OPS_LAB_URL ?? 'http://127.0.0.1:4321/',
  now = Date.now,
} = {}) {
  requireTokens({ OPS_AGENT_TOKEN: tokens.agent, OPS_BRIDGE_TOKEN: tokens.bridge,
    OPS_APPROVER_TOKEN: tokens.approver, OPS_LAB_TOKEN: tokens.lab });
  const tools = executorTools({ prometheusUrl, labUrl, labToken: tokens.lab });
  const store = taskStore(dataDir, now);
  const agentAuth = authorize(tokens.agent);
  const bridgeAuth = authorize(tokens.bridge);
  const approverAuth = authorize(tokens.approver);
  const jobs = new Map();
  let closing;

  const detail = (task) => ({ ...task, events: store.events(task.id) });
  const add = (task, evidence) => [...task.evidence, ...evidence.map((item) => ({ ...item, observedAt: iso(now()) }))];
  const fail = (task, error, summary) => store.save({ ...task, status: 'failed', error, summary }, error, summary);

  async function collect(task) {
    const samples = await tools.inspect();
    task = { ...task, evidence: add(task, samples) };
    const config = samples.find((item) => item.path === '/config')?.response;
    const health = samples.find((item) => item.path === '/health')?.response;
    const promAvailable = samples.filter((item) => item.source === 'prometheus').every((item) => item.result?.length);
    const metricNote = promAvailable ? '' : ' Some fixed Prometheus queries returned no usable samples.';
    const liveHealthy = config && health?.healthy === true && validPreset(config.preset) &&
      matchesConfig(health, config.instanceId, config.version, config.preset);
    if (task.operation === 'inspect') {
      if (samples.every((item) => item.error)) return fail(task, 'inspection.unavailable', 'The fixed evidence sources are unavailable.');
      const labNote = liveHealthy ? `Live lab config is healthy at version ${config.version} (${config.preset}).` :
        'Live lab config and health did not establish a healthy matching version.';
      const summary = `${labNote}${metricNote}`;
      return store.save({ ...task, status: 'completed', summary }, 'inspection.completed', summary);
    }
    if (!liveHealthy) return fail(task, 'proposal.unavailable', `A matching, healthy live lab configuration is required.${metricNote}`);
    const toPreset = task.operation === 'propose_failed_change' ? invalid : capped;
    if (toPreset === config.preset) {
      const summary = `The lab already runs the fixed ${capped} preset.${metricNote}`;
      return store.save({ ...task, status: 'completed', summary }, 'proposal.no_change', summary);
    }
    const plan = { policy: 'ops-lab-config/v1', asset: target, instanceId: config.instanceId, fromVersion: config.version,
      fromPreset: config.preset, toPreset, expiresAt: iso(now() + limits.approvalMs), verification: ['/health', '/config'],
      compensation: 'Restore the prior preset with version CAS if verification fails.', analysis: rule };
    const summary = `Fixed ${toPreset} configuration proposal awaits human approval.${metricNote}`;
    const proposal = { ...task, status: 'awaiting_approval', plan, summary };
    return store.save({ ...proposal, digest: checksum(proposal) }, 'proposal.created', summary);
  }

  async function reconcile(task) {
    const plan = task.plan;
    if (!plan || !equalHex(task.digest, checksum(task))) throw new Error('Stored approval checksum is invalid');
    const attempt = async (phase, expectedVersion, nextPreset) => {
      const input = { taskId: task.id, instanceId: plan.instanceId, phase, expectedVersion,
        ...(phase === 'apply' ? { preset: nextPreset } : {}) };
      try { return await tools.write(input, nextPreset); } catch (error) {
        if (error instanceof Fault && error.status === 409) {
          const summary = phase === 'apply' ? 'Lab CAS rejected the change. The proposal no longer matches live configuration.' :
            'Lab CAS rejected compensation. The applied version is no longer current.';
          return fail(task, `mutation.${phase}_conflict`, summary);
        }
        const summary = `The ${phase} result is unconfirmed. The executor will retry using the same lab mutation receipt key.`;
        return task.summary === summary ? task : store.save({ ...task, summary }, `mutation.${phase}_unconfirmed`, summary);
      }
    };
    const update = (phase, items, code, summary) => store.save({ ...task, phase, summary, evidence: add(task, items) }, code, summary);

    // Each write uses a durable task/phase receipt in the lab. Record the next phase before any subsequent write.
    if (task.phase === 'apply') {
      const result = await attempt('apply', plan.fromVersion, plan.toPreset);
      if (!result.response) return result;
      task = update('verify', [result], 'mutation.applied', 'Lab confirmed the applied configuration version.');
    }
    if (task.phase === 'verify') {
      const result = await tools.verify(plan.instanceId, plan.fromVersion + 1, plan.toPreset, 'post-write');
      if (result.healthy && plan.toPreset !== invalid) {
        const summary = 'Approved change passed post-write health and live configuration readback.';
        return store.save({ ...task, phase: null, status: 'succeeded', summary, evidence: add(task, result.evidence) }, 'mutation.verified', summary);
      }
      task = update('compensate', result.evidence, 'mutation.compensation_required',
        'Post-write checks failed. Restoring the prior configuration with version CAS.');
    }
    if (task.phase === 'compensate') {
      const result = await attempt('compensate', plan.fromVersion + 1, plan.fromPreset);
      if (!result.response) return result;
      task = update('verify_compensation', [result], 'mutation.compensated', 'Lab confirmed the compensating write. Verifying the restored configuration.');
    }
    if (task.phase === 'verify_compensation') {
      const result = await tools.verify(plan.instanceId, plan.fromVersion + 2, plan.fromPreset, 'compensated');
      if (!result.collected) {
        const summary = 'Compensation verification is pending while live health or config readback is unavailable.';
        return task.summary === summary ? task : update(task.phase, result.evidence, 'mutation.verification_unavailable', summary);
      }
      const evidence = add(task, result.evidence);
      if (!result.healthy) return fail({ ...task, evidence }, 'mutation.compensation_unverified', 'Live readback did not verify the restored configuration.');
      const summary = 'Automatic compensation restored the prior preset at a newer version. Health and live readback verified it.';
      return store.save({ ...task, phase: null, status: 'rolled_back', summary, evidence }, 'mutation.rollback_verified', summary);
    }
    throw new Error('Stored mutation phase is invalid');
  }

  function enqueue(task, run) {
    if (jobs.has(task.id)) return jobs.get(task.id);
    const work = Promise.resolve().then(() => run(task)).finally(() => jobs.delete(task.id));
    jobs.set(task.id, work);
    return work;
  }

  function recover() {
    if (closing) return;
    for (const task of store.byStatus('collecting')) {
      if (jobs.size >= limits.concurrent) break;
      void enqueue(task, collect).catch(() => console.error('Operations evidence persistence failed.'));
    }
    for (const task of store.byStatus('applying')) {
      void enqueue(task, reconcile).catch(() => console.error('Operations mutation persistence failed.'));
    }
  }

  async function agent(req, res) {
    agentAuth(req);
    const body = await readJson(req, 32_768);
    if (!validRunId(body?.runId) || !validRunId(body.threadId)) throw new Fault(400, 'AG-UI threadId and runId are required');
    return stream(res, { threadId: body.threadId, runId: body.runId }, async () => {
      const { id, operation } = verifyEnvelope(body.messages, tokens.bridge, now);
      let task = store.get(id);
      if (task && task.operation !== operation) throw new Fault(409, 'Task operation differs from the durable record');
      if (!task) {
        if (jobs.size >= limits.concurrent) throw new Fault(429, 'Executor is busy');
        task = store.save({ id, operation, openBotRunId: body.runId, status: 'collecting', createdAt: iso(now()),
          evidence: [], summary: 'Collecting fixed evidence.', plan: null, digest: null, phase: null, error: null, analysis: rule },
        'task.received', 'Signed AG-UI task accepted', 'openbot');
      }
      if (task.status === 'collecting') task = await enqueue(task, collect);
      return task;
    });
  }

  async function approval(req, res, id) {
    approverAuth(req);
    if (req.method === 'GET') {
      const task = store.get(id);
      if (!task || task.status === 'collecting') throw new Fault(404, 'Task is pending or absent');
      return send(res, 200, detail(task));
    }
    if (req.method !== 'POST') throw new Fault(405, 'Method not allowed');
    const body = await readJson(req);
    const task = store.get(id);
    if (!task || task.status === 'collecting') throw new Fault(404, 'Task is pending or absent');
    if (!exactKeys(body, ['digest']) || !task.plan || !equalHex(body.digest, checksum(task)) || task.digest !== body.digest) {
      throw new Fault(409, 'Approval checksum does not match the proposal');
    }
    if (task.status !== 'awaiting_approval') throw new Fault(409, 'Task is not awaiting approval');
    if (Date.parse(task.plan.expiresAt) <= now()) throw new Fault(409, 'Approval expired');
    if (store.byStatus('applying').length) throw new Fault(409, 'Another approved change is being reconciled');
    const summary = 'Human approval recorded. Applying the fixed change with version CAS.';
    const approved = store.save({ ...task, summary, status: 'applying', phase: 'apply' }, 'approval.accepted', summary, 'human-approver');
    const result = await enqueue(approved, reconcile);
    return send(res, result.status === 'applying' ? 202 : 200, detail(result));
  }

  let server;
  try {
    server = await listen({ host, port }, async (req, res) => {
      const path = req.url.split('?', 1)[0];
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true, service: 'ops-executor' });
      if (req.method === 'GET' && path === '/review') {
        let html;
        try { html = await readFile(reviewFile, 'utf8'); }
        catch { throw new Fault(404, 'Review UI is unavailable. Use the authenticated approvals API.'); }
        const nonce = randomBytes(18).toString('base64');
        const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
        return send(res, 200, html.replaceAll('__WARDEN_NONCE__', nonce), 'text/html; charset=utf-8', { 'Content-Security-Policy': csp });
      }
      const taskId = taskRoute.exec(req.url)?.[1];
      if (req.method === 'GET' && taskId && uuid.test(taskId)) {
        bridgeAuth(req);
        const task = store.get(taskId.toLowerCase());
        if (!task || task.status === 'collecting') throw new Fault(404, 'Task is pending or absent');
        return send(res, 200, detail(task));
      }
      const approvalId = approvalRoute.exec(req.url)?.[1];
      if (approvalId && uuid.test(approvalId)) return approval(req, res, approvalId.toLowerCase());
      if (req.method === 'POST' && req.url === '/agent') return agent(req, res);
      throw new Fault(404, 'Route not found');
    });
  } catch (error) {
    store.close();
    throw error;
  }
  recover();
  const timer = setInterval(recover, retryMs);
  timer.unref();
  return { origin: server.origin, audit: store.audit, close() {
    closing ??= (async () => {
      clearInterval(timer);
      await server.close();
      await Promise.allSettled(jobs.values());
      store.close();
    })();
    return closing;
  } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(process.umask() | 0o077);
  runService('Ops executor', await startExecutor({ port: envPort('OPS_EXECUTOR_PORT', 4320) }));
}
