# Warden 0.1.0 预览版

## 功能

- 提供 LobeHub、OpenBot、Prometheus、运维执行器和审批入口的 Docker Compose 部署。LobeHub 使用认证的 MCP 工具提交和查询任务；桥接使用 OpenBot v1.1.2 的会话及消息 API。
- 执行器读取隔离实验服务的配置、健康状态和 Prometheus 指标。任务记录关联 OpenBot 运行编号、执行证据、审批摘要和变更结果。
- 写操作需要单独的人工审批。执行器按配置版本写入，验证失败后恢复原配置，并把检验和恢复结果写入持久化审计。聊天工具不能提交审批、调用任意命令或连接生产主机。

## 验收与限制

- 通过 27 项本地自动化测试。在 Linux Docker 上验证了真实 Prometheus 抓取、权限隔离和失败补偿。发布包不包含测试服务器地址、密钥、运行数据库或验收日志。
- 这是实验环境预览版。LobeHub 登录和完整的 LobeHub → OpenBot 原生链路尚未通过实机验收。原生连接需要有效的 CopilotKit Intelligence 项目凭证，以及能够签发 OpenBot API 凭证的登录配置。DeepSeek 模型密钥不能替代它们。

## 开始使用

在 Linux Docker Engine 28+、Compose v2 和 Node.js 24 的主机上，按部署手册执行 `init`、`check`、`up-core`、`probe-core`。配置所需上游凭证再执行原生链路验收。服务默认仅内部或回环访问；`down` 保留数据卷。升级或备份时请保留原有密钥和数据卷，不要重新初始化已有数据库。
