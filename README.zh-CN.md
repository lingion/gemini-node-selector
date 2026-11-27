<h1 align="center">Gemini Node Selector</h1>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Node.js%2024-417E38" alt="Node.js 24">
  <img src="https://img.shields.io/badge/proxy-mihomo-325B88" alt="mihomo">
  <img src="https://img.shields.io/badge/deploy-Cloudflare%20Workers-C45100" alt="Cloudflare Workers">
</p>

<p align="center">在云端实测代理节点，为 Mihomo 生成带有服务分组和国内分流规则的完整订阅。</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

## 快速开始

在支持 Mihomo 的客户端里添加远程配置，粘贴部署者私下提供的**完整订阅地址**，更新后启用规则模式。一份配置就包含节点、策略组和路由规则。要确认云端是否已生成新版本，可在部署者提供的状态页查看生成时间 `generated_at`、活跃节点数 `total_active_probed_nodes` 和各组严选数量。

## 节点怎么选


AntiGravity、Gemini 和 Google 各有四个子组：严选自动、严选故障转移、严选、非严选。顶层组默认用「严选自动」。只有备用节点通过时，默认用「非严选」；两池都空时返回 `REJECT`。「非严选」列出该服务所有达到基本门槛的节点，也包含严选节点。

| 服务 | 进入可用池的条件 | 进入严选池的附加条件 |
| --- | --- | --- |
| AntiGravity | 通过 Gemini 基本检查，后端可达，Google 无人机验证，IPv6 检查通过，各出口 IP 来源一致。至少两个 Google 地区信号一致且在允许范围内。配置了 OAuth 令牌时，还要通过 `loadCodeAssist` | 多轮出口 IP 稳定，且 Google 地区与 IP 情报国家一致 |
| Gemini | API、网页、功能标记和 OAuth 检查通过，无地区封锁。IP 情报国家和至少一个 Google 地区信号可识别，所有已识别地区均在允许范围内 | Google 无人机验证，各出口 IP 来源一致，多轮出口稳定，IPv6 检查通过，Google 地区信号无冲突 |
| Google | 实测 Google 可达 | Google 无人机验证，各出口 IP 来源一致 |

**Claude 单独筛选。** API、网页、开发者平台和单点登录四项探测都要通过，出口还须满足项目的 Claude 地区白名单、IP 来源一致、多轮稳定和 IPv6 检查。有严选节点时，顶层组依次列出「Claude-严选」「节点选择」「自动选择」。严选为空时，顺序变为「节点选择」「自动选择」「Claude-严选」。前两项仍可用，但普通节点的 Claude 可用性需要实际连接确认。

## 国内流量怎么走

| 流量 | 默认去向 |
| --- | --- |
| Microsoft、Apple 的大陆服务 | 命中中国子集或明确的大陆域名（如 `azure.cn`、`apple.com.cn`）时走「国内直连」。其余命中厂商规则的流量分别进入「微软」和「Apple」 |
| Android 推送（FCM） | 注册接口和 `mtalk` 长连接先匹配「FCM」，默认国内直连。可在客户端手动切换 |
| 国内及未匹配流量 | 局域网及 `GEOSITE,cn` 优先直连，后续由 `GEOIP,CN` 补充。最终未匹配的连接进入「漏网之鱼」，默认走「节点选择」 |

完整规则顺序见[分组实现](server/src/groups.mjs)，域名分类依据见[分流规则来源](server/RULE-SOURCES.md)。

## 云端刷新与排查

GitHub Actions 按 `0 */6 * * *` 调度，对应台北时间每天 **02:00、08:00、14:00、20:00**。Ubuntu runner 使用 Node.js 24 和 mihomo 拉取订阅、探测出口并校验 YAML。校验完成后，工作流将订阅和节点台账部署到 Cloudflare Workers。读者刷新订阅时直接读取上一次发布的结果。原 Nodaroo 服务器已退役。

- **客户端还是旧配置**：先看状态页的 `generated_at`。如果云端结果已更新，可在客户端手动刷新订阅。边缘 Worker 发出的 `profile-update-interval` 提示为 24 小时，客户端有自己的拉取周期。
- **需要立即重测**：在 GitHub Actions 的 **Deploy Gemini Node Selector Edge** 中选择 **Run workflow**。推送至 `main` 且涉及 `server/**` 或工作流文件也会触发一次运行。Worker 的 `/admin/refresh` 只返回调度说明。
- **检查服务状态**：在自己的 Worker 上访问 `/healthz` 查看生成时间。维护者可以通过 `x-admin-token` 请求头访问 `/admin/nodes` 查看逐节点结果。

## 维护者配置

| 保存位置 | 配置项 | 用途 |
| --- | --- | --- |
| GitHub Actions Secrets | `GNS_SOURCES_JSON` | 私有上游订阅地址和自建节点定义。生成器要求 JSON 中含非空的 `sources` 数组 |
| GitHub Actions Secrets | `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` | 向对应账号部署 Worker 并配置运行时密钥 |
| GitHub Actions Secrets | `GNS_TOKEN`、`GNS_ADMIN_TOKEN` | 边缘 Worker 的订阅、状态与管理访问凭据 |
| GitHub Actions Secrets，可选 | `GNS_AI_STUDIO_API_KEY`、`GNS_ANTIGRAVITY_TOKEN` | 对 AI Studio 和 AntiGravity 追加带凭据的探测 |
| 订阅入口 Worker 的 Secrets | `GNS_PUBLIC_TOKEN`、`GNS_EDGE_TOKEN` | 前者验证客户端，后者用于入口向边缘 Worker 取订阅，应与边缘的 `GNS_TOKEN` 对应 |

公开仓库中的 [sources.json](server/config/sources.json) 是空模板。真实订阅地址、带令牌的客户端链接和生成的节点 YAML 都含有访问凭据，请保存在私有配置中。

工作流与部署细节见 [GitHub Actions 配置](.github/workflows/deploy-gns-container.yml)和[架构说明](server/WORKERS-MIGRATION.md)。维护代码时，可在已安装 Node.js 24 和项目依赖的环境中进入 `server/`，执行 `node --test` 运行契约测试。
