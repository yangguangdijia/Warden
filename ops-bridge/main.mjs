import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from './server.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const data = resolve(project, process.env.OPS_DATA_DIR ?? '.ops-data');
const port = Number(process.env.OPS_BRIDGE_PORT ?? '4310');
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid OPS_BRIDGE_PORT');
process.umask(process.umask() | 0o077);
mkdirSync(data, { recursive: true, mode: 0o700 });
const bridge = await startBridge({
  dbPath: resolve(data, 'bridge.sqlite'), host: process.env.OPS_BIND_HOST ?? '127.0.0.1', port,
  openBotUrl: process.env.OPENBOT_BASE_URL, openBotToken: process.env.OPENBOT_API_KEY,
  organizationId: process.env.OPENBOT_ORGANIZATION_ID, botId: process.env.OPENBOT_BOT_ID,
  mcpToken: process.env.OPS_MCP_TOKEN, bridgeToken: process.env.OPS_BRIDGE_TOKEN,
  executorUrl: process.env.OPS_EXECUTOR_URL, approvalUrl: process.env.OPS_APPROVAL_URL,
});
console.log(`OpenBot operations MCP listening on port ${bridge.port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  bridge.close().catch(() => { console.error('Could not close the operations bridge.'); process.exitCode = 1; });
});
