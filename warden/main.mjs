import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const data = resolve(projectDir, process.env.WARDEN_DATA_DIR ?? '.warden-data');
const configuredPort = process.env.WARDEN_PORT ?? '4300';
if (!/^\d{1,5}$/.test(configuredPort) || Number(configuredPort) > 65535) throw new Error('Invalid WARDEN_PORT');
process.umask(process.umask() | 0o077);
mkdirSync(data, { recursive: true, mode: 0o700 });
const app = await startServer({ dbPath: resolve(data, 'warden.sqlite'), port: Number(configuredPort) });
console.log(`Warden 运维工作台 ${app.origin}`);
console.log(`操作员令牌 ${app.tokens.operator}\n审批员令牌 ${app.tokens.approver}`);
console.log('访问令牌仅在本次进程有效，请留在本机终端。按 Ctrl+C 停止。');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  app.close().catch(() => { console.error('Warden 停止时发生错误。'); process.exitCode = 1; });
});
