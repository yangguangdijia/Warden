import { createHmac, randomUUID } from 'node:crypto';

export const taskIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const upstreamIdPattern = /^[a-zA-Z0-9_.:-]{1,160}$/;
export const operations = ['inspect', 'propose_change', 'propose_failed_change'];

export function baseUrl(raw, name) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an HTTP(S) origin`);
  }
  return url.origin;
}

export class UpstreamError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
    this.retryable = status === 0 || status === 425 || status === 429 || status >= 500;
  }
}

async function boundedJson(response, maximum) {
  if (!response.body) throw new UpstreamError('Upstream returned an empty response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new UpstreamError('Upstream response exceeded byte limit');
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function jsonRequest(url, { token, body, key, expected, signal, fetchImpl = fetch, allowMissing = false }) {
  try {
    const timeout = AbortSignal.timeout(4500);
    const response = await fetchImpl(url, {
      redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== expected) {
      await response.body?.cancel().catch(() => {});
      if (allowMissing && response.status === 404) return null;
      throw new UpstreamError(`Upstream HTTP ${response.status}`, response.status);
    }
    return await boundedJson(response, 65_536);
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('Upstream unavailable or invalid response');
  }
}

export function encodeTask({ id, operation, expiresAt }, key) {
  const kind = 'warden.ops.v1';
  const signature = createHmac('sha256', key).update(JSON.stringify([kind, id, operation, expiresAt])).digest('hex');
  return JSON.stringify({ kind, taskId: id, operation, expiresAt, signature });
}

export function createOpenBot({ openBotUrl, openBotToken, organizationId, botId, bridgeToken, fetchImpl }) {
  const root = `${openBotUrl}/api/v2/organizations/${encodeURIComponent(organizationId)}/conversations`;
  const request = (url, options) => jsonRequest(url, { token: openBotToken, fetchImpl, ...options });
  return {
    async conversation(task, signal) {
      const result = await request(root, { expected: 201, key: `warden-conversation-${task.id}`, body: { botIds: [botId] }, signal });
      const id = result?.conversation?.id;
      if (typeof id !== 'string' || !upstreamIdPattern.test(id)) throw new UpstreamError('Unexpected OpenBot conversation response');
      return id;
    },
    async send(task, signal) {
      const result = await request(`${root}/${encodeURIComponent(task.conversationId)}/messages`, {
        expected: 202, key: `warden-message-${task.id}`, signal,
        body: { id: task.id, text: encodeTask(task, bridgeToken), botId },
      });
      if (typeof result?.queued !== 'boolean' ||
          (result.id !== undefined && (typeof result.id !== 'string' || !upstreamIdPattern.test(result.id)))) {
        throw new UpstreamError('Unexpected OpenBot message response');
      }
      return result.id ?? task.id;
    },
  };
}

export function newTask(operation, requestId, now) {
  return { id: requestId ?? randomUUID(), operation, createdAt: now, expiresAt: now + 5 * 60_000 };
}
