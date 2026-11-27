<h1 align="center">Gemini Node Selector</h1>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Node.js%2024-417E38" alt="Node.js 24">
  <img src="https://img.shields.io/badge/proxy-mihomo-325B88" alt="mihomo">
  <img src="https://img.shields.io/badge/deploy-Cloudflare%20Workers-C45100" alt="Cloudflare Workers">
</p>

<p align="center">Probe proxy nodes in the cloud and generate a Mihomo profile with service-specific pools and routing rules for mainland China.</p>

<p align="center"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

## Quick start

Add a remote profile in a Mihomo-compatible client. Paste the **full subscription URL** supplied privately by your deployment operator, refresh the profile, and enable rule mode. One profile includes the nodes, policy groups, and routing rules. The operator's status page shows the generation time (`generated_at`), active node count (`total_active_probed_nodes`), and strict pool sizes.

## How nodes qualify

AntiGravity, Gemini, and Google each have four selectors. The default is `严选自动` (automatic selection among strict nodes). If only fallback nodes qualify, the group defaults to `非严选`, which lists every node that meets the service minimum. If none qualify, the group returns `REJECT`.

| Service | Minimum for inclusion | Additional requirements for the strict pool |
| --- | --- | --- |
| AntiGravity | Pass the Gemini minimum, reach the backend, clear the Google challenge and IPv6 checks, obtain matching exit IPs across sources and at least two consistent Google region signals. With an OAuth token configured, pass the authenticated Code Assist probe. | Exit IP stays stable across rounds and the Google region matches the IP intelligence country. |
| Gemini | Pass the API, web app, feature flag, and OAuth checks. No regional block. The IP country and at least one Google region signal must be known, and all observed countries must be allowed. | No Google challenge, consistent exit IP across sources and rounds, clean IPv6 check, and no conflicting Google region signals. |
| Google | Reach Google through the candidate node. | No Google challenge and matching exit IPs across sources. |

**Claude has a separate strict pool.** The API, web app, developer platform, and SSO probes must all pass. The node must also meet the project's Claude country allowlist, exit IP consensus and stability checks, and IPv6 check. The selector offers `Claude-严选`, `节点选择` (manual), and `自动选择` (automatic). If the strict pool is empty, manual and automatic move to the front. Those general nodes have no guarantee of Claude access.

## Mainland routing

| Traffic | Default route |
| --- | --- |
| Microsoft and Apple | Mainland subsets and explicit mainland service domains go direct. Other matching services use their respective vendor groups. |
| Firebase Cloud Messaging | Registration and Android push connections match the FCM group before broader Google rules. The group defaults to direct and can be changed in the client. |
| Domestic and unmatched traffic | LAN and `GEOSITE,cn` match early. `GEOIP,CN` catches remaining mainland IPs. Unmatched connections use `漏网之鱼`, which defaults to the node selector. |

See the [rule implementation](server/src/groups.mjs) and [routing sources](server/RULE-SOURCES.md).

## Refresh and troubleshooting

GitHub Actions schedules a full probe at 00:00, 06:00, 12:00, and 18:00 UTC. An Ubuntu runner uses Node.js 24 and mihomo to fetch sources, probe exits, and validate the YAML. It deploys the resulting profile and node ledger to Cloudflare Workers. Clients read the last published result. The former Nodaroo server has been retired.

- **Client shows an older profile.** Compare the status page's `generated_at` with your last client refresh. The edge Worker advertises a 24-hour client update interval. Refresh manually to fetch a newer published profile.
- **Run a new probe.** In GitHub Actions, open **Deploy Gemini Node Selector Edge** and choose **Run workflow**. A push to `main` affecting `server/**` or the workflow also triggers a run. The Worker's `/admin/refresh` endpoint reports the schedule.
- **Inspect a deployment.** Its Worker exposes generation time at `/healthz`. Maintainers can inspect per-node results at `/admin/nodes` with the `x-admin-token` header.

## Operator configuration

| Store | Names | Purpose |
| --- | --- | --- |
| GitHub Actions secrets | `GNS_SOURCES_JSON` | Private upstream configuration. The generator requires a nonempty `sources` array. |
| GitHub Actions secrets | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Deploy the Worker and configure runtime secrets. |
| GitHub Actions secrets | `GNS_TOKEN`, `GNS_ADMIN_TOKEN` | Authenticate subscription, status, and administrative requests to the edge Worker. |
| Optional GitHub Actions secrets | `GNS_AI_STUDIO_API_KEY`, `GNS_ANTIGRAVITY_TOKEN` | Enable authenticated AI Studio and AntiGravity probes. |
| Subscription facade Worker secrets, when used | `GNS_PUBLIC_TOKEN`, `GNS_EDGE_TOKEN` | Authenticate the client and the upstream request respectively. The latter matches the edge Worker's `GNS_TOKEN`. |

The tracked [source configuration](server/config/sources.json) is an empty template. Keep upstream URLs, personal subscription links, and generated node profiles private.

See the [Actions workflow](.github/workflows/deploy-gns-container.yml) and [architecture notes](server/WORKERS-MIGRATION.md). To run the contract tests with Node.js 24 and project dependencies installed, run `node --test` from `server/`.
