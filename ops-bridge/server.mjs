import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { exactKeys } from '../warden/policy.mjs';
import { BridgeStore } from './store.mjs';
import { baseUrl, createOpenBot, jsonRequest, operations, taskIdPattern, UpstreamError } from './upstream.mjs';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const tools = [
  {
    name: 'ops_request',
    description: '让 OpenBot 巡检已登记的测试服务，或准备需要人工审批的重试策略变更。此工具无法批准或执行变更。轮询 ops_status 获取结果。网络请求重试时复用 requestId。',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: {
        operation: { type: 'string', enum: operations },
        requestId: { type: 'string', format: 'uuid', description: '可选请求编号，重试时复用。' },
      },
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'ops_status',
    description: '查询已提交任务的 OpenBot 运行编号、指标证据、审批链接和最终结果。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: { type: 'string', format: 'uuid' } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];
const notices = new Set(['notifications/initialized', 'notifications/cancelled']);
const maxBody = 16_384;
const digest = (value) => createHash('sha256').update(value).digest();
const validId = (value) => typeof value === 'string' && taskIdPattern.test(value);
const validProof = (proof, task) => proof && proof.id === task.id && proof.operation === task.operation &&
  typeof proof.openBotRunId === 'string' && proof.openBotRunId.length > 0 && proof.openBotRunId.length <= 256 &&
  ['completed', 'awaiting_approval', 'applying', 'succeeded', 'rolled_back', 'failed', 'rejected', 'recovery_required'].includes(proof.status);

function response(res, status, data, headers = {}) {
  const contents = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(contents),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers,
  });
  res.end(contents);
}

async function readBody(req) {
  const contentType = req.headers['content-type']?.split(';', 1)[0].trim();
  if (contentType !== 'application/json') throw Object.assign(new Error('Expected application/json'), { status: 415 });
  if (Number(req.headers['content-length']) > maxBody) throw Object.assign(new Error('Request too large'), { status: 413 });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBody) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

