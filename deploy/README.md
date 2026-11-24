# Warden operations deployment

The stack runs LobeHub 2.3.4, CopilotKit OpenBot v1.1.2, the Node MCP bridge, AG-UI executor, approval UI, lab, and Prometheus on one Linux Docker host. OpenBot runs its published image with embedded PostgreSQL. This layout is for a trusted pilot team using OpenBot's shared computer. The upstream Helm charts support deployments that require a separate computer per person or Bot. [OpenBot deployment guide](https://github.com/CopilotKit/OpenBot/blob/v1.1.2/docs/deployment.md)

## Prerequisites

- Linux Docker Engine 28 or newer, Docker Compose v2 with `up --wait`, Node.js 24, and an installed Cosign CLI for the native OpenBot path. Use a local Docker Unix socket. The OpenBot release publishes Linux AMD64 and ARM64 images.
- Allow outbound HTTPS to the image registries, Google OAuth, and your Intelligence host. OpenBot also uses an outbound WebSocket to the Intelligence gateway. Keep `172.30.231.0/29` available for the Docker MCP network. Ports 3001, 3210, 4320, and 9000 must be free on host loopback.
- Start with roughly 4 vCPU, 12 GiB of memory, and persistent disk space for all images, database volumes, and browser profiles. OpenBot alone is capped at 4 GiB. The Compose override caps memory, CPU, and process counts for each service.
- A Google OAuth web client whose allowed audience is your pilot team. Register `http://localhost:3001/api/auth/callback/google` and use `http://localhost:3001` in the browser. Add the named OpenBot administrator and a dedicated Bot owner to the Google app's permitted users. Use an internal Google Workspace app or authorize the exact pilot users in your IdP. `OPENBOT_SIGNIN_DOMAINS` controls domains, while the OAuth app limits people within those domains.
- A real `CPK_INTELLIGENCE_API_KEY` plus the Intelligence API and gateway URLs. The defaults in `.env.example` are CopilotKit's managed endpoints. A self-hosted deployment must provide a compatible Intelligence service (upstream minimum `0.16.0-rc.12`) and license. Both URLs must be secure. Built-in model flows may also need `OPENBOT_OPENAI_API_KEY`. The external Warden executor uses fixed operations.

