import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAudit } from './store.mjs';

const [, , countArg, headArg, ...extra] = process.argv;
if (extra.length || (countArg !== undefined && (!/^\d{1,9}$/.test(countArg) || !/^[a-f0-9]{64}$/.test(headArg ?? '')))) {
  throw new Error('Usage: node warden/audit.mjs [event-count head-hash]');
}
const checkpoint = countArg === undefined ? undefined : { count: Number(countArg), head: headArg };
const projectDir = fileURLToPath(new URL('../', import.meta.url));
const db = new DatabaseSync(resolve(projectDir, process.env.WARDEN_DATA_DIR ?? '.warden-data', 'warden.sqlite'), { readOnly: true });
try {
  // Keep a single snapshot even if the running service appends an event concurrently.
  db.exec('BEGIN');
  console.log(JSON.stringify(checkAudit(db, checkpoint)));
} finally {
  db.close();
}
