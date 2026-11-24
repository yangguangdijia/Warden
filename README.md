# Warden 运维 Agent：LobeHub + OpenBot

**0.1.0 预览版** · [发布说明](RELEASE_NOTES.md) · [部署手册](deploy/README.md)

这套部署把 LobeHub 2.3.4 的运维助手接到 OpenBot v1.1.2。LobeHub 经认证的 MCP 连接器发起任务，桥接服务调用 OpenBot 的会话 API。OpenBot 在后台调用 AG-UI 执行器，执行器采集证据，并在需要时生成待人工审批的变更。LobeHub 可以查询任务状态、运行编号、证据和审批链接。`warden/` 和 `原型/` 是保留的离线练习，不是这条链路的执行入口。

## 部署

从项目目录运行。部署主机需要支持 Linux 容器的 Docker Engine 28+、Compose v2 和 Node 24。接入原生 OpenBot 另外需要 Cosign、Google OAuth、CopilotKit Intelligence 配置，以及专用 OpenBot API 身份。DeepSeek 可作为 LobeHub 的模型，不替代 OpenBot 的会话基础设施。

```sh
node deploy/ops.mjs init admin@your-company.example
node deploy/ops.mjs check
node deploy/ops.mjs up-core
node deploy/ops.mjs probe-core
```

- `up-core` 仅启动执行器、审批入口、实验服务和 Prometheus；不会伪造 OpenBot 运行。
- `up-portal` 在没有 OpenBot 凭证时独立启动 LobeHub 及其数据服务。
- 配置好上游凭证后，使用 `up` 启动门户与 OpenBot，完成 OpenBot 登录，配置 API 身份后依次使用 `organizations`、`register`、`up`、`probe`。准确的 OAuth、密钥配置和 SSH 转发步骤见 [部署手册](deploy/README.md)。
- 在 LobeHub 注册 MCP 时，从合法账号取得 `mcp:read`、`mcp:write` 权限，把密钥通过安全环境变量 `LOBEHUB_MCP_API_KEY` 注入，再运行 `node ops-bridge/register-lobehub.mjs`。为运维对话启用这个连接器和支持工具调用的模型。不要把凭证放在提示词或提交到源码。

服务默认不对公网开放。云机上的浏览器入口用 SSH 本地端口转发访问。使用 `node deploy/ops.mjs down` 停止该项目，保留数据卷。在 Windows 上如使用 Docker Desktop，先把镜像和卷放到 D 盘，避免项目数据写回 C 盘。

## 可验收任务

| 运维操作 | 证据与边界 |
| --- | --- |
| `inspect` | 读取登记实验服务的两个 Prometheus 指标及实验服务健康、配置状态。返回原始结构化证据。 |
| `propose_change` | 根据当前配置版本生成固定重试策略变更。人通过独立审批页核对方案与摘要后，执行器才写入。 |
| `propose_failed_change` | 在同一个实验服务注入固定失败配置，验证不健康后恢复原预设，复查配置、健康与版本。 |

在 LobeHub 中请助手先调用 `ops_request(operation=inspect)`，再用返回的任务 ID 调用 `ops_status`。看到状态 `completed`、非空的 OpenBot conversation/message/run ID 和 Prometheus 样本，才算原生运行成立。变更则从 `awaiting_approval` 的链接进入审批。任务对话和状态查询不能签发审批、访问生产主机或执行任意命令。批准权限也只覆盖实验服务的固定配置。

## 测试与已知限制

- `node --test`：覆盖 LobeHub/MCP 到 OpenBot API 合约、签名、鉴权、任务去重、审批摘要、版本冲突、数据库审计及重启恢复。Windows 可先将 `WARDEN_TEST_TEMP_DIR` 设置到 D 盘。
- `node deploy/verify-change.mjs`：在正在运行的核心测试栈内，通过真实实验服务和真实 Prometheus 验证一次故障注入及补偿。它会修改实验服务状态（恢复原预设，但版本前进两次）。这是直接 AG-UI 验收，不是从 LobeHub 驱动 OpenBot。
- 核心执行控制已在 Linux 云机验收。OpenBot 原生端到端验收仍需要 Intelligence 和 OAuth 配置；没有真实 OpenBot 回调的测试不会计作原生链路通过。当前仅接入实验服务，不建议给这套试用配置提供生产管理员权限。
