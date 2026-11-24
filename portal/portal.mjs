#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createPrivateKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = dirname(directory);
const envPath = join(directory, '.env');
const composePath = join(root, 'docker-compose.yml');
const origin = 'http://127.0.0.1:3210';
const secretFormats = {
  PORTAL_AUTH_SECRET: /^[A-Za-z0-9+/]{43}=$/,
  PORTAL_VAULT_SECRET: /^[A-Za-z0-9+/]{43}=$/,
  PORTAL_POSTGRES_PASSWORD: /^[a-f0-9]{64}$/,
  PORTAL_REDIS_PASSWORD: /^[a-f0-9]{64}$/,
  PORTAL_S3_ADMIN_ID: /^[a-f0-9]{20}$/,
  PORTAL_S3_ADMIN_SECRET: /^[a-f0-9]{40}$/,
  PORTAL_S3_APP_ID: /^[a-f0-9]{20}$/,
  PORTAL_S3_APP_SECRET: /^[a-f0-9]{40}$/,
};
const settings = [
  'PORTAL_JWKS_KEY', 'PORTAL_ALLOWED_EMAIL', 'PORTAL_AUTH_MODE',
  'PORTAL_OIDC_CLIENT_ID', 'PORTAL_OIDC_CLIENT_SECRET', 'PORTAL_OIDC_ISSUER',
  'PORTAL_OPENAI_URL', 'PORTAL_OPENAI_KEY', 'PORTAL_OPENAI_MODEL_LIST',
];
const knownKeys = new Set([...Object.keys(secretFormats), ...settings]);
const help = `Local LobeHub portal at ${origin}
Use Node.js 22+ and a local Docker Engine 28+ in Linux container mode with Compose v2.

  node portal/portal.mjs init you@example.com   Generate portal/.env for one allowed email
  node portal/portal.mjs check                 Validate the env and Compose without printing secrets
  node portal/portal.mjs up                    Start and wait for services
  node portal/portal.mjs status                Show container and initialization state
  node portal/portal.mjs logs                  Show the last 100 lines per service
  node portal/portal.mjs down                  Stop and keep the named volumes

Open ${origin} and sign up with the allowlisted address after startup.
Email verification is disabled for the local password pilot. Keep it on loopback.
Optional HTTPS model gateway and OIDC settings are described in the generated portal/.env.
`;

function validEmail(email) {
  return /^[a-z0-9][a-z0-9_.+%-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(email ?? '');
}

function createEnvironment(email) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { ...privateKey.export({ format: 'jwk' }), alg: 'RS256', kid: randomBytes(8).toString('hex'), use: 'sig' };
  const hex = (bytes) => randomBytes(bytes).toString('hex');
  return `# Private local configuration. Keep this file with your backups and out of Git.
# Raw, single-line KEY=value entries. Do not quote values or add end-of-line comments.
# Keep generated secrets stable across restarts. Re-running init never replaces them.
PORTAL_ALLOWED_EMAIL=${email.toLowerCase()}
PORTAL_AUTH_MODE=password
PORTAL_AUTH_SECRET=${randomBytes(32).toString('base64')}
PORTAL_VAULT_SECRET=${randomBytes(32).toString('base64')}
PORTAL_POSTGRES_PASSWORD=${hex(32)}
PORTAL_REDIS_PASSWORD=${hex(32)}
PORTAL_S3_ADMIN_ID=${hex(10)}
PORTAL_S3_ADMIN_SECRET=${hex(20)}
PORTAL_S3_APP_ID=${hex(10)}
PORTAL_S3_APP_SECRET=${hex(20)}
PORTAL_JWKS_KEY=${JSON.stringify({ keys: [key] })}

# Optional OpenAI-compatible gateway. Set all three together. Use a scoped HTTPS
# endpoint reachable from the portal container and list only models it serves.
# Example model list: -all,+your-model-id
PORTAL_OPENAI_URL=
PORTAL_OPENAI_KEY=
PORTAL_OPENAI_MODEL_LIST=

# Optional generic OIDC pilot. Set PORTAL_AUTH_MODE=oidc and fill all three fields.
# Register ${origin}/api/auth/oauth2/callback/generic-oidc at the IdP.
# Use the allowlisted email for the pilot and restrict access at the IdP.
# If the IdP disallows loopback callbacks, or for an enterprise multiuser deployment,
# use a separate reviewed TLS deployment with matching APP_URL, OIDC callback and S3 CORS.
# Configure existing IdP assignments, role policy and network access before exposure.
PORTAL_OIDC_CLIENT_ID=
PORTAL_OIDC_CLIENT_SECRET=
PORTAL_OIDC_ISSUER=
`;
}

