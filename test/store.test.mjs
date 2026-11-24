import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, checkAudit } from '../warden/store.mjs';
import { toolEvidence } from '../warden/runner.mjs';
import { limits } from '../warden/policy.mjs';

function memory(t, now) {
  const store = new Store(':memory:', now);
  t.after(() => store.close());
  return store;
}

const create = (store, scenario = 'change', asset = 'payments-api') => store.create({ scenario, asset }, 'tester');
const approve = (store, run) => store.act(run.id, 'approve', run.digest, 'reviewer', 'approver');
function plan(store, scenario, asset) {
  const run = create(store, scenario, asset);
  assert(store.begin(run.id));
  store.finish(run.id, []);
  return store.read(run.id);
}

test('fixed schema rejects inherited names, arbitrary shell strings, and extra fields', (t) => {
  const store = memory(t);
  for (const input of [null, [], { scenario: 'incident', asset: 'constructor' }, { scenario: 'exec', asset: 'worker' },
    { scenario: 'incident', asset: 'worker', command: 'ignored' }, { scenario: 'incident', asset: ['worker'] }]) {
    assert.throws(() => store.create(input, 'tester'), { status: 400 });
  }
  assert.deepEqual(store.list(), []);
});

test('approval binds role, digest, and inventory version and blocks replay', (t) => {
  const store = memory(t);
  const run = plan(store);
  const stale = plan(store);
  assert.equal(run.status, 'awaiting_approval');
  assert.throws(() => store.act(run.id, 'approve', run.digest, 'operator', 'operator'), { status: 403 });
  assert.throws(() => store.act(run.id, 'approve', stale.digest, 'reviewer', 'approver'), { status: 409 });
  assert.deepEqual({ ...store.inventory('payments-api') }, { revision: 1, preset: 'standard' });
  assert.equal(approve(store, run).status, 'succeeded');
  assert.throws(() => approve(store, run), { status: 409 });
  assert.equal(approve(store, stale).status, 'failed');
  assert.deepEqual({ ...store.inventory('payments-api') }, { revision: 2, preset: 'capped' });
  assert.equal(store.act(run.id, 'rollback', run.digest, 'reviewer', 'approver').status, 'rolled_back');
  assert.deepEqual({ ...store.inventory('payments-api') }, { revision: 3, preset: 'standard' });
});

test('automatic rollback restores the preset and leaves trace of the failed check', (t) => {
  const store = memory(t);
  const run = approve(store, plan(store, 'failed-check', 'worker'));
  assert.equal(run.status, 'rolled_back');
  assert.deepEqual({ ...store.inventory('worker') }, { revision: 3, preset: 'standard' });
  assert.deepEqual(run.events.slice(-4).map(({ code }) => code), ['approval.accepted', 'change.applied', 'change.check_failed', 'change.auto_rollback']);
  assert.match(run.evidence.at(-1).detail, /3 个失败/);
});

test('no-op runs preserve the rollback window, while a newer real revision blocks stale approval', (t) => {
  const store = memory(t);
  const first = approve(store, plan(store));
  const second = plan(store);
  assert.equal(second.status, 'succeeded');
  assert.equal(second.digest, null);
  assert.equal(store.inventory('payments-api').revision, 2);
  assert.equal(store.act(first.id, 'rollback', first.digest, 'reviewer', 'approver').status, 'rolled_back');
  assert.equal(store.inventory('payments-api').revision, 3);
});

test('pending runs consume capacity and approvals expire at the boundary', (t) => {
  let time = 1;
  const store = memory(t, () => time);
  const run = plan(store);
  for (let i = 1; i < limits.concurrent; i++) plan(store);
  assert.throws(() => plan(store), { status: 429 });
  time += limits.approvalMs;
  assert.throws(() => approve(store, run), { status: 409 });
  assert.equal(store.read(run.id).status, 'failed');
  assert.equal(plan(store).status, 'awaiting_approval');
});

