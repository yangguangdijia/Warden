import { createServer, request } from 'node:http';

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const reviewPath = new RegExp(`^/review(?:\\?taskId=${uuid})?$`, 'i');
const approvalsPath = new RegExp(`^/approvals/${uuid}$`, 'i');
const routes = {
  mcp: { port: 4310, upstream: 'ops-bridge', upstreamPort: 4310, methods: (path) => path === '/mcp' && 'POST' },
  agent: { port: 4320, upstream: 'ops-executor', upstreamPort: 4320, methods: (path) => path === '/agent' && 'POST' },
  review: {
    port: 8080, upstream: 'ops-executor', upstreamPort: 4320,
    methods: (path) => reviewPath.test(path) ? 'GET' : approvalsPath.test(path) && 'GET, POST',
  },
};
const mode = process.argv[2];
const route = routes[mode];
if (!route) throw new Error('Unknown gateway mode');

const requestHeaders = ['accept', 'authorization', 'content-length', 'content-type', 'mcp-protocol-version', 'origin'];
const responseHeaders = ['cache-control', 'content-length', 'content-security-policy', 'content-type', 'referrer-policy',
  'retry-after', 'www-authenticate', 'x-accel-buffering', 'x-content-type-options', 'x-frame-options'];
const maxBytes = 1024 * 1024;
const select = (headers, names) => Object.fromEntries(names.filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]]));
function stop(response, status, headers = {}) {
  response.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  response.end();
}

const server = createServer({ requestTimeout: 15_000, headersTimeout: 5_000, keepAliveTimeout: 5_000 }, (incoming, outgoing) => {
  const allowed = route.methods(incoming.url);
  if (!allowed) return stop(outgoing, 404);
  if (!allowed.split(', ').includes(incoming.method)) return stop(outgoing, 405, { Allow: allowed });
  if (mode === 'review' && !['127.0.0.1:4320', '127.0.0.1:8080'].includes(incoming.headers.host)) return stop(outgoing, 403);
  if (mode === 'review' && incoming.headers.origin && incoming.headers.origin !== 'http://127.0.0.1:4320') return stop(outgoing, 403);
  if (['authorization', 'content-type', 'origin'].some((name) => incoming.headersDistinct[name]?.length > 1)) return stop(outgoing, 400);
  if (Number(incoming.headers['content-length']) > maxBytes) return stop(outgoing, 413);

  const upstream = request({
    hostname: route.upstream, port: route.upstreamPort, method: incoming.method, path: incoming.url,
    headers: select(incoming.headers, requestHeaders), timeout: 120_000,
  }, (response) => {
    outgoing.writeHead(response.statusCode, select(response.headers, responseHeaders));
    outgoing.flushHeaders();
    response.on('error', () => outgoing.destroy());
    response.pipe(outgoing);
  });
  upstream.on('error', () => {
    if (!outgoing.headersSent) stop(outgoing, 502);
    else outgoing.destroy();
  });
  upstream.on('timeout', () => upstream.destroy());
  outgoing.on('close', () => upstream.destroy());
  incoming.on('error', () => upstream.destroy());
  let bytes = 0;
  incoming.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      if (!outgoing.headersSent) stop(outgoing, 413);
      upstream.destroy();
    }
  });
  incoming.pipe(upstream);
});
server.listen(route.port, process.env.OPS_GATEWAY_HOST ?? '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
