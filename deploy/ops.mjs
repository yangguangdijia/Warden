#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeCore, probeIntegrated } from './probe.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = dirname(directory);
const envFile = join(directory, '.env');
const portalEnvFile = join(root, 'portal', '.env');
const openbotImage = 'ghcr.io/copilotkit/openbot@sha256:9d54d34c6bd269e9c2c331e33438ed243e73d031804877e14e57b9ba2934034d';
const publicOpenBot = 'http://127.0.0.1:3001';
const agentEndpoint = 'http://ops-agent-gateway:4320/agent';
const tokens = ['OPS_MCP_TOKEN', 'OPS_BRIDGE_TOKEN', 'OPS_AGENT_TOKEN', 'OPS_APPROVER_TOKEN', 'OPS_LAB_TOKEN'];
const portalFields = ['PORTAL_ALLOWED_EMAIL', 'PORTAL_AUTH_MODE', 'PORTAL_AUTH_SECRET', 'PORTAL_VAULT_SECRET', 'PORTAL_POSTGRES_PASSWORD',
  'PORTAL_REDIS_PASSWORD', 'PORTAL_S3_ADMIN_ID', 'PORTAL_S3_ADMIN_SECRET', 'PORTAL_S3_APP_ID', 'PORTAL_S3_APP_SECRET', 'PORTAL_JWKS_KEY',
  'PORTAL_OPENAI_URL', 'PORTAL_OPENAI_KEY', 'PORTAL_OPENAI_MODEL_LIST', 'PORTAL_OIDC_CLIENT_ID', 'PORTAL_OIDC_CLIENT_SECRET', 'PORTAL_OIDC_ISSUER'];
const ids = /^[A-Za-z0-9_-]{1,160}$/;
const email = /^[a-z0-9][a-z0-9_.+%-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const hex = (length) => randomBytes(length).toString('hex');
const key = () => randomBytes(32).toString('base64');

const help = `Integrated LobeHub, native OpenBot v1.1.2, Warden operations and Prometheus

  node deploy/ops.mjs init admin@example.com  Create private deploy/.env once
  node deploy/ops.mjs check                   Validate settings and merged Compose
  node deploy/ops.mjs up-core                 Start lab, Prometheus, executor and scoped gateways
  node deploy/ops.mjs up-portal               Start LobeHub and its data services for portal-only verification
  node deploy/ops.mjs probe-core              Verify core readiness, auth boundaries and scrape
  node deploy/ops.mjs up                      Start the stack (bootstrap if Bot is not registered)
  node deploy/ops.mjs organizations           List organization IDs for the OpenBot API credential
  node deploy/ops.mjs register                Register the private external OpenBot Bot and save its ID
  node deploy/ops.mjs probe                   Follow read-only MCP → OpenBot → AG-UI → Prometheus
  node deploy/ops.mjs status                  Show container state
  node deploy/ops.mjs logs                    Show recent container logs
  node deploy/ops.mjs down                    Stop the integrated stack and keep named volumes

See deploy/README.md for prerequisites and connector setup.`;

function readPrivate(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > 64 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) {
    throw new Error(`${basename(dirname(path))}/${basename(path)} must be a private regular file (chmod 600).`);
  }
  return readFileSync(path, 'utf8');
}

function parse(contents, source) {
  const result = {};
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (/^\s*(#|$)/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(result, match[1]) || match[2].trim() !== match[2] || /[\u0000-\u001f\u007f]/.test(match[2])) {
      throw new Error(`Malformed or duplicate assignment at ${source}:${index + 1}. Use raw KEY=value entries.`);
    }
    result[match[1]] = match[2];
  }
  return result;
}

