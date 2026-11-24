import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { newTask } from './upstream.mjs';

export class BridgeStore {
  constructor(path, routingIdentity) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1500');
      this.db.exec(`CREATE TABLE IF NOT EXISTS bridge_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS bridge_tasks (
          id TEXT PRIMARY KEY, operation TEXT NOT NULL, createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
          status TEXT NOT NULL, conversationId TEXT, messageId TEXT, error TEXT
        ) STRICT`);
      const configuration = createHash('sha256').update(routingIdentity).digest('hex');
      this.db.prepare("INSERT OR IGNORE INTO bridge_meta VALUES ('identity', ?)").run(configuration);
      if (this.db.prepare("SELECT value FROM bridge_meta WHERE key='identity'").get().value !== configuration) {
        throw new Error('This bridge data belongs to a different OpenBot route or signing key. Configure a separate data directory.');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get(id) { return this.db.prepare('SELECT * FROM bridge_tasks WHERE id=?').get(id); }

  create(operation, requestId, now) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = requestId ? this.get(requestId) : null;
      if (old && old.operation !== operation) throw new Error('此请求编号已用于其他操作。');
      if (old) {
        this.db.exec('COMMIT');
        return old;
      }
      if (this.db.prepare('SELECT COUNT(*) AS n FROM bridge_tasks').get().n >= 5000) {
        throw new Error('任务库已达到 5000 条上限。请归档并切换数据目录。');
      }
      const task = newTask(operation, requestId, now);
      this.db.prepare("INSERT INTO bridge_tasks(id,operation,createdAt,expiresAt,status) VALUES (?,?,?,?,'dispatching')")
        .run(task.id, task.operation, task.createdAt, task.expiresAt);
      this.db.exec('COMMIT');
      return this.get(task.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  saveConversation(id, conversationId) {
    this.db.prepare('UPDATE bridge_tasks SET conversationId=? WHERE id=?').run(conversationId, id);
    return this.get(id);
  }

  accept(id, messageId) {
    this.db.prepare("UPDATE bridge_tasks SET status='submitted',messageId=?,error=NULL WHERE id=?").run(messageId, id);
    return this.get(id);
  }

  error(id, message, status) {
    this.db.prepare('UPDATE bridge_tasks SET status=?,error=? WHERE id=?').run(status, message, id);
    return this.get(id);
  }

  close() { this.db.close(); }
}
