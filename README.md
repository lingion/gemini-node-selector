<h1 align="center">SWCC Node Selector</h1>
<p align="center"><strong>Socialism with Chinese Characteristics Node Selector · 中国特色社会主义节点选择器</strong></p>
<p align="center">Cloud-probed dual-core (Mihomo &amp; sing-box 1.12+) network routing and edge node quality orchestration system tailored for the Mainland China network environment.</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

## Overview

**SWCC Node Selector** is an automated network observability, route-splitting, and configuration orchestration project engineered specifically for the real-world network conditions of Mainland China. Designed to support cross-border academic research, international developer collaboration, and multi-cloud service reliability, it continuously verifies egress quality in the cloud and compiles validated profiles for both **Mihomo** and **sing-box 1.12+**.

Key capabilities:

- **Dual-core profile parity:** Generates synchronized **Mihomo YAML** and **sing-box 1.12+ JSON** (using remote `.srs` rule sets, modern DNS server structs, `default_domain_resolver`, and action-based sniffing) from a single probe pass, verified natively by `mihomo -t` and `sing-box check`.
- **Mainland-first traffic governance:** Prioritizes domestic direct routing for LAN, Mainland domains/IPs, localized Microsoft/Apple Mainland services, and Android FCM push channels to minimize latency and avoid unnecessary international hops.
- **Multi-service egress verification:** Independently probes egress IP consensus, multi-round stability, IPv6 cleanliness, TLS handshake integrity, and service-level availability for international developer and AI research platforms (**OpenAI / GPT**, **Claude**, **Gemini**, **AntiGravity**, and **Google**).
- **Transparent proxy ready:** Exposes `mixed` (`7890`), `redirect` (`7892`), `tproxy` (`7893`), DNS (`1053`), domain sniffing, and Clash API (`127.0.0.1:9090`) out of the box for Linux/Android TPROXY deployments (e.g., Box for Root, Surfing, AsteriskMETA, Zashboard).

## Quick start

Paste the private profile URL provided by your deployment operator into a compatible client and enable rule mode:

- **Mihomo / Clash Meta clients:** `/sub/<token>`
- **sing-box 1.12+ clients:** `/singbox/<token>` or `/sub/<token>?format=singbox`
- **Deployment status:** `/status/<token>` (returns `generated_at`, active node count, and per-service strict pool sizes)

## Service quality gates

All candidate nodes are probed through isolated single-node runtime instances. Nodes are named from verified egress IP and facility intelligence rather than unverified upstream labels.

| Service | Minimum / Hard Gate | Strict Pool Requirements | Empty-Pool Behavior |
| --- | --- | --- | --- |
| **GPT (OpenAI)** | Concurrent 5-endpoint TLS & reachability check (`chatgpt.com`, `backend-api`, `api.openai.com`, `auth.openai.com`, mobile status); rejects TLS `ECONNRESET`, 443 timeouts, Cloudflare challenges, and regional 403s. | Non-blocked egress country, exit IP consensus, multi-round IP stability, and clean IPv6 check. | Top-level `GPT` falls back to general selection; `GPT-严选` fails closed. |
| **Claude (Anthropic)** | Concurrent 4-endpoint probe (`api.anthropic.com`, `claude.ai`, `platform.claude.com`, `sso.claude.com`). | Claude country allowlist, exit IP consensus, multi-round stability, and clean IPv6 check. | Top-level `Claude` falls back to general selection; `Claude-严选` fails closed. |
| **AntiGravity** | Passes Gemini minimum, backend reachability, clean Google Search, IPv6 check, exit IP consensus, and at least two consistent Google region signals (plus authenticated `loadCodeAssist` when token is provided). | Stable exit IP across rounds and Google region matching IP intelligence country. | Fails closed (`REJECT` / `action: reject`). |
| **Gemini** | Passes API, `/app` web check, feature flag, and OAuth reachability with no regional block; all observed countries must be allowed. | Clean Google Search, consistent and stable exit IP, clean IPv6, and non-conflicting Google region signals. | Fails closed (`REJECT` / `action: reject`). |
| **Google** | Candidate node reaches Google over HTTPS. | Clean Google Search and exit IP consensus. | Fails closed (`REJECT` / `action: reject`). |

## Mainland China routing architecture

| Traffic Category | Default Routing Policy |
| --- | --- |
| **LAN & Mainland Direct** | Private CIDRs, `LAN`, and `geosite:cn` match early and route to `国内直连` (`DIRECT`); `geoip:cn` catches remaining domestic IP traffic after all service rules. |
| **Microsoft & Apple** | Mainland subsets (`microsoft@cn`, `apple@cn`) and explicit `.cn` / `.com.cn` endpoints stay `国内直连`; global endpoints route through dedicated `微软` and `Apple` groups. |
| **Android Push (FCM)** | `googlefcm`, `fcm.googleapis.com`, and `mtalk` persistent endpoints match `FCM` before broad Google rules, defaulting to `国内直连` and switchable in the client. |
| **International Developer & AI Services** | Strictly ordered: `AntiGravity` -> `Gemini` -> `Claude` -> `GPT` -> `YouTube` / `Google` / `Telegram` / `GitHub`. Unmatched overseas traffic enters `漏网之鱼` (never leaks to `DIRECT`). |

See [Mihomo builder](server/src/groups.mjs), [sing-box builder](server/src/singbox.mjs), and [routing sources](server/RULE-SOURCES.md).

## Cloud refresh & verification

GitHub Actions runs a scheduled full probe every 6 hours (`00:00`, `06:00`, `12:00`, `18:00` UTC) on Ubuntu with Node.js 24, Linux `mihomo`, and Linux `sing-box`:

1. Fetches private upstream sources from Secrets and normalizes/deduplicates candidate nodes via HMAC fingerprints.
2. Probes egress IP, ASN/facility metadata, and all service quality gates.
3. Compiles both Mihomo YAML and sing-box 1.12+ JSON, runs structural audits plus native `mihomo -t` and `sing-box check`.
4. Publishes verified artifacts to Cloudflare Workers.

To run the local contract test suite (Node.js 24):

```bash
cd server && npm ci && node --test
```

## Operator configuration

| Store | Names | Purpose |
| --- | --- | --- |
| GitHub Actions Secrets | `GNS_SOURCES_JSON` | Private upstream subscription and self-hosted node definitions (non-empty `sources` array). |
| GitHub Actions Secrets | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Deploy the edge Worker and synchronize runtime secrets. |
| GitHub Actions Secrets | `GNS_EXTERNAL_URL`, `GNS_WORKER_ROUTE`, `GNS_WORKER_ZONE` | Private Worker URL, route pattern, and Cloudflare zone. |
| GitHub Actions Secrets | `GNS_TOKEN`, `GNS_ADMIN_TOKEN` | Authentication tokens for `/sub`, `/singbox`, `/status`, and `/admin/nodes`. |
| Optional Secrets | `GNS_AI_STUDIO_API_KEY`, `GNS_ANTIGRAVITY_TOKEN` | Enable authenticated AI Studio and AntiGravity checks. |

The tracked [sources.json](server/config/sources.json) is an empty template. Keep upstream credentials and personal profile URLs strictly private.

## Compliance & usage statement

This project is an open-source network engineering and multi-protocol routing orchestration tool intended solely for lawful network quality measurement, cross-border academic research, and enterprise/developer multi-cloud connectivity optimization. Users are responsible for complying with applicable local laws, regulations, and service terms.
