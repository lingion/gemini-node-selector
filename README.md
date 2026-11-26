# Gemini Node Selector

Node selector and dynamic Mihomo subscription generator for Gemini, AntiGravity, Claude, Microsoft, Apple, FCM, Google and domestic traffic.

The probe pipeline runs in GitHub Actions on a Linux runner. It downloads and verifies mihomo, fetches the private source configuration from GitHub Secrets, probes each candidate through mihomo, and deploys the generated subscription plus node ledger to the Cloudflare Worker at `gns.qdp.qzz.io`.

The public subscription facade remains `sub.qdp.qzz.io`. It keeps its fallback cache and forwards the Gemini selector routes to the generated edge Worker.

## Routing groups

- `AntiGravity`: strict and fallback pools, with Google internal geo agreement, stable exit, clean IPv6, backend reachability and optional `loadCodeAssist` verification.
- `Gemini`: strict and fallback pools, with AI Studio, Gemini `/app`, feature flag, OAuth and region checks.
- `Claude`: hard strict pool only. It requires `api.anthropic.com`, `claude.ai`, `platform.claude.com` and `sso.claude.com` reachability, supported exit country, stable single exit and clean IPv6. It never falls back to Gemini or a generic AI group.
- `Microsoft`: separate group; Microsoft China geosite entries and explicit China domains are evaluated before the global Microsoft estate.
- `Apple`: separate group; Apple China geosite entries and explicit China domains are evaluated before global Apple, iCloud, App Store and CDN rules.
- `FCM`: separate group placed before broad Google rules, covering the FCM HTTPS and Android long-lived messaging endpoints.
- `Google`, `YouTube`, `Telegram`, `GitHub`, `AI-Other` and measured country, facility and ASN groups.
- `国内直连`: explicit domestic and LAN rules. The final match remains `漏网之鱼`, so unknown traffic never silently becomes DIRECT.

## Development

```bash
cd server
npm ci
node --test
```

The repository deliberately contains no real source subscription URLs, tunnel tokens, generated SQLite state or generated node YAML. Configure `GNS_SOURCES_JSON`, `GNS_TOKEN`, `GNS_ADMIN_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Secrets.

Rule sources and the Claude network hard gate are documented in [server/RULE-SOURCES.md](server/RULE-SOURCES.md). The deployment architecture is documented in [server/WORKERS-MIGRATION.md](server/WORKERS-MIGRATION.md).
