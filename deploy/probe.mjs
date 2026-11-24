function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function coreNetworkProbe() {
  const expect = async (url, status, options) => {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(3000), ...options });
    if (res.status !== status) throw new Error(`${new URL(url).pathname} expected ${status}, got ${res.status}`);
    return res;
  };
  const executor = 'http://127.0.0.1:4320';
  const lab = 'http://ops-lab:4321';
  const id = '00000000-0000-4000-8000-000000000000';
  const expectAndDrain = async (...args) => (await expect(...args)).body?.cancel();
  await expectAndDrain(`${executor}/healthz`, 200);
  await expectAndDrain(`${executor}/internal/tasks/${id}`, 401);
  await expectAndDrain(`${executor}/approvals/${id}`, 401);
  await expectAndDrain(`${lab}/config`, 401);
  for (const [selector, valid] of [
    ['up{job="ops-lab"}', Number.isInteger], ['ops_lab_config_healthy{job="ops-lab"}', (n) => [0, 1].includes(n)],
    ['ops_lab_config_version{job="ops-lab"}', (n) => Number.isInteger(n) && n >= 1],
  ]) {
    const url = `http://prometheus:9090/api/v1/query?query=${encodeURIComponent(selector)}`;
    let sample;
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await (await expect(url, 200)).json();
      sample = result.data?.result?.[0];
      if (sample?.metric?.job === 'ops-lab' && valid(Number(sample.value?.[1])) && (!selector.startsWith('up{') || sample.value[1] === '1')) break;
      sample = null;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!sample) throw new Error(`No real Prometheus sample for ${selector}`);
    console.log(`${selector} → ${sample.value[1]}`);
  }
}

async function mcpNetworkProbe() {
  const { readFileSync } = await import('node:fs');
  const token = readFileSync(0, 'utf8');
  const { randomUUID } = await import('node:crypto');
  const url = 'http://172.30.231.2:4310/mcp';
  const abort = () => AbortSignal.timeout(12_000);
  const unauthenticated = await fetch(url, { method: 'POST', signal: abort() });
  if (unauthenticated.status !== 401) throw new Error(`MCP expected 401 for a request without credentials, got ${unauthenticated.status}`);
  await unauthenticated.body?.cancel();
  const other = await fetch(url.replace('/mcp', '/healthz'), { signal: abort() });
  if (other.status !== 404) throw new Error('MCP gateway allows a path other than /mcp');
  await other.body?.cancel();
  let sequence = 0;
  async function rpc(method, params) {
    const id = ++sequence;
    const res = await fetch(url, { method: 'POST', redirect: 'error', signal: abort(),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (res.status !== 200) throw new Error(`MCP ${method} returned HTTP ${res.status}`);
    const envelope = await res.json();
    if (envelope.error || envelope.id !== id) throw new Error(`MCP ${method} did not return a valid result`);
    return envelope.result;
  }
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deploy-probe', version: '1' } });
  if (!init?.protocolVersion || !init.capabilities?.tools) throw new Error('MCP initialize did not announce tools');
  const names = (await rpc('tools/list', {})).tools?.map((tool) => tool.name).sort();
  if (names?.join(',') !== 'ops_request,ops_status') throw new Error('Unexpected MCP tool surface');
  async function tool(name, args) {
    const result = await rpc('tools/call', { name, arguments: args });
    if (result.isError || result.content?.[0]?.type !== 'text') throw new Error(`MCP ${name} did not succeed`);
    return JSON.parse(result.content[0].text);
  }
  const requestId = randomUUID();
  const task = await tool('ops_request', { operation: 'inspect', requestId });
  if (task.taskId !== requestId) throw new Error('Unexpected task ID');
  console.log(`Submitted read-only inspection ${task.taskId}`);
  const deadline = Date.now() + 180_000;
  let result = task;
  while (Date.now() < deadline) {
    result = await tool('ops_status', { taskId: task.taskId });
    if (result.status === 'completed') {
      const { conversationId, messageId, runId } = result.openBot ?? {};
      if (!conversationId || !messageId || !runId) throw new Error('Completed inspection has no native OpenBot conversation, message or AG-UI run ID');
      const queries = result.evidence?.filter((entry) => entry.source === 'prometheus') ?? [];
      if (!['healthy', 'version'].every((name) => queries.some((entry) => entry.queryName === name && entry.result?.some((item) => item.metric?.job === 'ops-lab')))) {
        throw new Error('Completed inspection did not return lab Prometheus samples');
      }
      console.log(JSON.stringify({ taskId: task.taskId, status: result.status, openBot: { conversationId, messageId, runId },
        prometheus: queries.map(({ queryName, result: sample }) => ({ queryName, sample })) }, null, 2));
      return;
    }
    if (['dispatch_failed', 'expired', 'failed', 'result_unconfirmed'].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Inspection ${task.taskId} ended at ${result.status}: ${result.detail ?? 'check OpenBot and executor logs'}`);
}

export async function probeCore(compose) {
  const base = 'http://127.0.0.1:4320';
  const probe = (path) => fetch(base + path, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const review = await probe('/review');
  await review.body?.cancel();
  check(review.ok && review.headers.get('content-type')?.includes('text/html'), 'Loopback review at /review did not serve HTML.');
  const denied = await probe('/approvals/00000000-0000-4000-8000-000000000000');
  await denied.body?.cancel();
  check(denied.status === 401, `Loopback review expected 401 without approver credentials, got ${denied.status}.`);
  const hidden = await probe('/healthz');
  await hidden.body?.cancel();
  check(hidden.status === 404, 'Loopback review exposes executor paths beyond the approval interface.');
  compose(['exec', '-T', 'ops-executor', 'node', '--input-type=module', '-e', `await (${coreNetworkProbe.toString()})();`]);
  console.log('Loopback review, bearer boundaries and real Prometheus scrape verified.');
}

export async function probeIntegrated(compose, token) {
  await probeCore(compose);
  for (const [url, name] of [['http://127.0.0.1:3001/health', 'OpenBot'], ['http://127.0.0.1:3210/api/auth/get-session', 'LobeHub']]) {
    const result = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    await result.body?.cancel();
    check(result.ok, `${name} readiness returned HTTP ${result.status}.`);
  }
  compose(['exec', '-T', 'portal', '/bin/node', '--input-type=module', '-e', `await (${mcpNetworkProbe.toString()})();`], { input: token });
}
