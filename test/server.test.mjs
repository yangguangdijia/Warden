import assert from 'node:assert/strict';
import { get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { newTokens, startServer } from '../warden/server.mjs';

async function server(t, options) {
  const app = await startServer({ dbPath: ':memory:', ...options });
  t.after(app.close);
  return app;
}

function call(app, path, { data, role = 'operator', overrides } = {}) {
  return fetch(app.origin + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(role ? { Authorization: `Bearer ${app.tokens[role]}` } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json', Origin: app.origin }), ...overrides },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(5000),
  });
}

async function getStatus(app, id, wanted) {
  for (let i = 0; i < 100; i++) {
    const response = await call(app, `/api/runs/${id}`);
    assert.equal(response.status, 200);
    const run = await response.json();
    if (run.status === wanted) return run;
    await delay(20);
  }
  assert.fail(`Run never reached ${wanted}`);
}

const input = { scenario: 'change', asset: 'payments-api' };

test('the workbench loads with a restrictive CSP and serves a same-origin adapter', async (t) => {
  const app = await server(t);
  const response = await call(app, '/', { role: null });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'; script-src 'self' 'sha256-/);
  assert.match(response.headers.get('content-security-policy'), /style-src 'sha256-/);
  assert.match(await response.text(), /<script src="\/client\.js"><\/script>/);
  const client = await call(app, '/client.js', { role: null });
  assert.equal(client.status, 200);
  assert.match(await client.text(), /window\.warden/);
});

test('API requires identity, exact origin for writes and valid bounded requests', async (t) => {
  const app = await server(t);
  assert.equal((await call(app, '/api/runs', { role: null })).status, 401);
  assert.equal((await call(app, '/api/runs', { overrides: { Origin: 'http://localhost:4300' } })).status, 403);
  assert.equal((await call(app, '/api/runs', { data: input, overrides: { Origin: '' } })).status, 403);
  assert.equal((await call(app, '/api/runs', { data: input, role: 'approver' })).status, 403);
  assert.equal((await call(app, '/api/runs', { data: input, overrides: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call(app, '/api/runs', { data: { ...input, pad: 'a'.repeat(600) } })).status, 413);
  assert.equal((await call(app, '/api/runs', { data: { ...input, pad: 'a' } })).status, 400);
  const wrongHost = await new Promise((resolve, reject) => {
    get(`${app.origin}/api/runs`, { headers: { Host: 'localhost:4300' } }, (result) => {
      result.resume();
      resolve(result.statusCode);
    }).on('error', reject);
  });
  assert.equal(wrongHost, 421);
  assert.equal((await call(app, '/api/session', { overrides: { Authorization: `Bearer ${newTokens().operator}` } })).status, 401);
  assert.deepEqual(await (await call(app, '/api/runs')).json(), []);
});

test('HTTP run executes only after right-role approval and supports audited rollback', async (t) => {
  const app = await server(t);
  const response = await call(app, '/api/runs', { data: input });
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const pending = await getStatus(app, id, 'awaiting_approval');
  const path = `/api/runs/${id}`;
  assert.match(pending.digest, /^[a-f0-9]{64}$/);
  assert.equal((await call(app, `${path}/approve`, { data: { digest: pending.digest } })).status, 403);
  assert.equal((await call(app, `${path}/approve`, { data: { digest: '0'.repeat(64) }, role: 'approver' })).status, 409);
  const action = { data: { digest: pending.digest }, role: 'approver' };
  const [x, y] = await Promise.all([call(app, `${path}/approve`, action), call(app, `${path}/approve`, action)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  assert.equal((await (await call(app, path)).json()).status, 'succeeded');
  const rollback = await call(app, `${path}/rollback`, action);
  assert.equal(rollback.status, 200);
  assert.equal((await rollback.json()).status, 'rolled_back');
  assert.equal((await (await call(app, '/api/audit')).json()).count, 7);
});

test('repeat creation with the same request key returns one run and guards against changed input', async (t) => {
  const app = await server(t);
  const overrides = { 'Idempotency-Key': 'c9a4b7b0-644a-4eea-b0e8-b571abc98cf7' };
  const [first, second] = await Promise.all([call(app, '/api/runs', { data: input, overrides }), call(app, '/api/runs', { data: input, overrides })]);
  assert.equal((await first.json()).id, overrides['Idempotency-Key']);
  assert.equal((await second.json()).id, overrides['Idempotency-Key']);
  assert.equal((await (await call(app, '/api/runs')).json()).length, 1);
  assert.equal((await call(app, '/api/runs', { data: { ...input, asset: 'worker' }, overrides })).status, 409);
});

test('a persistence failure pauses writes and aborts other jobs', async (t) => {
  let fail;
  let othersAborted = 0;
  const collect = (run, signal) => new Promise((resolve, reject) => {
    if (run.asset === 'payments-api') fail = resolve;
    else signal.addEventListener('abort', () => { othersAborted++; reject(signal.reason); }, { once: true });
  });
  const app = await server(t, { collect, log() {} });
  const payments = await (await call(app, '/api/runs', { data: { scenario: 'incident', asset: 'payments-api' } })).json();
  const worker = await (await call(app, '/api/runs', { data: { scenario: 'incident', asset: 'worker' } })).json();
  await getStatus(app, worker.id, 'running');
  await getStatus(app, payments.id, 'running');
  const cyclic = [];
  cyclic.push(cyclic);
  const auditBefore = await (await call(app, '/api/audit')).json();
  fail(cyclic);
  await delay(0);
  assert.equal(othersAborted, 1);
  assert.equal((await call(app, '/api/runs', { data: input })).status, 503);
  assert.deepEqual(await (await call(app, '/api/audit')).json(), auditBefore);
});

test('cancellation reaches the worker and shutdown clears pending worker resources', async (t) => {
  let cancelled = 0;
  const collect = (_run, signal) => new Promise((resolve, reject) => {
    const aborted = () => { cancelled++; reject(signal.reason); };
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
  const app = await server(t, { collect });
  const data = { scenario: 'incident', asset: 'worker' };
  const { id } = await (await call(app, '/api/runs', { data })).json();
  await getStatus(app, id, 'running');
  const response = await call(app, `/api/runs/${id}/cancel`, { data: { digest: null } });
  assert.equal((await response.json()).status, 'cancelled');
  const next = await (await call(app, '/api/runs', { data })).json();
  await getStatus(app, next.id, 'running');
  await app.close();
  assert.equal(cancelled, 2);
});
