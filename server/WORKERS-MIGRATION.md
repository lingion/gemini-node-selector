# Gemini Node Selector on GitHub Actions and Cloudflare Workers

## Decision

The probe engine must run inside a Linux environment. It launches `mihomo`, creates local SOCKS listeners, uses SQLite, and performs the Google checks through each candidate proxy. A plain Worker cannot replace that runtime without reimplementing the supported proxy protocols.

The production path therefore runs the existing Node probe service on a GitHub-hosted runner, generates a checked artifact, and deploys that artifact to a normal Cloudflare Worker. The existing `nodaroo-sub` Worker remains the public subscription facade and fallback cache.

```text
Clash / admin client
        |
        v
existing nodaroo-sub Worker  ---- fallback YAML cache
        |
        v
gns-edge Worker
        |
        v
GitHub Actions scheduled probe (Node 24 + mihomo + SQLite)
        |
        +-- airport subscriptions
        +-- mihomo per-node probes
        +-- Google / IP intelligence checks
        +-- generated YAML and node ledger
```

## Why this shape fits the current code

- `src/probe_runner.mjs` requires `child_process`, `net`, temporary files, and a Linux `mihomo` binary.
- `src/storage.mjs` uses `node:sqlite` and a persistent filesystem path.
- `src/main.mjs` and `scripts/generate-once.mjs` accept `GNS_TOKEN`, `GNS_ADMIN_TOKEN`, `GNS_SOURCES_JSON`, `GNS_AI_STUDIO_API_KEY`, and `GNS_ANTIGRAVITY_TOKEN` from the GitHub Actions environment.
- The GitHub runner uses the same Linux Node 24 + mihomo runtime for every scheduled probe, so no local Mac or paid Cloudflare Container is required.
- `nodaroo-sub` already serves the last-known-good YAML when the live origin is unavailable. Its current public fallback was verified on November 26, 2026 and returned 98,354 bytes with `x-gns-origin: worker-fallback-cache`.

## Files added or changed

- `scripts/generate-once.mjs`: runs the existing full probe pipeline and writes generated YAML plus the node ledger into the Worker module.
- `edge-worker/index.js`: serves the generated YAML and ledger through the Cloudflare Worker.
- `wrangler.jsonc`: declares the `gns.qdp.qzz.io/*` Worker Route.
- `src/main.mjs`: adds runtime environment overrides while preserving local JSON defaults.

## Secrets required before deployment

Set these as GitHub repository secrets. Do not commit them:

- `GNS_TOKEN`: subscription token used by `/sub/<token>` and `/status/<token>`.
- `GNS_ADMIN_TOKEN`: admin token used by `/admin/nodes` and `/admin/refresh`.
- `GNS_SOURCES_JSON`: JSON source configuration containing the private subscription URLs and self-built node definitions.
- `GNS_AI_STUDIO_API_KEY`: optional authenticated AI Studio check.
- `GNS_ANTIGRAVITY_TOKEN`: optional authenticated `loadCodeAssist` check.

The source subscription URLs remain in `server/config/sources.json`; they should move to secrets or a protected binding before a production deployment if the Worker or image repository is shared.

## GitHub Actions deployment sequence

1. GitHub Actions checks out the repository and runs the seven Node tests.
2. The runner downloads and verifies the Linux AMD64 mihomo archive.
3. The runner runs `scripts/generate-once.mjs` with the source and probe secrets.
4. The runner deploys the generated edge Worker with `wrangler deploy`.
5. The `gns.qdp.qzz.io/*` Worker Route serves the generated YAML and ledger.
6. Verify `/healthz`, `/sub/<token>`, `/status/<token>`, and `/admin/nodes`.

The workflow is designed so the probe and Wrangler deploy run only on the GitHub-hosted runner. No local Docker daemon or local mihomo artifact is required.
