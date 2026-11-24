import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { startBridge } from '../ops-bridge/server.mjs';
import { registerConnector } from '../ops-bridge/register-lobehub.mjs';

const credentials = { openBotToken: 'obk_local-test-openbot-key-only', mcpToken: 'm'.repeat(32), bridgeToken: 'b'.repeat(32) };
const options = { ...credentials, organizationId: 'ops', botId: 'ops-coworker', approvalUrl: 'http://127.0.0.1:4320/review' };
const base = '/api/v2/organizations/ops/conversations';
const sendJson = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };

async function stub(t, handler) {
  const errors = [];
  const server = createServer(async (req, res) => {
    try { await handler(req, res); }
    catch (err) { errors.push(err); if (!res.headersSent) sendJson(res, 500, {}); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    assert.deepEqual(errors, []);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function getJson(req) {
  const chunks = [];
  for await (const data of req) chunks.push(data);
  return JSON.parse(Buffer.concat(chunks));
}

async function rpc(bridge, method, params, token = credentials.mcpToken, headers) {
  return fetch(`http://127.0.0.1:${bridge.port}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function tool(bridge, name, args) {
  const response = await rpc(bridge, 'tools/call', { name, arguments: args });
  assert.equal(response.status, 200);
  const { result } = await response.json();
  return { isError: result.isError, ...JSON.parse(result.content[0].text) };
}

test('registers and syncs only the expected authenticated LobeHub connector', async () => {
  const route = 'http://127.0.0.1:3210/api/v1/mcp-servers';
  const connector = {
    id: 'connector-id', identifier: 'warden-openbot-ops', serverUrl: 'http://172.30.231.2:4310/mcp',
    isEnabled: true, hasCredentials: true, tools: [{ name: 'ops_request' }, { name: 'ops_status' }],
  };
  const apiKey = 'lobehub-unit-test-key';
  const calls = [];
  let exists = false;
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    calls.push(options.method + ' ' + url);
    if (url === route && options.method === 'GET') return Response.json({ data: exists ? [connector] : [] });
    if (url === route && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.credentials, { type: 'bearer', token: credentials.mcpToken });
      assert.equal(payload.serverUrl, connector.serverUrl);
      exists = true;
      return Response.json({ data: connector }, { status: 201 });
    }
    if (url === `${route}/${connector.id}/sync`) return Response.json({ data: { status: 'connected', toolCount: 2 } });
    assert.equal(url, `${route}/${connector.id}`);
    return Response.json({ data: connector });
  };
  const settings = { apiKey, mcpToken: credentials.mcpToken, fetchImpl };
  const first = await registerConnector(settings);
  assert.deepEqual(first.tools, ['ops_request', 'ops_status']);
  assert.deepEqual(await registerConnector(settings), first);
  assert.equal(calls.filter((call) => call === `POST ${route}`).length, 1);
  connector.isEnabled = false;
  await assert.rejects(registerConnector(settings), /Existing Warden connector/);
  assert.equal(calls.filter((call) => call === `POST ${route}/${connector.id}/sync`).length, 2);
});

test('stateless MCP exposes only typed request and status operations', async (t) => {
  const bridge = await startBridge({ ...options, dbPath: ':memory:', openBotUrl: 'http://127.0.0.1:1', executorUrl: 'http://127.0.0.1:1' });
  t.after(bridge.close);
  assert.equal((await rpc(bridge, 'initialize', {}, 'wrong')).status, 401);
  assert.equal((await rpc(bridge, 'initialize', {}, credentials.mcpToken, { Origin: 'https://other.example' })).status, 403);
  const initialized = await (await rpc(bridge, 'initialize', { protocolVersion: '2025-03-26' })).json();
  assert.equal(initialized.result.protocolVersion, '2025-03-26');
  assert.deepEqual((await (await rpc(bridge, 'tools/list', {})).json()).result.tools.map(({ name }) => name), ['ops_request', 'ops_status']);
  assert.equal((await tool(bridge, 'ops_request', { operation: 'inspect', target: 'external' })).isError, true);
  assert.equal((await tool(bridge, 'ops_request', { operation: 'approve' })).isError, true);
  assert.equal((await tool(bridge, 'ops_status', { taskId: randomUUID() })).isError, true);
});

test('submits signed OpenBot conversation messages and correlates run proof across restart', async (t) => {
  let conversations = 0;
  let messages = 0;
  let envelope;
  let reflectProof = false;
  const id = randomUUID();
  const runId = 'real-ag-ui-run-contract-fixture';
  const now = 1_800_000_000_000;
  const openBotUrl = await stub(t, async (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, `Bearer ${credentials.openBotToken}`);
    const json = await getJson(req);
    if (req.url === base) {
      conversations++;
      assert.equal(req.headers['idempotency-key'], `warden-conversation-${id}`);
      assert.deepEqual(json, { botIds: ['ops-coworker'] });
      return sendJson(res, 201, { conversation: { id: 'conversation-123' } });
    }
    assert.equal(req.url, `${base}/conversation-123/messages`);
    assert.equal(req.headers['idempotency-key'], `warden-message-${id}`);
    assert.equal(json.botId, 'ops-coworker');
    assert.equal(json.id, id);
    messages++;
    envelope = JSON.parse(json.text);
    const expiry = now + 300_000;
    const signature = createHmac('sha256', credentials.bridgeToken).update(JSON.stringify(['warden.ops.v1', id, 'propose_change', expiry])).digest('hex');
    assert.deepEqual(envelope, { kind: 'warden.ops.v1', taskId: id, operation: 'propose_change', expiresAt: expiry, signature });
    return sendJson(res, messages === 1 ? 502 : 202, { queued: true, id });
  });
  const executorUrl = await stub(t, (req, res) => {
    assert.equal(req.url, `/internal/tasks/${id}`);
    assert.equal(req.headers.authorization, `Bearer ${credentials.bridgeToken}`);
    if (!reflectProof) return sendJson(res, 404, {});
    return sendJson(res, 200, { id, operation: 'propose_change', status: 'awaiting_approval', openBotRunId: runId, evidence: { sample: 3 }, summary: 'proof', plan: { oldRevision: 1 } });
  });
  const dir = mkdtempSync(join(process.env.WARDEN_TEST_TEMP_DIR ?? tmpdir(), 'bridge-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = { ...options, dbPath: join(dir, 'bridge.sqlite'), openBotUrl, executorUrl, now: () => now };
  let bridge = await startBridge(settings);
  try {
    const first = await tool(bridge, 'ops_request', { operation: 'propose_change', requestId: id });
    assert.equal(first.status, 'dispatch_retryable');
    assert.equal(first.openBot.runId, null);
    assert.equal(first.approvalUrl, undefined);
  } finally { await bridge.close(); }
  bridge = await startBridge(settings);
  try {
    const retry = await tool(bridge, 'ops_status', { taskId: id });
    assert.equal(retry.status, 'submitted');
    assert.equal(retry.openBot.messageId, id);
    assert.equal(conversations, 1);
    assert.equal(messages, 2);
    assert.equal((await tool(bridge, 'ops_request', { operation: 'inspect', requestId: id })).isError, true);
    reflectProof = true;
    const proof = await tool(bridge, 'ops_status', { taskId: id });
    assert.deepEqual(proof.openBot, { conversationId: 'conversation-123', messageId: id, runId });
    assert.equal(proof.approvalUrl, `http://127.0.0.1:4320/review?taskId=${id}`);
    assert.deepEqual(proof.evidence, { sample: 3 });
  } finally { await bridge.close(); }
});
