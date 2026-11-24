import { hash, iso } from '../warden/policy.mjs';
import { openDatabase, transaction } from './common.mjs';

const zero = '0'.repeat(64);

function eventHash(event) {
  return hash(JSON.stringify([event.previous, event.taskId, event.at, event.actor, event.code,
    event.detail, event.status, event.taskHash]));
}

function checkAudit(db) {
  let head = zero;
  let count = 0;
  const latest = new Map();
  for (const event of db.prepare('SELECT * FROM events ORDER BY seq').iterate()) {
    count += 1;
    if (event.seq !== count || event.previous !== head || event.hash !== eventHash(event)) {
      throw new Error(`Operations audit mismatch at sequence ${event.seq}`);
    }
    head = event.hash;
    latest.set(event.taskId, event);
  }
  const tasks = db.prepare('SELECT id, status, data FROM tasks').all();
  if (tasks.length !== latest.size || tasks.some((row) => {
    const event = latest.get(row.id);
    return !event || event.status !== row.status || event.taskHash !== hash(row.data);
  })) throw new Error('Operations task data differs from audited state');
  return { count, head };
}

export function taskStore(dataDir, now) {
  const database = openDatabase(dataDir, 'executor.sqlite');
  const { db } = database;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS single_mutation ON tasks(status) WHERE status = 'applying';
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, taskId TEXT NOT NULL REFERENCES tasks(id), at TEXT NOT NULL,
        actor TEXT NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL, status TEXT NOT NULL,
        taskHash TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_task_seq ON events(taskId, seq);
    `);
    checkAudit(db);
    const read = db.prepare('SELECT data FROM tasks WHERE id = ?');
    const write = db.prepare('INSERT INTO tasks VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, data=excluded.data');
    const latest = db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1');
    const append = db.prepare(`INSERT INTO events(taskId, at, actor, code, detail, status, taskHash, previous, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    return {
      close: database.close,
      audit: () => checkAudit(db),
      get(id) {
        const row = read.get(id);
        return row ? JSON.parse(row.data) : null;
      },
      byStatus(status) {
        return db.prepare('SELECT data FROM tasks WHERE status = ? ORDER BY rowid').all(status).map(({ data }) => JSON.parse(data));
      },
      save(task, code, detail, actor = 'ops-executor') {
        return transaction(db, () => {
          const item = { ...task, updatedAt: iso(now()) };
          const data = JSON.stringify(item);
          write.run(item.id, item.status, data);
          const event = { taskId: item.id, at: item.updatedAt, actor, code, detail, status: item.status,
            taskHash: hash(data), previous: latest.get()?.hash ?? zero };
          append.run(event.taskId, event.at, event.actor, event.code, event.detail, event.status,
            event.taskHash, event.previous, eventHash(event));
          return item;
        });
      },
      events(id) {
        return db.prepare('SELECT seq, at, actor, code, detail, status FROM events WHERE taskId = ? ORDER BY seq').all(id);
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