The launcher verifies the published image's Cosign signature against CopilotKit's public key before `up`. The pinned platform index is `sha256:9d54d34c6bd269e9c2c331e33438ed243e73d031804877e14e57b9ba2934034d`. [Release image manifest](https://github.com/CopilotKit/OpenBot/releases/download/v1.1.2/container-images.json) · [Release signing key](https://github.com/CopilotKit/OpenBot/blob/v1.1.2/docs/cosign.pub)

## Start and register

Run commands from the repository root on the Linux deployment host.

```bash
node deploy/ops.mjs init admin@your-company.example
```

`init` generates a private `deploy/.env` and five distinct operations tokens. If `portal/.env` exists, the launcher imports its LobeHub settings to reuse existing database and storage volumes. Keep `deploy/.env` with the deployment backups because it also holds the OpenBot encryption key and the operations signing key. Edit the generated file in place with raw `KEY=value` lines and keep mode `0600`.

1. Set `OPENBOT_GOOGLE_CLIENT_ID`, `OPENBOT_GOOGLE_CLIENT_SECRET`, and the Intelligence credentials in `deploy/.env`.
2. Run `node deploy/ops.mjs check` and `node deploy/ops.mjs up`. The first `up` starts the portal, native OpenBot and the operations services needed for registration.
3. Open `http://localhost:3001` and finish sign-in and onboarding. Sign in as your dedicated Bot owner, enable Bot creation for that account if the deployment requires it, and make an API key under **Settings → API keys**. Save it as `OPENBOT_API_KEY` in `deploy/.env`. A personal `obk_` key acts as its owner across the owner's organizations. Use a dedicated account with membership only where the private Bot should run. An app OAuth token used for the bridge needs `conversations:read` and `conversations:write`, and `register` also needs Bot read/write access. `organizations` needs `organizations:read`. [OpenBot v1.1.2 API specification](https://github.com/CopilotKit/OpenBot/blob/v1.1.2/api/openapi.yaml)
4. Run `node deploy/ops.mjs organizations`, put the intended ID in `OPENBOT_ORGANIZATION_ID`, then run `node deploy/ops.mjs register`. This calls `POST /api/v2/organizations/{organizationId}/bots` with a private Bot whose `endpoint` is `http://ops-agent-gateway:4320/agent` and whose `auth` is `{ "header": "Authorization", "value": "Bearer <OPS_AGENT_TOKEN>" }`. The launcher saves the returned ID to `OPENBOT_BOT_ID`. If you supply an existing Bot ID, the launcher checks ownership, privacy, endpoint, and presence of authentication. Set the correct bearer on that Bot before probing. [Bot creation and security contract](https://github.com/CopilotKit/OpenBot/blob/v1.1.2/api/openapi/bots.yaml)
5. Run `node deploy/ops.mjs up` again to start the MCP bridge and gateway. Run `node deploy/ops.mjs probe` for the native end-to-end inspection.
6. In LobeHub at `http://127.0.0.1:3210`, sign up with `PORTAL_ALLOWED_EMAIL` for the password pilot, or sign in via your configured OIDC provider. Add an HTTP MCP connector at `http://172.30.231.2:4310/mcp` using `OPS_MCP_TOKEN` as the Bearer credential. Sync and confirm it discovers `ops_request` and `ops_status`. For API registration, use `node ops-bridge/register-lobehub.mjs` with `LOBEHUB_MCP_API_KEY` set to the short-lived LobeHub credential carrying MCP read/write scopes and permission to update the current agent. Chat invocation also needs a LobeHub model with tool support. Connector registration verifies the actual LobeHub client path.

Use `node deploy/ops.mjs status`, `logs`, and `down` to manage the merged stack. `down` preserves named volumes. Use this launcher when managing the integrated project. On a remote Linux host, use SSH local forwards for browser access and keep the browser URLs above so OAuth and presigned S3 requests see the expected origins.

```bash
ssh -N -L 127.0.0.1:3001:127.0.0.1:3001 -L 127.0.0.1:3210:127.0.0.1:3210 \
  -L 127.0.0.1:4320:127.0.0.1:4320 -L 127.0.0.1:9000:127.0.0.1:9000 user@linux-host
```

## Network and credential boundaries

| Caller | Destination | Access |
| --- | --- | --- |
| Browser | `127.0.0.1:3210` and `127.0.0.1:9000` | LobeHub auth and private S3 presigned requests |
| Browser | `localhost:3001` | OpenBot Google sign-in |
| LobeHub server | `172.30.231.2:4310/mcp` | Only MCP, bearer `OPS_MCP_TOKEN` |
| Bridge | `openbot:3001` | Organization and private Bot under `OPENBOT_API_KEY` |
| OpenBot | `ops-agent-gateway:4320/agent` | Only AG-UI, bearer `OPS_AGENT_TOKEN`, with a separately signed task envelope |
| Bridge | `ops-executor:4320/internal/tasks/<UUID>` | Task evidence, bearer `OPS_BRIDGE_TOKEN` |
| Human approver | `127.0.0.1:4320/review?taskId=<UUID>` | Review UI and digest-bound approval API, bearer `OPS_APPROVER_TOKEN` |
| Executor | `ops-lab:4321/config` | Fixed lab state operations, bearer `OPS_LAB_TOKEN` |
| Executor and Prometheus | `prometheus:9090`, `ops-lab:4321/metrics` | Internal query and scrape networks |

LobeHub keeps its global private-IP SSRF bypass disabled and explicitly allows only `172.30.231.2`, the MCP route gateway IP. OpenBot explicitly allows only `ops-agent-gateway:4320` as a private agent endpoint, with its global computer private-host bypass disabled. Application routes use distinct tokens and lab, bridge, executor, and Prometheus ports are private. The Node services and gateways run as UID 1000 with a read-only root, dropped capabilities, and private data volumes for the services that need them. No service mounts the Docker socket. [LobeHub v2.3.4 SSRF implementation](https://github.com/lobehub/lobehub/blob/v2.3.4/packages/ssrf-safe-fetch/index.ts) · [OpenBot v1.1.2 endpoint policy](https://github.com/CopilotKit/OpenBot/blob/v1.1.2/.env.example)

## Acceptance on Linux

With no Google or Intelligence credentials yet, `node deploy/ops.mjs up-core` and `node deploy/ops.mjs probe-core` verify the loopback review interface, executor and lab bearer boundaries, and real Prometheus scraping. Prometheus collects `ops_lab_config_healthy` and `ops_lab_config_version` from the same lab the executor reads. The lab container's health check uses `/metrics`, so the deliberate failed health check during rollback leaves the runtime available to compensate.

With OpenBot registered, `node deploy/ops.mjs probe` submits a read-only `inspect` MCP call from the LobeHub container and polls to `completed`. The probe requires real OpenBot conversation, message, and run IDs and both Prometheus series in the executor's evidence. The LobeHub connector sync separately exercises LobeHub's transport and SSRF configuration. To validate approval in the lab, submit a proposal from the registered connector and use the returned `/review` link. The approver should inspect the fixed proposal and enter their approval token in that loopback page. `propose_failed_change` exercises the lab's failed post-check and compensating write.
