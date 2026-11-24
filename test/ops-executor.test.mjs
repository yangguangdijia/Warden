import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startLabService } from '../ops-executor/lab.mjs';
import { startExecutor } from '../ops-executor/main.mjs';

const tokens = { agent: `agent-${randomUUID()}`, bridge: `bridge-${randomUUID()}`,
  approver: `approver-${randomUUID()}`, lab: `lab-${randomUUID()}` };
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const post = (body, token) => ({ method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const queryNames = ['ops_lab_config_healthy', 'ops_lab_config_version'];
const expectedQueries = queryNames.map((name) => `${name}{job="ops-lab"}`);

async function scratch() {
  return mkdtemp(join(process.env.WARDEN_TEST_TEMP_DIR ?? (process.platform === 'win32' ? 'D:/zcode' : tmpdir()), 'ops-executor-'));
}

async function http(handler) {
  const server = createServer((req, res) => void handler(req, res).catch(() => res.destroy()));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => {
    server.close(done);
    server.closeAllConnections();
  }) };
}

async function prometheus(labUrl) {
  const requests = [];
  const server = await http(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams.get('query');
    requests.push(Object.fromEntries(url.searchParams));
    const index = expectedQueries.indexOf(query);
    if (url.pathname !== '/api/v1/query' || index < 0) return res.writeHead(404).end();
    // Query API double derives each vector from the lab's actual Prometheus exposition.
    const metrics = await (await fetch(`${labUrl}/metrics`)).text();
    const value = metrics.split('\n').find((line) => line.startsWith(`${queryNames[index]} `)).split(' ')[1];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{
      metric: { __name__: queryNames[index], job: 'ops-lab', instance: new URL(labUrl).host }, value: [Date.now() / 1000, value],
    }] } }));
  });
  return { ...server, requests };
}

async function fixture(t, extra = {}) {
  const dataDir = await scratch();
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    await rm(dataDir, { recursive: true, force: true });
  });
  function track(service) { closers.push(service.close); return service; }
  let lab = track(await startLabService({ dataDir, token: tokens.lab }));
  const prom = track(await prometheus(lab.origin));
  const options = { dataDir, tokens, prometheusUrl: prom.origin, labUrl: lab.origin, ...extra };
  return { dataDir, track, options, prom, get lab() { return lab; }, async restartLab() {
    const port = Number(new URL(lab.origin).port);
    await lab.close();
    lab = track(await startLabService({ dataDir, token: tokens.lab, port }));
  } };
}

function envelope(taskId, operation, expiresAt = Date.now() + 60_000, key = tokens.bridge) {
  const kind = 'warden.ops.v1';
  const signature = createHmac('sha256', key).update(JSON.stringify([kind, taskId, operation, expiresAt])).digest('hex');
  return { kind, taskId, operation, expiresAt, signature };
}

function message(params, role = 'user') {
  return { role, id: randomUUID(), content: typeof params === 'string' ? params : JSON.stringify(params) };
}

async function dispatch(executor, input, options = {}) {
  const { runId = randomUUID(), threadId = randomUUID(), messages = [message(input)], token = tokens.agent } = options;
  const response = await fetch(`${executor.origin}/agent`, post({ threadId, runId, messages, state: {}, tools: [], context: [], forwardedProps: {} }, token));
  if (!response.ok) return { response };
  assert.match(response.headers.get('Content-Type'), /^text\/event-stream/);
  const events = (await response.text()).trimEnd().split('\n\n').map((line) => {
    assert.match(line, /^data: /);
    return JSON.parse(line.slice(6));
  });
  assert.deepEqual(events[0], { type: 'RUN_STARTED', runId, threadId });
  return { events, runId, threadId, task: events.find((event) => event.type === 'STATE_SNAPSHOT')?.snapshot };
}

const detail = (executor, id, token = tokens.bridge) => fetch(`${executor.origin}/internal/tasks/${id}`, { headers: auth(token) });
const approval = (executor, id, digest, token = tokens.approver) => fetch(`${executor.origin}/approvals/${id}`, post({ digest }, token));
const readConfig = (lab) => fetch(`${lab.origin}/config`, { headers: auth(tokens.lab) }).then((result) => result.json());
const health = (lab) => fetch(`${lab.origin}/health`);

async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for durable task state');
    await delay(40);
  }
}

