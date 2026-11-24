import { DatabaseSync } from 'node:sqlite';
import { Fault, hash, iso, limits, makePlan, newRun, verifyPlan } from './policy.mjs';

const active = ['queued', 'running', 'awaiting_approval'];
const zero = '0'.repeat(64);
const initialInventory = [
  { asset: 'payments-api', revision: 1, preset: 'standard' },
  { asset: 'worker', revision: 1, preset: 'standard' },
];
const inventoryHash = (db) => hash(JSON.stringify(db.prepare('SELECT asset, revision, preset FROM inventory ORDER BY asset').all()));

function eventHash(previous, event) {
  return hash(JSON.stringify([previous, event.run_id, event.actor, event.at, event.code,
    event.title, event.detail, event.status, event.run_hash, event.inventory_hash]));
}

export function checkAudit(db, checkpoint) {
  const latestRun = new Map();
  let lastInventory = hash(JSON.stringify(initialInventory));
  let head = zero;
  let count = 0;
  let matched = checkpoint === undefined || (checkpoint.count === 0 && checkpoint.head === zero);
  for (const row of db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
    count += 1;
    if (row.seq !== count || row.previous !== head || row.hash !== eventHash(head, row)) {
      throw new Error(`Audit mismatch at sequence ${row.seq}`);
    }
    head = row.hash;
    if (count === checkpoint?.count) matched = head === checkpoint.head;
    lastInventory = row.inventory_hash;
    latestRun.set(row.run_id, { hash: row.run_hash, status: row.status });
  }
  if (!matched) throw new Error('Audit checkpoint mismatch');
  const storedRuns = db.prepare('SELECT id, status, data FROM runs').all();
  if (storedRuns.length !== latestRun.size || storedRuns.some(({ id, status, data }) => {
    const audited = latestRun.get(id);
    return audited?.status !== status || audited.hash !== hash(data);
  })) throw new Error('Run data differs from audited state');
  if (inventoryHash(db) !== lastInventory) throw new Error('Inventory differs from audited state');
  return { count, head };
}

export class Store {
  constructor(path, now = Date.now) {
    this.now = now;
    // Keep a separate SQLite writer lock for this process's lifetime. The OS releases it after a crash.
    this.lock = path === ':memory:' ? null : new DatabaseSync(`${path}.instance`, { timeout: 0 });
    try {
      this.lock?.exec('BEGIN IMMEDIATE');
      this.db = new DatabaseSync(path);
      this.db.exec(`
        PRAGMA foreign_keys = ON;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS inventory (
          asset TEXT PRIMARY KEY, revision INTEGER NOT NULL, preset TEXT NOT NULL
        ) STRICT;
        INSERT OR IGNORE INTO inventory VALUES ('payments-api', 1, 'standard'), ('worker', 1, 'standard');
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), actor TEXT NOT NULL,
          at TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
          status TEXT NOT NULL, run_hash TEXT NOT NULL, inventory_hash TEXT NOT NULL,
          previous TEXT NOT NULL, hash TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS events_run_seq ON events(run_id,seq);
      `);
      checkAudit(this.db);
      this.interrupt();
      this.transaction(() => this.expire());
    } catch (err) {
      this.close();
      throw err;
    }
  }

  close() {
    try { this.db?.close(); } finally { this.lock?.close(); }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  read(id) {
    const entry = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id);
    if (!entry) throw new Fault(404, '未找到任务。');
    return JSON.parse(entry.data);
  }

  readByStatus(statuses) {
    const placeholders = statuses.map(() => '?').join(',');
    return this.db.prepare(`SELECT data FROM runs WHERE status IN (${placeholders})`).all(...statuses)
      .map(({ data }) => JSON.parse(data));
  }

  canRollback(run) {
    return run.status === 'succeeded' && run.appliedRevision !== null &&
      run.appliedRevision === this.inventory(run.asset)?.revision;
  }

  publicRun(run) {
    const events = this.db.prepare('SELECT seq,code,title,detail,at,actor FROM events WHERE run_id = ? ORDER BY seq').all(run.id);
    return { ...run, canRollback: this.canRollback(run), events };
  }

