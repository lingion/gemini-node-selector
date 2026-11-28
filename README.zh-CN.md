<h1 align="center">中国特色社会主义节点选择器</h1>
<p align="center"><strong>SWCC Node Selector (Socialism with Chinese Characteristics Node Selector)</strong></p>
<p align="center">立足中国大陆实际网络环境，面向跨境学术科研、开发者国际协作与多云服务互联的云端节点质量观测与双内核（Mihomo / sing-box 1.12+）智能路由编排系统。</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

## 项目定位与背景

中国大陆拥有高度发达且独具特色的互联网基础设施与多运营商互联架构。在日常开发、国际学术文献检索、多云 API 联调以及跨境协作场景中，开发者常面临**国内服务绕路降速、国际科研与人工智能接口 TLS 握手异常、出口归属漂移以及客户端内核配置割裂**等工程痛点。

**中国特色社会主义节点选择器（SWCC Node Selector）** 立足于中国大陆真实网络生态，坚持“实事求是、以实测为准”的工程原则：所有出口链路质量均在云端通过隔离环境逐节点实测，拒绝依据静态名称臆断，同时向 **Mihomo** 与 **sing-box 1.12+** 双内核输出语义完全对齐、开箱即用的精细化分流配置。

## 核心特性

- **中国大陆场景深度定制**：国内局域网、主流中文互联网、`Microsoft@cn`、`Apple@cn` 及 Android FCM 推送通道优先「国内直连」，最大限度保障本土业务低延迟与稳定性；国际研发与科研服务按需精细分流。
- **Mihomo + sing-box 1.12+ 双内核全对齐**：一次云端实测同步产出 Mihomo YAML 与 sing-box 1.12+ JSON（完整支持远端 `.srs` 二进制规则集、1.12+ 新版 DNS 结构体、`default_domain_resolver` 与路由层域名嗅探），CI 阶段同时执行 `mihomo -t` 与 `sing-box check` 原生校验。
- **多维度服务可用性实测与失败关闭**：围绕 **GPT (OpenAI)**、**Claude**、**AntiGravity**、**Gemini**、**Google** 建立独立探测管线，自动剔除 TLS 握手重置（`ECONNRESET`）、443 超时、出口漂移与地区不兼容节点。
- **透明代理与现代化面板原生兼容**：内置 `mixed (7890)`、`redirect (7892)`、`tproxy (7893)`、DNS (`1053`)、域名嗅探与 `127.0.0.1:9090` 控制接口，适配 Linux/Android 端 TPROXY 透明代理（Box for Root / Surfing / AsteriskMETA）及 Zashboard 面板。

## 快速开始

在兼容客户端中添加部署者私下提供的远程配置地址，更新后启用规则模式即可：

- **Mihomo / Clash Meta 客户端**：`/sub/<token>`
- **sing-box 1.12+ 客户端**：`/singbox/<token>` 或 `/sub/<token>?format=singbox`
- **云端状态核对**：`/status/<token>`（查看 `generated_at`、实测活跃节点数及各业务严选池规模）

## 节点质量评估与严选机制

系统为每个候选节点启动隔离的临时探测实例，根据实测公网出口 IP、多源 IP 情报（国家/城市/ASN/机房置信等级）自动命名，并按业务敏感度分级入池：

| 目标服务 | 基础准入 / 硬探针条件 | 严选池附加要求 | 空池降级策略 |
| --- | --- | --- | --- |
| **GPT (OpenAI)** | 并发校验 5 个端点（`chatgpt.com`、`backend-api`、`api.openai.com`、`auth.openai.com`、移动端状态接口），过滤 TLS 握手断连（`ECONNRESET`）、443 超时、安全质询与地区 403 | 出口地区合规、多源出口 IP 一致、多轮稳定且 IPv6 清洁 | 顶层 `GPT` 回退通用选择，`GPT-严选` 失败关闭 |
| **Claude (Anthropic)** | 并发校验 4 个端点（`api.anthropic.com`、`claude.ai`、`platform.claude.com`、`sso.claude.com`） | 满足 Claude 支持地区白名单、出口 IP 一致稳定、IPv6 清洁 | 顶层 `Claude` 回退通用选择，`Claude-严选` 失败关闭 |
| **AntiGravity** | 通过 Gemini 基础门槛、后端可达、Google 无人机验证、IPv6 清洁、出口 IP 一致及至少两个一致的 Google 地区信号（配置令牌时加测 `loadCodeAssist`） | 多轮出口 IP 稳定，且 Google 地区与 IP 情报国家一致 | 严格失败关闭（`REJECT` / `action: reject`） |
| **Gemini** | API、网页 `/app`、功能标记与 OAuth 均通过且无地区限制，所有观测地区均在允许范围内 | Google 无人机验证、出口一致且稳定、IPv6 清洁、多源地区无冲突 | 严格失败关闭（`REJECT` / `action: reject`） |
| **Google** | 实测 HTTPS 可达 Google | Google 无人机验证且出口 IP 来源一致 | 严格失败关闭（`REJECT` / `action: reject`） |

## 中国大陆特色分流架构