test('AG-UI inspects four bounded sources, stores proof, and rejects unsigned, expired or ambiguous messages', async (t) => {
  const f = await fixture(t);
  const executor = f.track(await startExecutor(f.options));
  const id = randomUUID();
  const signed = envelope(id, 'inspect');
  const result = await dispatch(executor, signed, { messages: [message('older user message'), message(signed), message('ignored assistant message', 'assistant')] });
  assert.deepEqual(result.events.map(({ type }) => type), [
    'RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'STATE_SNAPSHOT', 'RUN_FINISHED',
  ]);
  assert.deepEqual(result.events.at(-1), { type: 'RUN_FINISHED', runId: result.runId, threadId: result.threadId });
  const [start, content, end] = result.events.slice(1, 4);
  assert.equal(start.role, 'assistant');
  assert.equal(start.messageId, content.messageId);
  assert.equal(start.messageId, end.messageId);
  assert.match(content.delta, /healthy at version 1/);
  const evidence = await (await detail(executor, id)).json();
  assert.equal(evidence.id, id);
  assert.equal(evidence.status, 'completed');
  assert.equal(evidence.openBotRunId, result.runId);
  assert.equal(evidence.analysis, 'rule-based');
  assert.equal(evidence.plan, null);
  assert.equal(evidence.evidence.length, 4);
  assert.deepEqual(evidence.evidence.filter((item) => item.source === 'prometheus').map((item) => item.result[0].value[1]), ['1', '1']);
  assert.equal(evidence.evidence.find((item) => item.path === '/health').response.healthy, true);
  assert.deepEqual(f.prom.requests.map((item) => item.query).sort(), [...expectedQueries].sort());
  assert.equal((await detail(executor, id, tokens.agent)).status, 401);
  assert.equal((await detail(executor, randomUUID())).status, 404);
  assert.equal((await dispatch(executor, signed, { token: tokens.bridge })).response.status, 401);
  assert.equal((await fetch(`${executor.origin}/healthz`)).status, 200);
  for (const invalid of [
    (invalidId) => ({ ...envelope(invalidId, 'inspect'), target: 'test' }),
    (invalidId) => envelope(invalidId, 'inspect', Date.now() - 1000),
    (invalidId) => envelope(invalidId, 'inspect', Date.now() + 60_000, tokens.agent),
    (invalidId) => envelope(invalidId, 'set_config'),
    (invalidId) => ({ kind: signed.kind, taskId: invalidId, operation: 'inspect' }),
    (invalidId) => JSON.stringify(envelope(invalidId, 'inspect')).replace('{', '{"kind":"warden.ops.v1",'),
  ]) {
    const invalidId = randomUUID();
    const failed = await dispatch(executor, invalid(invalidId));
    assert.equal(failed.events.at(-1).type, 'RUN_ERROR');
    assert.equal((await detail(executor, invalidId)).status, 404);
  }
  const prior = envelope(randomUUID(), 'inspect');
  const invalidLatest = await dispatch(executor, prior, { messages: [message(prior), message('invalid latest user message')] });
  assert.equal(invalidLatest.events.at(-1).type, 'RUN_ERROR');
  assert.equal((await detail(executor, prior.taskId)).status, 404);
  const duplicate = await dispatch(executor, signed);
  assert.equal(duplicate.task.openBotRunId, result.runId);
  assert.equal(f.prom.requests.length, 2);
});

test('separate human approval commits one change via CAS and rejects stale or repeated approvals', async (t) => {
  const f = await fixture(t);
  const executor = f.track(await startExecutor(f.options));
  const { task } = await dispatch(executor, envelope(randomUUID(), 'propose_change'));
  const { task: stale } = await dispatch(executor, envelope(randomUUID(), 'propose_failed_change'));
  assert.equal(task.status, 'awaiting_approval');
  assert.equal(task.plan.fromVersion, 1);
  assert.equal(task.plan.fromPreset, 'baseline');
  assert.equal(task.plan.toPreset, 'capped');
  assert.equal((await readConfig(f.lab)).preset, 'baseline');
  assert.equal((await fetch(`${executor.origin}/approvals/${task.id}`, { headers: auth(tokens.bridge) })).status, 401);
  assert.equal((await approval(executor, task.id, task.digest, tokens.agent)).status, 401);
  assert.equal((await approval(executor, task.id, task.digest, tokens.bridge)).status, 401);
  assert.equal((await approval(executor, task.id, '0'.repeat(64))).status, 409);
  const approvals = await Promise.all([approval(executor, task.id, task.digest), approval(executor, task.id, task.digest)]);
  assert.deepEqual(approvals.map(({ status }) => status).sort(), [200, 409]);
  const applied = await approvals.find(({ status }) => status === 200).json();
  assert.equal(applied.status, 'succeeded');
  assert.equal(applied.evidence.find(({ phase }) => phase === 'post-write-health').response.healthy, true);
  assert.equal(applied.evidence.find(({ phase }) => phase === 'post-write-readback').response.version, 2);
  assert.equal(applied.events.filter(({ actor }) => actor === 'human-approver').length, 1);
  const staleReply = await approval(executor, stale.id, stale.digest);
  const failed = await staleReply.json();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'mutation.apply_conflict');
  assert.deepEqual(await readConfig(f.lab), { instanceId: task.plan.instanceId, preset: 'capped', version: 2, retryBudget: 2 });
  assert.equal((await approval(executor, task.id, task.digest)).status, 409);
  const audit = executor.audit();
  assert.match(audit.head, /^[a-f0-9]{64}$/);
  await executor.close();
  await f.restartLab();
  const reopened = f.track(await startExecutor(f.options));
  assert.deepEqual(reopened.audit(), audit);
  assert.equal((await readConfig(f.lab)).version, 2);
  assert.deepEqual(await (await detail(reopened, task.id)).json(), applied);
});

