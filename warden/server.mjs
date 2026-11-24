import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Store, checkAudit } from './store.mjs';
import { Fault, exactKeys, limits } from './policy.mjs';
import { toolEvidence } from './runner.mjs';

const tokenHash = (value) => createHash('sha256').update(value).digest();
const cspHash = (value) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const assetPath = new URL('../原型/Warden 运维工作台.html', import.meta.url);
const adapterPath = new URL('./browser-client.js', import.meta.url);
const marker = '<!-- WARDEN_ADAPTER -->';
const uuid = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const actionPath = new RegExp(`^/api/runs/(${uuid})/(approve|reject|rollback|cancel)$`);
const getPath = new RegExp(`^/api/runs/(${uuid})$`);
const uuidPattern = new RegExp(`^${uuid}$`);
const jsonLimit = 512;
const hardHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function browserAssets() {
  const prototype = readFileSync(assetPath, 'utf8').replace(/\r\n?/g, '\n');
  if (prototype.split(marker).length !== 2) throw new Error('Browser adapter marker missing or duplicated');
  const scripts = [...prototype.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((item) => cspHash(item[1]));
  const styles = [...prototype.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((item) => cspHash(item[1]));
  return {
    html: prototype.replace(marker, '<script src="/client.js"></script>'), adapter: readFileSync(adapterPath),
    csp: `default-src 'none'; script-src 'self' ${scripts.join(' ')}; style-src ${styles.join(' ')}; ` +
      `script-src-attr 'none'; style-src-attr 'none'; connect-src 'self'; img-src 'self' data:; ` +
      `base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  };
}

function send(res, code, body, type = 'application/json; charset=utf-8', headers = {}) {
  const content = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, { ...hardHeaders, ...headers, 'Content-Type': type, 'Content-Length': Buffer.byteLength(content) });
  res.end(content);
}

async function body(req) {
  if (req.headersDistinct['content-type']?.length !== 1 || req.headers['content-type'] !== 'application/json') {
    throw new Fault(415, '请求必须使用 application/json。');
  }
  const length = req.headers['content-length'];
  if (typeof length !== 'string' || !/^\d+$/.test(length)) throw new Fault(411, '请求需要提供长度。');
  if (Number(length) > jsonLimit) throw new Fault(413, '请求体超出上限。');
  const chunks = [];
  try {
    for await (const chunk of req) chunks.push(chunk);
  } catch {
    throw new Fault(400, '请求未完整送达。');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new Fault(400, 'JSON 请求体无效。');
  }
}

export function newTokens() {
  return { operator: randomBytes(32).toString('base64url'), approver: randomBytes(32).toString('base64url') };
}

export async function startServer({ dbPath, port = 0, tokens = newTokens(), now, collect = toolEvidence, log = console.error }) {
  if (typeof tokens.operator !== 'string' || typeof tokens.approver !== 'string' ||
      !tokenPattern.test(tokens.operator) || !tokenPattern.test(tokens.approver) || tokens.operator === tokens.approver) {
    throw new TypeError('Expected two distinct, 32-byte base64url access tokens');
  }
  const tokenHashes = { operator: tokenHash(tokens.operator), approver: tokenHash(tokens.approver) };
  const ui = browserAssets();
  const store = new Store(dbPath, now);
  const jobs = new Map();
  let origin;
  let stopping;
  let writePaused = false;

  function requireWritable() {
    if (stopping || writePaused) throw new Fault(503, '写入暂不可用，请检查服务状态。');
  }

  function pauseWrites(reason) {
    if (writePaused) return;
    writePaused = true;
    for (const { controller } of jobs.values()) controller.abort();
    log(`${reason} Mutations are paused until the service restarts.`);
  }

  function identify(req) {
    const match = req.headersDistinct.authorization?.length === 1 && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization);
    if (!match) throw new Fault(401, '请提供有效的访问令牌。');
    const candidate = tokenHash(match[1]);
    const operator = timingSafeEqual(candidate, tokenHashes.operator);
    const approver = timingSafeEqual(candidate, tokenHashes.approver);
    if (operator) return { actor: 'local-operator', role: 'operator' };
    if (approver) return { actor: 'local-approver', role: 'approver' };
    throw new Fault(401, '访问令牌无效。');
  }

  function startJob(id) {
    const controller = new AbortController();
    const task = new Promise((resolve) => setImmediate(resolve)).then(async () => {
      if (controller.signal.aborted || !store.begin(id)) return;
      let evidence;
      try { evidence = await collect(store.read(id), controller.signal); }
      catch { /* Tool failure is recorded without forwarding internal error text. */ }
      if (!controller.signal.aborted) store.finish(id, evidence);
    }).catch(() => pauseWrites('Job persistence failed.')).finally(() => jobs.delete(id));
    jobs.set(id, { controller, task });
  }

  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 8000,
    keepAliveTimeout: 2000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    try {
      if (stopping) throw new Fault(503, '服务正在停止。');
      if (req.headersDistinct.host?.length !== 1 || req.headers.host !== new URL(origin).host) {
        throw new Fault(421, '主机地址不匹配，请使用服务启动时显示的本地地址。');
      }
      if (req.headersDistinct.origin && (req.headersDistinct.origin.length !== 1 || req.headers.origin !== origin)) {
        throw new Fault(403, '来源不匹配。');
      }
      const method = req.method;
      const path = req.url;
      if (method === 'GET' && path === '/') {
        return send(res, 200, ui.html, 'text/html; charset=utf-8', { 'Content-Security-Policy': ui.csp });
      }
      if (method === 'GET' && path === '/client.js') return send(res, 200, ui.adapter, 'application/javascript; charset=utf-8');
      if (!path.startsWith('/api/')) throw new Fault(404, '地址不存在。');
      const actor = identify(req);
      if (method === 'GET') {
        if (path === '/api/session') return send(res, 200, actor);
        if (path === '/api/runs') return send(res, 200, store.list(!writePaused));
        if (path === '/api/audit') return send(res, 200, checkAudit(store.db));
        const match = getPath.exec(path);
        if (match) return send(res, 200, store.detail(match[1], !writePaused));
      }
      if (method === 'POST') {
        requireWritable();
        if (req.headers.origin !== origin) throw new Fault(403, '修改请求需要同源标识。');
        if (path === '/api/runs') {
          if (actor.role !== 'operator') throw new Fault(403, '只有操作员可以启动任务。');
          const requestId = req.headers['idempotency-key'];
          if (requestId !== undefined && (req.headersDistinct['idempotency-key'].length !== 1 || !uuidPattern.test(requestId))) {
            throw new Fault(400, '请求编号必须是 UUID。');
          }
          const input = await body(req);
          requireWritable();
          const run = store.create(input, actor.actor, requestId, jobs.size >= limits.concurrent);
          if (run.status === 'queued' && !jobs.has(run.id)) startJob(run.id);
          return send(res, 201, run);
        }
        const match = actionPath.exec(path);
        if (match) {
          const [ , id, action ] = match;
          const params = await body(req);
          requireWritable();
          if (!exactKeys(params, ['digest'])) throw new Fault(400, '请求必须包含变更摘要。');
          const run = store.act(id, action, params.digest, actor.actor, actor.role);
          if (action === 'cancel') jobs.get(id)?.controller.abort();
          return send(res, 200, run);
        }
      }
      throw new Fault(404, '地址不存在。');
    } catch (err) {
      if (!(err instanceof Fault) && !res.destroyed) pauseWrites('Unexpected HTTP request failure.');
      if (!res.destroyed && !res.headersSent) {
        send(res, err instanceof Fault ? err.status : 500,
          { error: err instanceof Fault ? err.message : '服务无法完成请求。' }, undefined,
          req.complete ? {} : { Connection: 'close' });
      }
    }
  });
  server.on('checkContinue', (req, res) => send(res, 417, { error: '不接受 Expect 请求。' }, undefined, { Connection: 'close' }));
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(10_000, (socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port, host: '127.0.0.1' }, resolve);
    });
  } catch (err) {
    store.close();
    throw err;
  }
  origin = `http://127.0.0.1:${server.address().port}`;

  return { origin, tokens, close() {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      const drain = setTimeout(() => server.closeAllConnections(), 2000);
      for (const { controller } of jobs.values()) controller.abort();
      try {
        await Promise.all([closed, ...[...jobs.values()].map(({ task }) => task)]);
        if (!writePaused) store.interrupt();
      } finally {
        clearTimeout(drain);
        store.close();
      }
    });
    return stopping;
  } };
}