function restrictWindowsAcl(path) {
  if (process.platform !== 'win32') return;
  const aclTool = (tool, args) => spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool), args,
    { encoding: 'utf8', windowsHide: true });
  const identity = aclTool('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const sid = identity.stdout?.match(/S-\d-(?:\d+-)+\d+/i)?.[0];
  if (identity.status !== 0 || !sid || aclTool('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:F`]).status !== 0) {
    throw new Error('Could not restrict the Windows ACL. No secret file was created.');
  }
}

function init(email) {
  if (!validEmail(email)) throw new Error('Pass one email address, for example: node portal/portal.mjs init you@example.com');
  if (lstatSync(envPath, { throwIfNoEntry: false })) throw new Error('portal/.env already exists. Keep the existing deployment secrets.');
  const temp = mkdtempSync(join(directory, '.portal-init-'));
  try {
    const draft = join(temp, '.env');
    closeSync(openSync(draft, 'wx', 0o600));
    restrictWindowsAcl(draft);
    writeFileSync(draft, createEnvironment(email), 'utf8');
    // Publish the complete file without replacing an existing file, including concurrent init.
    linkSync(draft, envPath);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log('Created portal/.env. Start with node portal/portal.mjs up.');
}

function parseEnvironment() {
  const file = lstatSync(envPath, { throwIfNoEntry: false });
  if (!file) throw new Error('Run node portal/portal.mjs init you@example.com first.');
  if (!file.isFile() || file.size > 32_768 || (process.platform !== 'win32' && (file.mode & 0o077))) {
    throw new Error('portal/.env must be a private regular file (chmod 600 on Unix).');
  }
  const entries = {};
  for (const [index, line] of readFileSync(envPath, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !knownKeys.has(match[1]) || Object.hasOwn(entries, match[1]) || /[\x00-\x1f\x7f]/.test(match[2]) || match[2] !== match[2].trim()) {
      throw new Error(`Unsupported, duplicate or malformed setting at portal/.env line ${index + 1}.`);
    }
    entries[match[1]] = match[2];
  }
  return entries;
}

function requireHttps(value, name) {
  let url;
  try { url = new URL(value); } catch { /* Report the field name only. */ }
  if (!url || !value.startsWith('https://') || url.username || url.password || url.search || url.hash || /[\s\\]/.test(value)) {
    throw new Error(`${name} must be an HTTPS base URL without credentials, query or fragment.`);
  }
}

function validatedEnvironment() {
  const values = parseEnvironment();
  for (const [key, pattern] of Object.entries(secretFormats)) {
    if (!pattern.test(values[key] ?? '')) throw new Error(`Missing or invalid generated setting ${key}. Restore portal/.env from backup.`);
  }
  if (values.PORTAL_S3_ADMIN_ID === values.PORTAL_S3_APP_ID || values.PORTAL_S3_ADMIN_SECRET === values.PORTAL_S3_APP_SECRET) {
    throw new Error('RustFS administrative and application credentials must be distinct.');
  }
  try {
    const { keys } = JSON.parse(values.PORTAL_JWKS_KEY);
    const [key] = keys;
    if (keys.length !== 1 || key.alg !== 'RS256' || key.use !== 'sig' || !key.kid) throw new Error();
    const rsa = createPrivateKey({ key, format: 'jwk' });
    if (rsa.asymmetricKeyType !== 'rsa' || rsa.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
  } catch {
    throw new Error('Missing or invalid generated setting PORTAL_JWKS_KEY. Restore portal/.env from backup.');
  }
  if (!validEmail(values.PORTAL_ALLOWED_EMAIL)) throw new Error('PORTAL_ALLOWED_EMAIL must be one full email address.');
  const oidc = values.PORTAL_AUTH_MODE === 'oidc';
  const oidcFields = [values.PORTAL_OIDC_CLIENT_ID, values.PORTAL_OIDC_CLIENT_SECRET, values.PORTAL_OIDC_ISSUER];
  if ((oidc && !oidcFields.every(Boolean)) || (!oidc && (values.PORTAL_AUTH_MODE !== 'password' || oidcFields.some(Boolean)))) {
    throw new Error('Use password mode with empty OIDC settings or oidc mode with all three OIDC settings.');
  }
  if (oidc) requireHttps(values.PORTAL_OIDC_ISSUER, 'PORTAL_OIDC_ISSUER');
  const gatewayFields = [values.PORTAL_OPENAI_URL, values.PORTAL_OPENAI_KEY, values.PORTAL_OPENAI_MODEL_LIST];
  const gateway = gatewayFields.some(Boolean);
  if (gateway) {
    if (!gatewayFields.every(Boolean)) throw new Error('Set all three OpenAI gateway settings together.');
    requireHttps(values.PORTAL_OPENAI_URL, 'PORTAL_OPENAI_URL');
    if (!/^-all(?:,\+[a-zA-Z0-9][a-zA-Z0-9._:/-]*)+$/.test(values.PORTAL_OPENAI_MODEL_LIST)) {
      throw new Error('PORTAL_OPENAI_MODEL_LIST must follow -all,+model-id[, +model-id] without spaces.');
    }
  }
  return { ...values, PORTAL_DISABLE_PASSWORD: oidc ? '1' : '0', PORTAL_SSO_PROVIDERS: oidc ? 'generic-oidc' : '', PORTAL_OPENAI_ENABLED: gateway ? '1' : '0' };
}

function dockerEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PORTAL_|COMPOSE_)/i.test(key)));
  // No inherited .env, Compose override, profile or interpolation variables.
  return { ...env, COMPOSE_DISABLE_ENV_FILE: '1' };
}