function publish(contents, replace) {
  const tmp = mkdtempSync(join(directory, '.ops-env-'));
  const draft = join(tmp, '.env');
  try {
    const fd = openSync(draft, 'wx', 0o600);
    try { writeFileSync(fd, contents); } finally { closeSync(fd); }
    if (replace) renameSync(draft, envFile);
    else linkSync(draft, envFile);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

function generatePortal(admin) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', kid: hex(8), use: 'sig' };
  return {
    PORTAL_ALLOWED_EMAIL: admin, PORTAL_AUTH_MODE: 'password', PORTAL_AUTH_SECRET: key(), PORTAL_VAULT_SECRET: key(),
    PORTAL_POSTGRES_PASSWORD: hex(32), PORTAL_REDIS_PASSWORD: hex(32), PORTAL_S3_ADMIN_ID: hex(10), PORTAL_S3_ADMIN_SECRET: hex(20),
    PORTAL_S3_APP_ID: hex(10), PORTAL_S3_APP_SECRET: hex(20), PORTAL_JWKS_KEY: JSON.stringify({ keys: [jwk] }),
    PORTAL_OPENAI_URL: '', PORTAL_OPENAI_KEY: '', PORTAL_OPENAI_MODEL_LIST: '',
    PORTAL_OIDC_CLIENT_ID: '', PORTAL_OIDC_CLIENT_SECRET: '', PORTAL_OIDC_ISSUER: '',
  };
}

function init(admin) {
  if (process.platform !== 'linux') throw new Error('Run init on the Linux deployment host so deploy/.env gets Unix permissions.');
  if (!email.test(admin)) throw new Error('Pass the email of the initial OpenBot admin.');
  if (lstatSync(envFile, { throwIfNoEntry: false })) throw new Error('deploy/.env already exists. Keep the existing deployment credentials.');
  const normalized = admin.toLowerCase();
  const existing = lstatSync(portalEnvFile, { throwIfNoEntry: false });
  const portal = existing ? parse(readPrivate(portalEnvFile), 'portal/.env') : generatePortal(normalized);
  const example = readFileSync(join(directory, '.env.example'), 'utf8');
  const values = {
    OPENBOT_ADMIN_EMAIL: normalized, OPENBOT_SIGNIN_DOMAINS: normalized.split('@')[1],
    OPENBOT_AUTH_SECRET: key(), OPENBOT_ENCRYPTION_KEY: key(), OPENBOT_REGISTRATION_KEY: randomUUID(),
    ...Object.fromEntries(tokens.map((name) => [name, hex(32)])),
  };
  const ops = example.replace(/^([A-Z][A-Z0-9_]*)=(.*)$/gm, (line, name) => Object.hasOwn(values, name) ? `${name}=${values[name]}` : line);
  const portalLines = portalFields.map((name) => `${name}=${portal[name] ?? ''}`).join('\n');
  publish(`${ops.trimEnd()}\n\n# LobeHub configuration (${existing ? 'imported from portal/.env' : 'generated for this deployment'}).\n${portalLines}\n`, false);
  console.log('Created deploy/.env with mode 0600. Configure Google sign-in and Intelligence before starting OpenBot.');
}

function requireProtocol(value, protocol, name) {
  let url;
  try { url = new URL(value); } catch { /* Report only the setting name. */ }
  if (!url || url.protocol !== protocol || url.username || url.password || url.search || url.hash || /[\s\\]/.test(value)) {
    throw new Error(`${name} must use ${protocol} with no userinfo, query or fragment.`);
  }
}

function validated(values, full = false) {
  const expected = Object.keys(parse(readFileSync(join(directory, '.env.example'), 'utf8'), '.env.example'));
  const allowed = new Set([...expected, ...portalFields]);
  if (Object.keys(values).some((name) => !allowed.has(name))) throw new Error('deploy/.env contains an unsupported setting. See deploy/.env.example.');
  if (expected.some((name) => !Object.hasOwn(values, name))) throw new Error('Keep every setting from deploy/.env.example in deploy/.env.');
  if (tokens.some((name) => !/^[a-f0-9]{64}$/.test(values[name] ?? '')) || new Set(tokens.map((name) => values[name])).size !== tokens.length) {
    throw new Error('The generated operations credentials must be present and distinct. Restore the saved deploy/.env.');
  }
  if (['OPENBOT_AUTH_SECRET', 'OPENBOT_ENCRYPTION_KEY'].some((name) => !/^[a-zA-Z0-9+/]{43}=$/.test(values[name] ?? '')) ||
      !/^[a-f0-9-]{36}$/.test(values.OPENBOT_REGISTRATION_KEY ?? '')) throw new Error('Generated OpenBot secrets are absent or invalid.');
  if (!email.test(values.OPENBOT_ADMIN_EMAIL ?? '') || !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+(?:,(?:[a-z0-9-]+\.)+[a-z0-9-]+)*$/.test(values.OPENBOT_SIGNIN_DOMAINS ?? '') ||
      !values.OPENBOT_SIGNIN_DOMAINS.split(',').includes(values.OPENBOT_ADMIN_EMAIL.toLowerCase().split('@')[1])) {
    throw new Error('Set OPENBOT_ADMIN_EMAIL and include its domain in OPENBOT_SIGNIN_DOMAINS.');
  }
  if (full) {
    for (const name of ['OPENBOT_GOOGLE_CLIENT_ID', 'OPENBOT_GOOGLE_CLIENT_SECRET']) {
      if (!values[name]) throw new Error(`Set ${name} before starting native OpenBot.`);
    }
    if (!values.CPK_INTELLIGENCE_API_KEY && !values.COPILOTKIT_LICENSE_TOKEN) {
      throw new Error('Set CPK_INTELLIGENCE_API_KEY or COPILOTKIT_LICENSE_TOKEN before starting native OpenBot.');
    }
  }
  requireProtocol(values.INTELLIGENCE_API_URL, 'https:', 'INTELLIGENCE_API_URL');
  requireProtocol(values.INTELLIGENCE_GATEWAY_WS_URL, 'wss:', 'INTELLIGENCE_GATEWAY_WS_URL');
  if (values.OPENBOT_API_KEY && !/^[!-~]{24,512}$/.test(values.OPENBOT_API_KEY)) throw new Error('OPENBOT_API_KEY has an invalid token format.');
  for (const name of ['OPENBOT_ORGANIZATION_ID', 'OPENBOT_BOT_ID']) {
    if (values[name] && !ids.test(values[name])) throw new Error(`${name} has an invalid format.`);
  }
  if (values.OPENBOT_BOT_ID && (!values.OPENBOT_API_KEY || !values.OPENBOT_ORGANIZATION_ID)) {
    throw new Error('An existing OPENBOT_BOT_ID requires OPENBOT_API_KEY and OPENBOT_ORGANIZATION_ID.');
  }
  const oidc = values.PORTAL_AUTH_MODE === 'oidc';
  const oidcFields = [values.PORTAL_OIDC_CLIENT_ID, values.PORTAL_OIDC_CLIENT_SECRET, values.PORTAL_OIDC_ISSUER];
  if ((oidc && !oidcFields.every(Boolean)) || (!oidc && (values.PORTAL_AUTH_MODE !== 'password' || oidcFields.some(Boolean)))) {
    throw new Error('LobeHub requires password mode or complete OIDC settings.');
  }
  if (oidc) requireProtocol(values.PORTAL_OIDC_ISSUER, 'https:', 'PORTAL_OIDC_ISSUER');
  const gateway = [values.PORTAL_OPENAI_URL, values.PORTAL_OPENAI_KEY, values.PORTAL_OPENAI_MODEL_LIST];
  if (gateway.some(Boolean)) {
    if (!gateway.every(Boolean) || !/^-all(?:,\+[A-Za-z0-9][A-Za-z0-9._:/-]*)+$/.test(values.PORTAL_OPENAI_MODEL_LIST)) {
      throw new Error('Configure all three LobeHub model gateway values, using -all,+model-id for the model list.');
    }
    requireProtocol(values.PORTAL_OPENAI_URL, 'https:', 'PORTAL_OPENAI_URL');
  }
  if (!email.test(values.PORTAL_ALLOWED_EMAIL ?? '') || portalFields.slice(2, 11).some((name) => !values[name])) throw new Error('The initialized LobeHub settings are incomplete.');
  return { ...values, PORTAL_DISABLE_PASSWORD: oidc ? '1' : '0', PORTAL_SSO_PROVIDERS: oidc ? 'generic-oidc' : '', PORTAL_OPENAI_ENABLED: gateway.every(Boolean) ? '1' : '0' };
}

function command(name, args, { env, capture = false, input } = {}) {
  const done = spawnSync(name, args, { cwd: root, env, input, encoding: 'utf8', windowsHide: true,
    stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'] });
  if (done.error?.code === 'ENOENT') throw new Error(`${name} was not found.`);
  if (done.status !== 0 || done.error) throw new Error(`${name} command failed (${done.error?.code ?? done.status ?? done.signal}).`);
  return done.stdout?.trim();
}

const dockerEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(PORTAL_|OPENBOT_|OPS_|COMPOSE_|INTELLIGENCE_|CPK_INTELLIGENCE_|COPILOTKIT_LICENSE_TOKEN$)/i.test(name)));
dockerEnvironment.COMPOSE_DISABLE_ENV_FILE = '1';

function requireDocker() {
  if (process.platform !== 'linux') throw new Error('Start and probe this stack on its Linux deployment host.');
  const host = (!dockerEnvironment.DOCKER_CONTEXT && dockerEnvironment.DOCKER_HOST) ||
    command('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { env: dockerEnvironment, capture: true });
  if (!host.startsWith('unix:///')) throw new Error('This deployment requires a local Docker Engine Unix socket.');
  const version = command('docker', ['version', '--format', '{{.Server.Os}} {{.Server.Version}}'], { env: dockerEnvironment, capture: true });
  const match = /^linux (\d+)\./.exec(version);
  if (!match || Number(match[1]) < 28) throw new Error('Linux Docker Engine 28+ is required for loopback port isolation.');
}

async function openBot(path, token, { body, idempotency, expected = 200 } = {}) {
  if (!token) throw new Error('Set OPENBOT_API_KEY to the dedicated Bot owner’s credential.');
  let response;
  try {
    response = await fetch(`${publicOpenBot}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': idempotency } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new Error('Could not contact native OpenBot at port 3001. Check deployment status and OpenBot logs.'); }
  if (response.status !== expected) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`OpenBot ${body ? 'POST' : 'GET'} ${path} returned HTTP ${response.status}. Check sign-in, organization, Bot creation permission and the agent allowlist.`);
  }
  return response.json();
}

async function register(values, current) {
  if (!values.OPENBOT_ORGANIZATION_ID) throw new Error('Set OPENBOT_ORGANIZATION_ID using the organizations command.');
  const path = `/api/v2/organizations/${encodeURIComponent(values.OPENBOT_ORGANIZATION_ID)}/bots`;
  const body = { name: 'Warden Operations', title: 'Operations lab', roleDescription: 'Inspects the registered operations lab and prepares changes for human review.',
    visibility: 'private', endpoint: agentEndpoint, auth: { header: 'Authorization', value: `Bearer ${values.OPS_AGENT_TOKEN}` } };
  const { bot } = values.OPENBOT_BOT_ID ? await openBot(`${path}/${values.OPENBOT_BOT_ID}`, values.OPENBOT_API_KEY) :
    await openBot(path, values.OPENBOT_API_KEY, { body, idempotency: values.OPENBOT_REGISTRATION_KEY, expected: 201 });
  if (!ids.test(bot?.id ?? '') || !bot.hasAuth || !bot.mine || bot.endpoint !== agentEndpoint || bot.visibility !== 'private') {
    throw new Error('OpenBot did not return a private, authenticated, caller-owned Bot at the configured AG-UI endpoint.');
  }
  if (!values.OPENBOT_BOT_ID) {
    if (readPrivate(envFile) !== current) throw new Error('deploy/.env changed while registering. Retry with the same settings and registration key.');
    publish(current.replace(/^OPENBOT_BOT_ID=.*$/m, `OPENBOT_BOT_ID=${bot.id}`), true);
  }
  console.log(`Private OpenBot Bot verified (${bot.id}). Start the bridge with node deploy/ops.mjs up.`);
}

async function main([action = '--help', ...args]) {
  if (['help', '--help', '-h'].includes(action)) return console.log(help);
  if (action === 'init' && args.length === 1) return init(args[0]);
  if (args.length || !['check', 'up-core', 'up-portal', 'probe-core', 'up', 'organizations', 'register', 'probe', 'status', 'logs', 'down'].includes(action)) throw new Error('See node deploy/ops.mjs --help.');
  if (!lstatSync(envFile, { throwIfNoEntry: false })) throw new Error('Run node deploy/ops.mjs init admin@example.com first.');
  const current = readPrivate(envFile);
  const values = validated(parse(current, 'deploy/.env'), action === 'up');
  if (action === 'organizations') {
    const { organizations } = await openBot('/api/v2/people/me/organizations', values.OPENBOT_API_KEY);
    return console.log(JSON.stringify(organizations.map(({ id, name, role }) => ({ id, name, role })), null, 2));
  }
  if (action === 'register') return register(values, current);
  const compose = (args, options) => command('docker', ['compose', '--project-directory', root, '--project-name', 'ai-platform-portal',
    '-f', join(root, 'docker-compose.yml'), '-f', join(directory, 'compose.yml'), '--profile', 'ops-ready', ...args],
  { env: { ...dockerEnvironment, ...values }, ...options });
  if (action === 'check') {
    compose(['config', '--quiet']);
    return console.log('Settings and merged Compose are valid.');
  }
  requireDocker();
  if (action === 'status') return compose(['ps', '--all']);
  if (action === 'logs') return compose(['logs', '--tail', '80']);
  if (action === 'down') return compose(['down']);
  if (action === 'probe-core') return probeCore(compose);
  if (action === 'probe') {
    if (!values.OPENBOT_BOT_ID) throw new Error('Register the OpenBot Bot and run up before the integrated probe.');
    return probeIntegrated(compose, values.OPS_MCP_TOKEN);
  }
  if (action === 'up') {
    command('cosign', ['verify', '--key', join(directory, 'openbot-cosign.pub'), '--insecure-ignore-tlog=true', openbotImage],
      { env: dockerEnvironment, capture: true });
    console.log('Verified the upstream OpenBot signature.');
  }
  compose(['config', '--quiet']);
  if (action === 'up-portal') {
    compose(['up', '--detach', '--wait', '--wait-timeout', '300', 'portal']);
    return console.log('LobeHub is ready at http://127.0.0.1:3210.');
  }
  compose(['build', 'ops-lab']);
  const services = action === 'up-core' ? ['ops-agent-gateway', 'ops-review-gateway'] :
    values.OPENBOT_BOT_ID ? [] : ['portal', 'openbot', 'ops-agent-gateway', 'ops-review-gateway'];
  compose(['up', '--detach', '--wait', '--wait-timeout', '360', ...services]);
  if (action === 'up-core') return console.log('Core services are ready. Run node deploy/ops.mjs probe-core.');
  if (!values.OPENBOT_BOT_ID) return console.log('OpenBot bootstrap running at http://localhost:3001. Sign in, create the Bot owner’s key, then run organizations and register.');
  console.log('Integrated stack is ready. Run node deploy/ops.mjs probe.');
}

try { await main(process.argv.slice(2)); }
catch (error) {
  console.error(`Deployment error. ${error.code ? `Operation failed (${error.code}).` : error.message}`);
  process.exitCode = 1;
}
