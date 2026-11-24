(() => {
  let token;
  let pendingCreate;
  const headers = () => token ? { Authorization: `Bearer ${token}` } : {};

  async function call(path, { data, credential, requestId } = {}) {
    const response = await fetch(path, {
      method: data === undefined ? 'GET' : 'POST',
      credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: {
        ...headers(),
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(requestId ? { 'Idempotency-Key': requestId } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || '请求失败。');
      error.status = response.status;
      throw error;
    }
    return result;
  }

  window.warden = Object.freeze({
    async connect(value) {
      const credential = value.trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('请粘贴服务启动时显示的访问令牌。');
      const session = await call('/api/session', { credential });
      token = credential;
      return session;
    },
    disconnect() { token = undefined; },
    session: () => call('/api/session'),
    list: () => call('/api/runs'),
    async create(data) {
      const identity = JSON.stringify([data.scenario, data.asset]);
      const request = pendingCreate?.identity === identity ? pendingCreate : { identity, id: crypto.randomUUID() };
      pendingCreate = request;
      try {
        const run = await call('/api/runs', { data, requestId: request.id });
        if (pendingCreate === request) pendingCreate = undefined;
        return run;
      } catch (err) {
        if (pendingCreate === request && err.status >= 400 && err.status < 500) pendingCreate = undefined;
        throw err;
      }
    },
    act(id, action, digest) {
      return call(`/api/runs/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { data: { digest: digest ?? null } });
    },
  });
})();
