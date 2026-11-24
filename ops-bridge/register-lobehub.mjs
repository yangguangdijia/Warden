import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { jsonRequest, upstreamIdPattern } from './upstream.mjs';

const root = 'http://127.0.0.1:3210/api/v1/mcp-servers';
const identifier = 'warden-openbot-ops';
const serverUrl = 'http://172.30.231.2:4310/mcp';
const expectedTools = new Set(['ops_request', 'ops_status']);

export async function registerConnector({ apiKey, mcpToken, fetchImpl }) {
  if (typeof apiKey !== 'string' || !apiKey || /\s/.test(apiKey)) throw new Error('Set LOBEHUB_MCP_API_KEY with mcp:read and mcp:write scopes.');
  if (typeof mcpToken !== 'string' || mcpToken.length < 24 || /\s/.test(mcpToken)) throw new Error('OPS_MCP_TOKEN is missing or invalid.');
  const call = (suffix, expected, body) => jsonRequest(root + suffix, { token: apiKey, expected, body, fetchImpl });
  const listed = (await call('', 200))?.data;
  if (!Array.isArray(listed)) throw new Error('Unexpected LobeHub connector list. Check the pinned LobeHub version.');
  let connector = listed.find((item) => item?.identifier === identifier);
  if (!connector) {
    connector = (await call('', 201, {
      identifier, name: 'Warden · OpenBot 运维', serverUrl,
      description: '通过 OpenBot 巡检隔离测试服务，准备待人工审批的变更。',
      credentials: { type: 'bearer', token: mcpToken }, isEnabled: true,
    }))?.data;
  }
  if (typeof connector?.id !== 'string' || !upstreamIdPattern.test(connector.id) ||
      connector.serverUrl !== serverUrl || connector.isEnabled !== true || connector.hasCredentials !== true) {
    throw new Error('Existing Warden connector does not match the expected enabled, authenticated MCP route. Check LobeHub settings without overwriting it.');
  }
  const result = (await call(`/${encodeURIComponent(connector.id)}/sync`, 200, {}))?.data;
  if (result?.status !== 'connected' || result.toolCount !== expectedTools.size) throw new Error('LobeHub did not discover the two operations tools.');
  const synced = (await call(`/${encodeURIComponent(connector.id)}`, 200))?.data;
  const names = synced?.tools?.map((tool) => tool.name);
  if (!Array.isArray(names) || names.length !== expectedTools.size || ![...expectedTools].every((name) => names.includes(name))) {
    throw new Error('LobeHub connector tools do not match the expected catalog.');
  }
  return { identifier, tools: names };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mcpToken = parseEnv(readFileSync(new URL('../deploy/.env', import.meta.url), 'utf8')).OPS_MCP_TOKEN;
    const result = await registerConnector({ apiKey: process.env.LOBEHUB_MCP_API_KEY, mcpToken });
    console.log(`LobeHub connected: ${result.identifier} (${result.tools.join(', ')})`);
  } catch (error) {
    console.error(`LobeHub registration failed: ${error.code ? `file error ${error.code}` : error.message}`);
    process.exitCode = 1;
  }
}