function toolResult(data, isError = false) {
  return { isError, content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export async function startBridge({
  dbPath, openBotUrl, openBotToken, organizationId, botId, mcpToken, bridgeToken, executorUrl, approvalUrl,
  host = '127.0.0.1', port = 0, now = Date.now, fetchImpl = fetch,
}) {
  for (const token of [openBotToken, mcpToken, bridgeToken]) {
    if (typeof token !== 'string' || token.length < 24 || token.length > 512 || /\s/.test(token)) throw new Error('A required bridge credential is missing or invalid');
  }
  if (new Set([openBotToken, mcpToken, bridgeToken]).size !== 3) throw new Error('Use distinct credentials for each service');
  for (const value of [organizationId, botId]) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(value)) throw new Error('OpenBot organization or Bot ID is invalid');
  }
  openBotUrl = baseUrl(openBotUrl, 'OPENBOT_BASE_URL');
  executorUrl = baseUrl(executorUrl, 'OPS_EXECUTOR_URL');
  const approval = new URL(approvalUrl);
  if (!['http:', 'https:'].includes(approval.protocol) || approval.username || approval.password || approval.hash || approval.search) throw new Error('Invalid OPS_APPROVAL_URL');
  if (approval.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(approval.hostname)) throw new Error('Nonlocal approval URL must use HTTPS');
  const expectedToken = digest(mcpToken);
  const store = new BridgeStore(dbPath, JSON.stringify([openBotUrl, organizationId, botId, bridgeToken]));
  const openBot = createOpenBot({ openBotUrl, openBotToken, organizationId, botId, bridgeToken, fetchImpl });
  const closing = new AbortController();
  const dispatches = new Map();

  function dispatch(id) {
    if (dispatches.has(id)) return dispatches.get(id);
    if (dispatches.size >= 4 || closing.signal.aborted) return Promise.resolve(store.get(id));
    const work = (async () => {
      let task = store.get(id);
      if (['submitted', 'dispatch_failed', 'expired'].includes(task.status)) return task;
      if (task.expiresAt <= now()) return store.error(id, '提交有效期已结束。', 'expired');
      try {
        if (!task.conversationId) task = store.saveConversation(id, await openBot.conversation(task, closing.signal));
        return store.accept(id, await openBot.send(task, closing.signal));
      } catch (error) {
        if (!(error instanceof UpstreamError)) throw error;
        const note = error.status ? `OpenBot 返回 HTTP ${error.status}。` : 'OpenBot 暂未确认提交。';
        return store.error(id, note, error.retryable ? 'dispatch_retryable' : 'dispatch_failed');
      }
    })().finally(() => dispatches.delete(id));
    dispatches.set(id, work);
    return work;
  }

  function describe(task, proof = null) {
    const link = new URL(approval);
    link.searchParams.set('taskId', task.id);
    return {
      taskId: task.id, operation: task.operation,
      status: proof?.status ?? (task.status === 'submitted' && task.expiresAt <= now() ? 'result_unconfirmed' : task.status),
      requestExpiresAt: new Date(task.expiresAt).toISOString(),
      openBot: { conversationId: task.conversationId, messageId: task.messageId, runId: proof?.openBotRunId ?? null },
      ...(proof ? { summary: proof.summary, evidence: proof.evidence, plan: proof.plan } : {}),
      ...(['awaiting_approval', 'applying', 'succeeded', 'rolled_back', 'failed', 'rejected', 'recovery_required'].includes(proof?.status) && task.operation !== 'inspect' ? { approvalUrl: link.href } : {}),
      ...(!proof && task.error ? { detail: task.error } : {}),
    };
  }

  async function callTool(name, args) {
    if (name === 'ops_request') {
      if ((!exactKeys(args, ['operation']) && !exactKeys(args, ['operation', 'requestId'])) ||
          !operations.includes(args.operation) || (Object.hasOwn(args, 'requestId') && !validId(args.requestId))) {
        return toolResult({ error: '仅接受已登记操作和可选 UUID 请求编号。' }, true);
      }
      let task;
      try { task = store.create(args.operation, args.requestId, now()); }
      catch (err) {
        if (!err.message.startsWith('此请求编号') && !err.message.startsWith('任务库已达到')) throw err;
        return toolResult({ error: err.message }, true);
      }
      return toolResult(describe(await dispatch(task.id)));
    }
    if (name !== 'ops_status') return toolResult({ error: '未知工具。' }, true);
    if (!exactKeys(args, ['taskId']) || !validId(args.taskId)) return toolResult({ error: '请输入合法的任务 UUID。' }, true);
    const task = store.get(args.taskId);
    if (!task) return toolResult({ error: '未找到任务。' }, true);
    let proof;
    try {
      proof = await jsonRequest(`${executorUrl}/internal/tasks/${task.id}`, {
        token: bridgeToken, expected: 200, signal: closing.signal, allowMissing: true, fetchImpl,
      });
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      return toolResult({ ...describe(task), evidenceState: 'unavailable', detail: '执行器暂不可用，请稍后查询。' });
    }
    if (proof !== null && !validProof(proof, task)) {
      return toolResult({ ...describe(task), evidenceState: 'unverified', detail: '执行器证据格式或任务编号校验失败。' });
    }
    return toolResult(describe(proof ? task : await dispatch(task.id), proof));
  }

  let inFlight = 0;
  const handlers = new Set();
  async function handle(req, res) {
    if (closing.signal.aborted) return response(res, 503, { error: 'Shutting down' }, { Connection: 'close' });
    if (req.method === 'GET' && req.url === '/healthz') return response(res, 200, { status: 'ok', openBotContract: 'v1.1.2' });
    if (req.url !== '/mcp') return response(res, 404, { error: 'Not found' });
    if (req.headers.origin !== undefined) return response(res, 403, { error: 'Browser origins are not permitted' });
    const authorization = req.headers.authorization;
    if (req.headersDistinct.authorization?.length !== 1 || !authorization?.startsWith('Bearer ') ||
        !timingSafeEqual(digest(authorization.slice(7)), expectedToken)) {
      return response(res, 401, { error: 'Authentication required' }, { 'WWW-Authenticate': 'Bearer', Connection: 'close' });
    }
    if (req.method !== 'POST') return response(res, 405, { error: 'Use POST' }, { Allow: 'POST' });
    if (inFlight >= 8) return response(res, 429, { error: 'Bridge is busy' }, { Connection: 'close', 'Retry-After': '2' });
    inFlight++;
    let id = null;
    const rpcError = (code, message) => response(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
    try {
      let message;
      try { message = await readBody(req); }
      catch (err) {
        if (err.status) return response(res, err.status, { error: err.message }, { Connection: 'close' });
        return rpcError(-32700, 'Invalid JSON');
      }
      if (closing.signal.aborted) return response(res, 503, { error: 'Shutting down' });
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(-32600, 'Invalid JSON-RPC request');
      if (!Object.hasOwn(message, 'id')) return notices.has(message.method) ? response(res, 202) : response(res, 400, { error: 'Unsupported notification' });
      if (typeof message.id !== 'string' && !Number.isSafeInteger(message.id)) return rpcError(-32600, 'Invalid request id');
      id = message.id;
      let result;
      switch (message.method) {
        case 'initialize': {
          const requested = message.params?.protocolVersion;
          result = { protocolVersion: versions.includes(requested) ? requested : versions[0],
            capabilities: { tools: {} }, serverInfo: { name: 'warden-openbot-ops', version: '1.0.0' } };
          break;
        }
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools }; break;
        case 'tools/call': result = await callTool(message.params?.name, message.params?.arguments); break;
        default: return rpcError(-32601, 'Method not found');
      }
      return response(res, 200, { jsonrpc: '2.0', id, result });
    } catch {
      if (!res.destroyed && !res.headersSent) return rpcError(-32603, 'Bridge error. Check the service and task state.');
    } finally { inFlight--; }
  }

  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 3000, requestTimeout: 6000, connectionsCheckingInterval: 1000 }, (req, res) => {
    const handler = handle(req, res).catch(() => { if (!res.destroyed) res.destroy(); }).finally(() => handlers.delete(handler));
    handlers.add(handler);
  });
  server.setTimeout(12_000, (socket) => socket.destroy());
  server.maxConnections = 24;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port }, resolve);
    });
  } catch (err) {
    store.close();
    throw err;
  }
  let closePromise;
  return { port: server.address().port, close() {
    if (closePromise) return closePromise;
    closing.abort();
    closePromise = (async () => {
      const drained = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await drained;
      await Promise.allSettled([...handlers, ...dispatches.values()]);
      store.close();
    })();
    return closePromise;
  } };
}
