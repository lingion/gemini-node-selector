# Gemini Node Selector (服务器端三路聚合 · 真实出口探测 · 动态订阅系统)

根据 [Gemini-Node-Selector-服务器端动态订阅系统设计文档.md](file:///Users/lingion_k/Desktop/Gemini-Node-Selector-服务器端动态订阅系统设计文档.md) 部署于 **Nodaroo Pterodactyl 服务器 (`au2.nodaroo.fun` / `f4b18a67`)**，所有上游拉取、节点连接实测、多源 IP 情报与 Gemini/Antigravity 验证均在服务端无污染海外网络中完成，客户端只需订阅链接，不在本地 Mac 执行全量探测或改动本机代理客户端。

---

## 1. 服务器端架构与运行地址

- **运行环境**：Nodaroo VPS (`au2.nodaroo.fun`，`6144 MB` 内存，Debian Trixie，Node.js `v24.22.3` + `mihomo v1.19.34`)，与原有 Xray (`v26.11.9`, `:25843`, VLESS+REALITY) 并行守护运行，原有 Xray 配置与密钥保持不变。
- **公网订阅地址**（Cloudflare Worker 边缘入口，实时透传服务端动态 YAML 并保留降级缓存）：
  - **主订阅链接**：`https://sub.qdp.qzz.io/gemini-selector`
  - **备用短链接**：`https://sub.qdp.qzz.io/agg`
  - **实时状态接口**：`https://sub.qdp.qzz.io/gns-status`
- **服务端直连入口**（通过专用 Cloudflare Tunnel `nodaroo-gns` 转发至容器内 `127.0.0.1:8089`）：
  - 健康检查：`https://gns.qdp.qzz.io/healthz`
  - 状态摘要：`https://gns.qdp.qzz.io/status/<token>`
  - 节点台账页面：`https://gns.qdp.qzz.io/admin/nodes?token=<token>`（支持 `?format=json`）
  - 手动触发全量复测：`POST https://gns.qdp.qzz.io/admin/refresh?token=<token>&reprobe=1`

---

## 2. 核心探测与整合能力（社区方案全量集成）

1. **三路来源与 HMAC 指纹**：
   - 上游来源：Airport-1 (Hysteria2)、Airport-2 (Trojan/VLESS)、自建悉尼 (`16.179.53.161:25843` VLESS+REALITY)。
   - 使用带密钥的 HMAC-SHA256 节点指纹，日志与公开接口不暴露明文 UUID、密码或上游订阅地址。
2. **双源真实出口 IP 共识 + 多源权威情报分级**：
   - 通过独立隔离的 `mihomo v1.19.34` 进程经待测节点访问 `api.ipify.org` 与 `icanhazip.com`（冲突时启用 `cloudflare.com/cdn-cgi/trace` 三方裁决）。
   - 聚合 `PTR`、Team Cymru BGP Origin ASN、RIR `RDAP`、`PeeringDB`、`api.country.is` 与 `ip-api`，按 A/B/C/D 证据等级自动命名；仅 A/B 级生成机房分组，避免凭空编造机房。
3. **多维度 Gemini / AI Studio / Antigravity 联合判定**：
   - **AI Studio REST API 预检**：访问 `generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=x`，区分 `INVALID_ARGUMENT`（地域放行）与 `FAILED_PRECONDITION`（地域受限）。
   - **Gemini Web `/app` 与特征码检测**：访问 `https://gemini.google.com/app` 与 `/`，核验 `HTTP 200`、最终路径 `/app`、功能开关 `45631641`、Google 注入三位地区码（严格剔除 `CHN`/`HKG`）及 `BardErrorInfo 1060` 封锁文本。
   - **Antigravity 与 Google 网关可达性**：测试 `oauth2.googleapis.com/token` 与 Google 搜索防人机状态。
4. **策略组、Antigravity 专项分流与零 DIRECT 防泄漏**：
   - `Gemini` 独立策略组及 `Gemini-自动选择`、`Gemini-故障转移` 仅收纳全部检测 `PASS` 节点（空池时使用 `REJECT` 占位，禁止隐式回退未验证节点或 `DIRECT`）。
   - `Gemini` 分流规则覆盖 `gemini.google.com`、`aistudio.google.com`、`generativelanguage.googleapis.com`、`alkalimakersuite-pa.googleapis.com`、`proactivebackend-pa.googleapis.com`、`daily-cloudcode-pa.googleapis.com`、`oauth2.googleapis.com`、`accounts.google.com`、`deepmind.com`、`deepmind.google`，且排在通用 Google 规则之前。
   - `广告拦截` 支持 `REJECT` / `PASS` / `国内直连` 切换，自定义白名单优先于黑名单。
   - 发布前执行结构审计与容器内原生 `mihomo -t` 校验；单飞请求合并 + 失败时保留上一份有效配置。

---

## 3. 工程目录与客户端辅助工具

- 服务端源码与单元测试：[server/src/](file:///Users/lingion_k/Documents/Codex/gemini-node-selector/server/src)、[server/tests/gns.test.mjs](file:///Users/lingion_k/Documents/Codex/gemini-node-selector/server/tests/gns.test.mjs)
- 容器守护入口：[server/supervisor_index.js](file:///Users/lingion_k/Documents/Codex/gemini-node-selector/server/supervisor_index.js)
- Worker 边缘反代部署脚本：[server/deploy_worker_proxy.py](file:///Users/lingion_k/Documents/Codex/gemini-node-selector/server/deploy_worker_proxy.py)
- 客户端辅助小道工具：
  - Chrome 内置 Gemini 解锁（修改 `Local State` 的 `variations_country` 与 `is_glic_eligible`）：[tools/unlock_chrome_gemini.py](file:///Users/lingion_k/Documents/Codex/gemini-node-selector/tools/unlock_chrome_gemini.py)
  - Antigravity 代理环境变量注入启动器（解决 Go `language_server` 忽略系统代理的问题）：[tools/launch_antigravity.sh](file:///Users/lingion_k/Documents/Codex/gemini-node-selector/tools/launch_antigravity.sh)
  - Cloudflare WARP MASQUE 链式分流配置模板：[tools/warp_masque_singbox_template.json](file:///Users/lingion_k/Documents/Codex/gemini-node-selector/tools/warp_masque_singbox_template.json)
