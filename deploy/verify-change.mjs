import { spawnSync } from 'node:child_process';

async function verifyChange() {
  const { randomUUID, createHmac } = await import('node:crypto');
  const { default: assert } = await import('node:assert/strict');
  const executor = 'http://127.0.0.1:4320';
  const lab = 'http://ops-lab:4321';
  const token = (name) => {
    const value = process.env[name];
    assert.ok(value, `${name} is missing in executor`);
    return value;
  };
  async function request(url, credential, data) {
    return fetch(url, {
      signal: AbortSignal.timeout(10_000), redirect: 'error',
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  }
  const readConfig = async () => {
    const response = await request(`${lab}/config`, token('OPS_LAB_TOKEN'));
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await readConfig();
  const taskId = randomUUID();
  const kind = 'warden.ops.v1';
  const operation = 'propose_failed_change';
  const expiresAt = Date.now() + 60_000;
  const signature = createHmac('sha256', token('OPS_BRIDGE_TOKEN'))
    .update(JSON.stringify([kind, taskId, operation, expiresAt])).digest('hex');
  const reply = await request(`${executor}/agent`, token('OPS_AGENT_TOKEN'), {
    threadId: `local-acceptance-${taskId}`, runId: `local-acceptance-${taskId}`,
    messages: [{ id: taskId, role: 'user', content: JSON.stringify({ kind, taskId, operation, expiresAt, signature }) }],
    state: {}, tools: [], context: [], forwardedProps: {},
  });
  assert.equal(reply.status, 200);
  const events = (await reply.text()).trim().split('\n\n').map((part) => JSON.parse(part.slice(6)));
  assert.equal(events.at(-1).type, 'RUN_FINISHED');
  assert.deepEqual(await readConfig(), first);
  const path = `${executor}/approvals/${taskId}`;
  const denied = await request(path, token('OPS_AGENT_TOKEN'), { digest: '0'.repeat(64) });
  assert.equal(denied.status, 401);
  await denied.body?.cancel();
  const review = await request(path, token('OPS_APPROVER_TOKEN'));
  assert.equal(review.status, 200);
  const proposal = await review.json();
  assert.equal(proposal.status, 'awaiting_approval');
  assert.equal(proposal.plan.fromVersion, first.version);
  const applied = await request(path, token('OPS_APPROVER_TOKEN'), { digest: proposal.digest });
  assert.equal(applied.status, 200);
  const result = await applied.json();
  assert.equal(result.status, 'rolled_back');
  const observations = result.evidence.filter((item) => item.path === '/health').map((item) => item.httpStatus);
  assert.ok(observations.includes(503), 'Missing failed health observation');
  const final = await readConfig();
  assert.equal(final.preset, first.preset);
  assert.equal(final.version, first.version + 2);
  const selector = encodeURIComponent('ops_lab_config_version{job="ops-lab"}');
  const deadline = Date.now() + 30_000;
  let sample = null;
  while (Date.now() < deadline) {
    const response = await request(`http://prometheus:9090/api/v1/query?query=${selector}`);
    assert.equal(response.status, 200);
    sample = (await response.json()).data?.result?.[0];
    if (Number(sample?.value?.[1]) === final.version) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(Number(sample?.value?.[1]), final.version);
  console.log(JSON.stringify({ test: 'direct AG-UI and live rollback', taskId, status: result.status,
    previousVersion: first.version, restoredVersion: final.version, preset: final.preset, prometheusVersion: Number(sample.value[1]) }));
}

const result = spawnSync('docker', ['exec', '-i', 'ai-platform-portal-ops-executor-1', 'node', '--input-type=module'], {
  input: `await (${verifyChange.toString()})();`, encoding: 'utf8', timeout: 70_000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0 || result.error) {
  if (result.error) console.error(`Could not run cloud change verification: ${result.error.code}`);
  process.exitCode = 1;
}