test('reject and cancel preserve inventory, late evidence cannot resurrect cancelled runs', (t) => {
  const store = memory(t);
  const run = plan(store);
  assert.equal(store.act(run.id, 'reject', run.digest, 'reviewer', 'approver').status, 'rejected');
  const incident = create(store, 'incident');
  assert(store.begin(incident.id));
  assert.equal(store.act(incident.id, 'cancel', null, 'operator', 'operator').status, 'cancelled');
  store.finish(incident.id, [{ source: 'late', detail: 'late' }]);
  assert.equal(store.read(incident.id).status, 'cancelled');
  assert.equal(store.inventory('payments-api').revision, 1);
});

test('configuration and audit transitions are atomic if audit persistence fails', (t) => {
  const store = memory(t);
  const run = plan(store);
  const before = checkAudit(store.db);
  store.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON events WHEN NEW.code = 'change.verified' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(() => approve(store, run), /test failure/);
  assert.equal(store.read(run.id).status, 'awaiting_approval');
  assert.equal(store.inventory('payments-api').revision, 1);
  assert.deepEqual(checkAudit(store.db), before);
});

test('audit detects edits and detects truncation against a saved head', (t) => {
  const store = memory(t);
  create(store);
  const checkpoint = checkAudit(store.db);
  create(store, 'incident');
  assert.equal(checkAudit(store.db, checkpoint).count, 2);
  store.db.exec("UPDATE events SET detail = 'edited' WHERE seq = 1");
  assert.throws(() => checkAudit(store.db), /sequence 1/);
  store.db.exec('DELETE FROM events');
  assert.throws(() => checkAudit(store.db, checkpoint), /checkpoint mismatch/);
});

test('completed and pending actionable runs survive the display limit', (t) => {
  const store = memory(t);
  const completed = approve(store, plan(store));
  const pending = plan(store, 'failed-check', 'worker');
  for (let i = 0; i <= limits.visibleRuns; i++) plan(store, 'incident');
  assert.equal(store.list().length, limits.visibleRuns + 2);
  assert.equal(store.list().find(({ id }) => id === completed.id).canRollback, true);
  assert.equal(store.list().find(({ id }) => id === pending.id).status, 'awaiting_approval');
});

test('audit cross-checks persisted evidence and inventory', (t) => {
  const store = memory(t);
  const { id } = plan(store);
  const original = store.read(id);
  store.db.prepare('UPDATE runs SET data = ? WHERE id = ?').run(JSON.stringify({ ...original, evidence: ['changed'] }), id);
  assert.throws(() => checkAudit(store.db), /Run data differs/);
  store.db.prepare('UPDATE runs SET data = ? WHERE id = ?').run(JSON.stringify(original), id);
  store.db.exec("UPDATE inventory SET revision = 999 WHERE asset = 'worker'");
  assert.throws(() => checkAudit(store.db), /Inventory differs/);
});

test('reopen keeps pending proposals, interrupts work in flight, and locks out a second instance', (t) => {
  const dir = mkdtempSync(join(process.env.WARDEN_TEST_TEMP_DIR ?? tmpdir(), 'warden-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'warden.sqlite');
  const first = new Store(path);
  let pending;
  let running;
  try {
    pending = plan(first);
    running = create(first, 'incident');
    first.begin(running.id);
    assert.throws(() => new Store(path), /locked|busy/i);
  } finally { first.close(); }
  const reopened = new Store(path);
  try {
    assert.equal(reopened.read(pending.id).status, 'awaiting_approval');
    assert.equal(reopened.read(running.id).status, 'interrupted');
    assert.ok(checkAudit(reopened.db).count >= 6);
  } finally { reopened.close(); }
});

test('the fixed worker reports evidence and abort rejects without leaving a worker behind', async () => {
  const evidence = await toolEvidence({ scenario: 'incident', asset: 'worker' }, new AbortController().signal);
  assert.match(evidence[0].detail, /238 ms/);
  const controller = new AbortController();
  const promise = toolEvidence({ scenario: 'incident', asset: 'worker' }, controller.signal);
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
});