| 流量类型 | 默认路由策略 |
| --- | --- |
| **局域网与本土直连** | 私有网段、`LAN` 与 `geosite:cn` 最先命中「国内直连」；所有海外业务规则之后再由 `geoip:cn` 兜底剩余国内 IP |
| **Microsoft 与 Apple** | 命中大陆子集（`microsoft@cn`、`apple@cn`）及明确的中国大陆域名（`azure.cn`、`apple.com.cn` 等）走「国内直连」；国际区服务分别归入「微软」「Apple」独立组 |
| **Android 推送（FCM）** | `googlefcm`、`fcm.googleapis.com` 与 `mtalk` 长连接先于宽泛 Google 规则命中「FCM」，默认「国内直连」，支持客户端随时切换 |
| **国际科研与开发服务** | 严格按优先级匹配：`AntiGravity` -> `Gemini` -> `Claude` -> `GPT` -> `YouTube` / `Google` / `Telegram` / `GitHub`；未匹配海外流量归入「漏网之鱼」（严禁泄漏至 `DIRECT`） |

完整规则实现见 [Mihomo 分组构建器](server/src/groups.mjs)、[sing-box 构建器](server/src/singbox.mjs) 及 [分流规则来源说明](server/RULE-SOURCES.md)。

## 云端自动刷新与双内核校验

GitHub Actions 按 `0 */6 * * *`（北京时间每天 **02:00、08:00、14:00、20:00**）自动调度全量实测：

1. 从 GitHub Secrets 读取私有上游源，经规范化与 HMAC 指纹去重生成候选集。
2. 逐节点实测真实出口 IP、ASN/机房属性及五类业务探针。
3. 同步渲染 Mihomo YAML 与 sing-box 1.12+ JSON，执行结构审计以及原生 `mihomo -t` 和 `sing-box check` 校验。
4. 校验通过后原子部署至 Cloudflare Workers 边缘节点。

本地开发与契约测试（需 Node.js 24）：

```bash
cd server && npm ci && node --test
```

## 维护者配置项

| 存储位置 | 配置项 | 说明 |
| --- | --- | --- |
| GitHub Actions Secrets | `GNS_SOURCES_JSON` | 私有上游节点源定义（需包含非空 `sources` 数组） |
| GitHub Actions Secrets | `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` | 部署边缘 Worker 并同步运行时密钥 |
| GitHub Actions Secrets | `GNS_EXTERNAL_URL`、`GNS_WORKER_ROUTE`、`GNS_WORKER_ZONE` | 边缘服务访问地址、Worker 路由规则与所属 Cloudflare Zone |
| GitHub Actions Secrets | `GNS_TOKEN`、`GNS_ADMIN_TOKEN` | `/sub`、`/singbox`、`/status` 与 `/admin/nodes` 访问鉴权令牌 |
| 可选 Secrets | `GNS_AI_STUDIO_API_KEY`、`GNS_ANTIGRAVITY_TOKEN` | 开启带凭据的 AI Studio 与 AntiGravity 深度探测 |

仓库中的 [sources.json](server/config/sources.json) 仅为空模板。所有真实上游地址、订阅令牌与生成产物均包含敏感凭据，切勿提交至公开仓库。

## 合规与使用声明

本项目为开源网络工程与多协议路由质量观测工具，旨在用于合法的跨境学术研究、国际开发者技术协作、多云网络链路测速与连通性质量治理。请使用者严格遵守所在地相关法律法规及目标服务的使用条款。

## 维护者配置

| 保存位置 | 配置项 | 用途 |
| --- | --- | --- |
| GitHub Actions Secrets | `GNS_SOURCES_JSON` | 私有上游订阅地址和自建节点定义。生成器要求 JSON 中含非空的 `sources` 数组 |
| GitHub Actions Secrets | `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN` | 向对应账号部署 Worker 并配置运行时密钥 |
| GitHub Actions Secrets | `GNS_EXTERNAL_URL`、`GNS_WORKER_ROUTE`、`GNS_WORKER_ZONE` | 服务地址、Worker 路由匹配模式和对应的 Cloudflare 区域。部署时由 runner 生成配置 |
| GitHub Actions Secrets | `GNS_TOKEN`、`GNS_ADMIN_TOKEN` | 边缘 Worker 的订阅、状态与管理访问凭据 |
| GitHub Actions Secrets，可选 | `GNS_AI_STUDIO_API_KEY`、`GNS_ANTIGRAVITY_TOKEN` | 对 AI Studio 和 AntiGravity 追加带凭据的探测 |
| 订阅入口 Worker 的 Secrets | `GNS_PUBLIC_TOKEN`、`GNS_EDGE_TOKEN` | 前者验证客户端，后者用于入口向边缘 Worker 取订阅，应与边缘的 `GNS_TOKEN` 对应 |

公开仓库中的 [sources.json](server/config/sources.json) 是空模板。真实订阅地址、带令牌的客户端链接和生成的节点 YAML 都含有访问凭据，请保存在私有配置中。

工作流与部署细节见 [GitHub Actions 配置](.github/workflows/deploy-gns-container.yml)和[架构说明](server/WORKERS-MIGRATION.md)。维护代码时，可在已安装 Node.js 24 和项目依赖的环境中进入 `server/`，执行 `node --test` 运行契约测试。