test('deliberately invalid preset returns failed health before automatic compensation and verified readback', async (t) => {
  const f = await fixture(t);
  const executor = f.track(await startExecutor(f.options));
  const { task } = await dispatch(executor, envelope(randomUUID(), 'propose_failed_change'));
  assert.equal(task.plan.toPreset, 'invalid');
  const reply = await approval(executor, task.id, task.digest);
  assert.equal(reply.status, 200);
  const result = await reply.json();
  assert.equal(result.status, 'rolled_back');
  const live = result.evidence.find(({ phase }) => phase === 'post-write-health');
  assert.equal(live.httpStatus, 503);
  assert.equal(live.response.healthy, false);
  assert.deepEqual([live.response.preset, live.response.version], ['invalid', 2]);
  assert.equal(result.evidence.find(({ phase }) => phase === 'compensated-health').httpStatus, 200);
  assert.equal(result.evidence.find(({ phase }) => phase === 'compensated-readback').response.preset, 'baseline');
  assert.equal((await readConfig(f.lab)).version, 3);
  assert.equal((await health(f.lab)).status, 200);
  assert.match(await (await fetch(`${f.lab.origin}/metrics`)).text(), /ops_lab_config_version 3\n/);
  assert.equal((await fetch(`${f.lab.origin}/config`)).status, 401);
});

test('expired review cannot write and startup detects a modified task snapshot', async (t) => {
  let tick = Date.now();
  const f = await fixture(t, { now: () => tick });
  const executor = f.track(await startExecutor(f.options));
  const { task } = await dispatch(executor, envelope(randomUUID(), 'propose_change'));
  tick = Date.parse(task.plan.expiresAt);
  assert.equal((await approval(executor, task.id, task.digest)).status, 409);
  assert.equal((await readConfig(f.lab)).version, 1);
  await executor.close();
  const db = new DatabaseSync(join(f.dataDir, 'executor.sqlite'));
  try {
    db.prepare("UPDATE tasks SET data = json_set(data, '$.digest', 'modified') WHERE id = ?").run(task.id);
  } finally { db.close(); }
  await assert.rejects(startExecutor(f.options), /differs from audited state/);
});

async function executorProcess(t, { dataDir, labUrl, prometheusUrl }) {
  const entry = fileURLToPath(new URL('../ops-executor/main.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, OPS_EXECUTOR_PORT: '0', OPS_BIND_HOST: '127.0.0.1', OPS_DATA_DIR: dataDir,
      OPS_LAB_URL: labUrl, OPS_PROMETHEUS_URL: prometheusUrl, OPS_AGENT_TOKEN: tokens.agent, OPS_BRIDGE_TOKEN: tokens.bridge,
      OPS_APPROVER_TOKEN: tokens.approver, OPS_LAB_TOKEN: tokens.lab },
    cwd: dataDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const crash = async () => {
    if (child.signalCode === null && child.exitCode === null) child.kill('SIGKILL');
    await exited;
  };
  t.after(crash);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const origin = await eventually(() => {
    if (child.exitCode !== null) throw new Error(`Executor process exited ${child.exitCode}: ${stderr}`);
    return /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1];
  });
  return { origin, crash };
}

for (const cut of ['apply', 'compensate']) {
  test(`recovers after abrupt executor exit following lab ${cut} commit before receipt delivery`, async (t) => {
    const f = await fixture(t);
    let block = true;
    let commit;
    const committed = new Promise((done) => { commit = done; });
    const proxy = f.track(await http(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await fetch(`${f.lab.origin}${req.url}`, {
        method: req.method, headers: { ...auth(tokens.lab), ...(body.length && { 'Content-Type': 'application/json' }) },
        ...(body.length && { body }),
      });
      const text = await response.text();
      if (block && response.ok && req.method === 'POST' && JSON.parse(body).phase === cut) {
        commit(JSON.parse(text));
        return;
      }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(text);
    }));
    const settings = { ...f.options, labUrl: proxy.origin };
    const process = await executorProcess(t, settings);
    const { task } = await dispatch(process, envelope(randomUUID(), 'propose_failed_change'));
    assert.equal(task.status, 'awaiting_approval');
    const awaiting = approval(process, task.id, task.digest).catch((error) => error);
    const atCut = await Promise.race([committed, awaiting.then(() => { throw new Error('Approval completed before the crash point'); }),
      delay(5000, null, { ref: false }).then(() => { throw new Error('Lab commit was not observed'); })]);
    assert.deepEqual([atCut.preset, atCut.version], cut === 'apply' ? ['invalid', 2] : ['baseline', 3]);
    await process.crash();
    await awaiting;
    block = false;
    await f.restartLab();
    const recovered = f.track(await startExecutor(settings));
    const result = await eventually(async () => {
      const status = await (await detail(recovered, task.id)).json();
      return status.status === 'rolled_back' && status;
    });
    assert.equal(result.evidence.filter(({ phase }) => phase === 'apply').length, 1);
    assert.equal(result.evidence.filter(({ phase }) => phase === 'compensate').length, 1);
    assert.equal(result.events.filter(({ code }) => code === 'approval.accepted').length, 1);
    assert.equal((await readConfig(f.lab)).version, 3);
    assert.equal((await health(f.lab)).status, 200);
  });
}
