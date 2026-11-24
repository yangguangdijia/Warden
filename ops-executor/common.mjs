import { timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Fault, hash, limits } from '../warden/policy.mjs';

export const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export const digestPattern = /^[0-9a-f]{64}$/;
const bearer = /^[A-Za-z0-9._~+/-]{1,256}={0,2}$/;
const projectDir = fileURLToPath(new URL('../', import.meta.url));

export function requireTokens(tokens) {
  for (const [name, value] of Object.entries(tokens)) {
    if (typeof value !== 'string' || !bearer.test(value)) throw new Error(`Invalid or missing ${name}`);
  }
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) throw new Error('OPS tokens must be distinct');
}

export function equalHex(left, right) {
  return typeof left === 'string' && digestPattern.test(left) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function authorize(token) {
  const expected = hash(token);
  return (req) => {
    const header = req.headersDistinct.authorization;
    const candidate = header?.length === 1 && /^Bearer (\S+)$/.exec(header[0]);
    if (!candidate || !equalHex(hash(candidate[1]), expected)) throw new Fault(401, 'Invalid bearer token');
  };
}

export function envPort(name, fallback) {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) throw new Error(`Invalid ${name}`);
  return Number(value);
}

export function endpoint(value, name) {
  const base = new URL(value);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error(`Invalid ${name}`);
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  return base;
}

export function openDatabase(dataDir, filename) {
  const directory = resolve(projectDir, dataDir ?? '.ops-data');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, filename);
  // The operating system releases this SQLite writer lock if the service exits abruptly.
  const lock = new DatabaseSync(`${path}.instance`, { timeout: 0 });
  let db;
  try {
    lock.exec('BEGIN IMMEDIATE');
    db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON');
    return { db, close() { try { db.close(); } finally { lock.close(); } } };
  } catch (error) {
    try { db?.close(); } finally { lock.close(); }
    throw error;
  }
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function send(res, status, data, type = 'application/json; charset=utf-8', headers = {}) {
  const content = type.startsWith('application/json') ? JSON.stringify(data) : data;
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': Buffer.byteLength(content), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...headers,
  });
  res.end(content);
}

function parseJson(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function readJson(req, maxBytes = 1024) {
  const types = req.headersDistinct['content-type'];
  if (types?.length !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(types[0])) {
    throw new Fault(415, 'Expected application/json');
  }
  if (Number(req.headers['content-length']) > maxBytes) throw new Fault(413, 'Request too large');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > maxBytes) throw new Fault(413, 'Request too large');
      chunks.push(chunk);
    }
    return parseJson(Buffer.concat(chunks, size));
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw new Fault(400, 'Invalid JSON');
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(limits.toolMs) });
  if (!response.body) throw new Error('Missing response body');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 32_768) throw new Error('Response too large');
    chunks.push(chunk);
  }
  return { status: response.status, data: parseJson(Buffer.concat(chunks, size)) };
}

export async function listen({ host, port }, handle) {
  const active = new Set();
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 8000,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 2000 }, (req, res) => {
    const work = Promise.resolve().then(() => handle(req, res)).catch((error) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      const status = error instanceof Fault ? error.status : 500;
      const headers = req.complete ? {} : { Connection: 'close' };
      if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
      send(res, status, { error: error instanceof Fault ? error.message : 'Request could not be completed' }, undefined, headers);
    }).finally(() => active.delete(work));
    active.add(work);
  });
  server.on('checkContinue', (req, res) => send(res, 417, { error: 'Expect is unsupported' }, undefined, { Connection: 'close' }));
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.setTimeout(10_000, (socket) => socket.destroy());
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen({ host, port }, done);
  });
  const address = server.address();
  const hostname = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  let closing;
  return { origin: `http://${hostname}:${address.port}`, close() {
    closing ??= (async () => {
      const drain = setTimeout(() => server.closeAllConnections(), 2000);
      try {
        await new Promise((done) => server.close(done));
        await Promise.allSettled(active);
      } finally {
        clearTimeout(drain);
      }
    })();
    return closing;
  } };
}

export function runService(label, app) {
  console.log(`${label} listening at ${app.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    app.close().catch(() => { console.error(`Could not stop ${label}`); process.exitCode = 1; });
  });
}
