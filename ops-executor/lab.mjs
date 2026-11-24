import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Fault, exactKeys } from '../warden/policy.mjs';
import { authorize, envPort, listen, openDatabase, readJson, requireTokens, runService, send, transaction, uuid } from './common.mjs';

export const target = 'ops-lab';
export const baseline = 'baseline';
export const capped = 'capped';
export const invalid = 'invalid';
const retryBudget = Object.freeze({ [baseline]: 5, [capped]: 2, [invalid]: -1 });
export const validPreset = (preset) => preset === baseline || preset === capped;
export const version = (value) => Number.isSafeInteger(value) && value >= 1;

function labStore(dataDir) {
  const database = openDatabase(dataDir, 'lab.sqlite');
  const { db } = database;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS configuration (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1), instanceId TEXT NOT NULL,
        version INTEGER NOT NULL, preset TEXT NOT NULL CHECK(preset IN ('baseline', 'capped', 'invalid'))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS mutations (
        taskId TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('apply', 'compensate')),
        beforeVersion INTEGER NOT NULL, beforePreset TEXT NOT NULL,
        afterVersion INTEGER NOT NULL UNIQUE, afterPreset TEXT NOT NULL,
        PRIMARY KEY (taskId, phase)
      ) STRICT;
    `);
    db.prepare('INSERT OR IGNORE INTO configuration VALUES (1, ?, 1, ?)').run(randomUUID(), baseline);
    const config = () => db.prepare('SELECT instanceId, version, preset FROM configuration WHERE singleton = 1').get();
    const receipt = db.prepare('SELECT * FROM mutations WHERE taskId = ? AND phase = ?');
    return { close: database.close, config, mutate(input) {
      return transaction(db, () => {
        const { instanceId, version: currentVersion, preset: currentPreset } = config();
        if (instanceId !== input.instanceId) throw new Fault(409, 'Lab instance changed');
        const prior = receipt.get(input.taskId, input.phase);
        if (prior) {
          if (prior.beforeVersion !== input.expectedVersion || (input.phase === 'apply' && prior.afterPreset !== input.preset)) {
            throw new Fault(409, 'Mutation receipt differs from request');
          }
          return { instanceId, version: prior.afterVersion, preset: prior.afterPreset };
        }
        if (currentVersion !== input.expectedVersion || currentVersion === Number.MAX_SAFE_INTEGER) {
          throw new Fault(409, 'Configuration version changed');
        }

        let nextPreset;
        if (input.phase === 'apply') {
          if (!validPreset(currentPreset) || currentPreset === input.preset) throw new Fault(409, 'Preset cannot be applied');
          nextPreset = input.preset;
        } else {
          const applied = receipt.get(input.taskId, 'apply');
          if (!applied || currentVersion !== applied.afterVersion || currentPreset !== applied.afterPreset) {
            throw new Fault(409, 'Configuration no longer matches the applied change');
          }
          nextPreset = applied.beforePreset;
        }
        const nextVersion = currentVersion + 1;
        db.prepare('UPDATE configuration SET version = ?, preset = ? WHERE singleton = 1 AND version = ?')
          .run(nextVersion, nextPreset, currentVersion);
        db.prepare('INSERT INTO mutations VALUES (?, ?, ?, ?, ?, ?)')
          .run(input.taskId, input.phase, currentVersion, currentPreset, nextVersion, nextPreset);
        return { instanceId, version: nextVersion, preset: nextPreset };
      });
    } };
  } catch (error) {
    database.close();
    throw error;
  }
}

function readConfiguration(current) {
  return { ...current, retryBudget: retryBudget[current.preset] };
}

function health(current) {
  const retryBudget = current.retryBudget;
  // A lab worker can admit requests only when its configured retry budget is valid.
  const healthy = Number.isInteger(retryBudget) && retryBudget >= 0 && retryBudget <= 5;
  return { ...current, healthy, check: 'retry-budget' };
}

export async function startLabService({ dataDir, token = process.env.OPS_LAB_TOKEN, port = 0, host = '127.0.0.1' } = {}) {
  requireTokens({ OPS_LAB_TOKEN: token });
  const checkToken = authorize(token);
  const store = labStore(dataDir);
  let server;
  try {
    server = await listen({ host, port }, async (req, res) => {
      if (req.method === 'GET' && req.url === '/metrics') {
        const current = health(readConfiguration(store.config()));
        return send(res, 200, `# HELP ops_lab_config_healthy Whether the live lab config passes its health check.\n` +
          `# TYPE ops_lab_config_healthy gauge\nops_lab_config_healthy ${Number(current.healthy)}\n` +
          `# HELP ops_lab_config_version Current version of the lab configuration.\n` +
          `# TYPE ops_lab_config_version gauge\nops_lab_config_version ${current.version}\n`,
        'text/plain; version=0.0.4; charset=utf-8');
      }
      if (req.method === 'GET' && req.url === '/health') {
        const current = health(readConfiguration(store.config()));
        return send(res, current.healthy ? 200 : 503, current);
      }
      if (req.method === 'GET' && req.url === '/config') {
        checkToken(req);
        return send(res, 200, readConfiguration(store.config()));
      }
      if (req.method === 'POST' && req.url === '/config') {
        checkToken(req);
        const input = await readJson(req);
        const fields = ['taskId', 'phase', 'instanceId', 'expectedVersion'];
        const applying = input?.phase === 'apply';
        if (applying) fields.push('preset');
        if (!exactKeys(input, fields) || (!applying && input.phase !== 'compensate') ||
            typeof input.taskId !== 'string' || !uuid.test(input.taskId) ||
            typeof input.instanceId !== 'string' || !uuid.test(input.instanceId) || !version(input.expectedVersion) ||
            (applying && input.preset !== capped && input.preset !== invalid)) {
          throw new Fault(400, 'Invalid lab mutation');
        }
        return send(res, 200, readConfiguration(store.mutate({ ...input, taskId: input.taskId.toLowerCase() })));
      }
      throw new Fault(404, 'Route not found');
    });
  } catch (error) {
    store.close();
    throw error;
  }
  let closing;
  return { origin: server.origin, close() { return closing ??= server.close().finally(store.close); } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(process.umask() | 0o077);
  runService('Ops lab', await startLabService({
    dataDir: process.env.OPS_DATA_DIR, port: envPort('OPS_LAB_PORT', 4321), host: process.env.OPS_BIND_HOST ?? '127.0.0.1',
  }));
}