  list(allowMaintenance = true) {
    if (allowMaintenance) this.transaction(() => this.expire());
    return this.db.prepare('SELECT data FROM runs ORDER BY rowid DESC').all()
      .map(({ data }) => JSON.parse(data))
      .filter((run, index) => index < limits.visibleRuns || active.includes(run.status) || this.canRollback(run))
      .map((run) => this.publicRun(run));
  }

  detail(id, allowMaintenance = true) {
    if (allowMaintenance) this.transaction(() => this.expire());
    return this.publicRun(this.read(id));
  }

  interrupt() {
    this.transaction(() => {
      for (const run of this.readByStatus(['queued', 'running'])) {
        this.transition(run, 'interrupted', 'run.interrupted', '运行已中断', '服务停止或重启，未完成的采集已标记为中断。');
      }
    });
  }

  transition(run, status, code, title, detail, actor = 'warden') {
    run.status = status;
    run.updatedAt = iso(this.now());
    const data = JSON.stringify(run);
    this.db.prepare('UPDATE runs SET status = ?, data = ? WHERE id = ?').run(status, data, run.id);
    const previous = this.db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get()?.hash ?? zero;
    const event = { run_id: run.id, actor, at: run.updatedAt, code, title, detail, status,
      run_hash: hash(data), inventory_hash: inventoryHash(this.db) };
    this.db.prepare('INSERT INTO events(run_id,actor,at,code,title,detail,status,run_hash,inventory_hash,previous,hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(run.id, actor, run.updatedAt, code, title, detail, status, event.run_hash, event.inventory_hash, previous, eventHash(previous, event));
  }

  expire() {
    for (const run of this.readByStatus(['awaiting_approval'])) {
      if (this.now() >= Date.parse(run.plan.expiresAt)) {
        this.transition(run, 'failed', 'approval.expired', '审批窗口已关闭', '审批有效期为 10 分钟，当前计划未执行。');
      }
    }
  }

  create(input, actor, requestId, waitingForWorker = false) {
    const run = newRun(input, this.now());
    if (requestId) run.id = requestId;
    return this.transaction(() => {
      if (requestId) {
        const existing = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(requestId);
        if (existing) {
          const stored = JSON.parse(existing.data);
          if (stored.scenario !== run.scenario || stored.asset !== run.asset) {
            throw new Fault(409, '此次请求与之前使用同一请求编号的任务不一致。');
          }
          return this.publicRun(stored);
        }
      }
      this.expire();
      if (waitingForWorker) throw new Fault(429, '工作线程正在清理，请稍后重试。');
      if (this.db.prepare('SELECT count(*) AS n FROM runs').get().n >= limits.runs) {
        throw new Fault(429, '试点已达到 500 条任务上限。');
      }
      if (this.readByStatus(active).length >= limits.concurrent) {
        throw new Fault(429, '最多同时处理 4 个任务（含待审批）。');
      }
      this.db.prepare('INSERT INTO runs VALUES (?,?,?)').run(run.id, run.status, JSON.stringify(run));
      this.transition(run, 'queued', 'run.requested', '任务已登记', '仅访问已登记的本地模拟服务与固定工具。', actor);
      return this.publicRun(run);
    });
  }

  begin(id) {
    return this.transaction(() => {
      const run = this.read(id);
      if (run.status !== 'queued') return false;
      this.transition(run, 'running', 'tool.started', '采集证据', '在短生命周期 Worker 中调用预定义工具。');
      return true;
    });
  }

  finish(id, evidence) {
    this.transaction(() => {
      const run = this.read(id);
      if (run.status !== 'running') return;
      if (!evidence) {
        this.transition(run, 'failed', 'tool.failed', '采集未完成', '工具未返回结果，当前任务已结束。');
        return;
      }
      run.evidence = evidence;
      if (run.scenario === 'incident') {
        this.transition(run, 'succeeded', 'tool.collected', '只读巡检完成', '已记录样本来源和排查线索。');
        return;
      }
      const asset = this.inventory(run.asset);
      if (asset.preset === 'capped') {
        run.evidence.push({ source: 'inventory.fixture', detail: '当前模拟重试上限已经为 2 次。' });
        this.transition(run, 'succeeded', 'change.not_needed', '已符合目标策略', '配置版本保持原样，无需审批或回滚。');
        return;
      }
      Object.assign(run, makePlan(run, asset, this.now()));
      this.transition(run, 'awaiting_approval', 'approval.requested', '等待审批', `绑定服务配置版本 r${asset.revision}。审批窗口为 10 分钟。`);
    });
  }

  inventory(asset) {
    return this.db.prepare('SELECT revision, preset FROM inventory WHERE asset = ?').get(asset);
  }

  updateInventory(asset, revision, preset) {
    const result = this.db.prepare('UPDATE inventory SET revision = revision + 1, preset = ? WHERE asset = ? AND revision = ?')
      .run(preset, asset, revision);
    if (result.changes !== 1) throw new Fault(409, '服务配置已改变。请重新发起任务。');
    return revision + 1;
  }

  act(id, action, digest, actor, role) {
    if (!['cancel', 'approve', 'reject', 'rollback'].includes(action)) throw new Fault(400, '不支持该操作。');
    if (role !== (action === 'cancel' ? 'operator' : 'approver')) throw new Fault(403, '当前角色无权执行该操作。');
    this.transaction(() => this.expire());
    return this.transaction(() => {
      const run = this.read(id);
      if (action === 'cancel') {
        if (digest !== null || !active.includes(run.status)) throw new Fault(409, '当前任务无法取消。');
        this.transition(run, 'cancelled', 'run.cancelled', '任务已取消', '任务停止，待完成采集会被清理。', actor);
        return this.publicRun(run);
      }
      verifyPlan(run, digest);
      if (action === 'rollback') {
        if (run.status !== 'succeeded' || run.appliedRevision === null) throw new Fault(409, '当前任务没有可回滚的变更。');
        const revision = this.updateInventory(run.asset, run.appliedRevision, run.plan.from);
        this.transition(run, 'rolled_back', 'change.rolled_back', '已恢复原策略', `模拟配置已恢复，当前版本 r${revision}。`, actor);
        return this.publicRun(run);
      }
      if (run.status !== 'awaiting_approval') throw new Fault(409, '当前任务没有待审批的变更。');
      if (action === 'reject') {
        this.transition(run, 'rejected', 'approval.rejected', '已拒绝变更', '模拟服务配置保持原状。', actor);
        return this.publicRun(run);
      }
      if (this.now() >= Date.parse(run.plan.expiresAt)) throw new Fault(409, '审批窗口已关闭。');
      const asset = this.inventory(run.asset);
      if (asset.revision !== run.plan.fromRevision || asset.preset !== run.plan.from) {
        this.transition(run, 'failed', 'change.stale', '配置版本发生变化', '当前计划失效，请重新采集并发起变更。', actor);
        return this.publicRun(run);
      }
      this.transition(run, 'running', 'approval.accepted', '已批准指定计划', `审批摘要 ${digest}。`, actor);
      run.appliedRevision = this.updateInventory(run.asset, asset.revision, run.plan.to);
      this.transition(run, 'running', 'change.applied', '已应用模拟配置', `模拟配置进入版本 r${run.appliedRevision}。`);
      if (run.scenario === 'failed-check') {
        run.evidence.push({ source: 'validation.fixture', detail: '故障注入：20 个模拟请求中出现 3 个失败。' });
        this.transition(run, 'running', 'change.check_failed', '验证失败', '模拟探测超过失败阈值，触发自动回滚。');
        const revision = this.updateInventory(run.asset, run.appliedRevision, run.plan.from);
        this.transition(run, 'rolled_back', 'change.auto_rollback', '已自动恢复原策略', `回滚完成，当前版本 r${revision}。`);
      } else {
        run.evidence.push({ source: 'validation.fixture', detail: '20 次模拟探测全部通过，重试上限为 2。' });
        this.transition(run, 'succeeded', 'change.verified', '模拟验证通过', '原策略已保留，可对当前版本执行回滚。');
      }
      return this.publicRun(run);
    });
  }
}