function docker(args, env, capture = false) {
  const result = spawnSync('docker', args, { cwd: root, env, encoding: 'utf8', windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  if (result.error?.code === 'ENOENT') throw new Error('Docker CLI was not found. Install Docker with Compose v2.');
  if (result.error) throw new Error(`Could not start Docker (${result.error.code ?? 'unknown error'}).`);
  if (result.status !== 0) throw new Error(`Docker command failed (${result.status ?? result.signal}).`);
  return result.stdout?.trim();
}

function requireLocalDocker(env) {
  const host = (!env.DOCKER_CONTEXT && env.DOCKER_HOST) || docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], env, true);
  if (!/^unix:\/\/\/|^npipe:\/\/\/\/\.\/pipe\//i.test(host)) throw new Error('The portal requires a local Docker Unix socket or Windows named pipe.');
}

function main([action, ...args]) {
  if (!action || ['help', '--help', '-h'].includes(action)) return console.log(help);
  if (action === 'init' && args.length === 1) return init(args[0]);
  if (args.length || !['check', 'up', 'status', 'logs', 'down'].includes(action)) throw new Error('See node portal/portal.mjs --help for usage.');
  const values = validatedEnvironment();
  const baseEnv = dockerEnvironment();
  const env = { ...baseEnv, ...values };
  const compose = (args) => docker(['compose', '--project-directory', root, '--file', composePath, '--project-name', 'ai-platform-portal', ...args], env);
  if (action === 'check') {
    compose(['config', '--quiet']);
    return console.log('Portal env and Compose configuration are valid.');
  }
  requireLocalDocker(baseEnv);
  if (action === 'up') {
    // Docker Engine before 28 could expose localhost-published ports to peers on the same L2 segment.
    const version = docker(['version', '--format', '{{.Server.Version}}'], baseEnv, true);
    if (!/^\d+\./.test(version) || Number.parseInt(version, 10) < 28) throw new Error('Docker Engine 28 or newer is required for localhost isolation.');
    compose(['config', '--quiet']);
    compose(['up', '--detach', '--wait', '--wait-timeout', '300']);
    return console.log(`Portal ready at ${origin}.`);
  }
  if (action === 'status') return compose(['ps', '--all']);
  if (action === 'logs') return compose(['logs', '--tail', '100']);
  return compose(['down']);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  // Node system error paths and command output can include private data. Show only
  // the operation error code or a validation message that we authored.
  console.error(`Portal: ${error.code ? `File operation failed (${error.code}).` : error.message}`);
  process.exitCode = 1;
}
