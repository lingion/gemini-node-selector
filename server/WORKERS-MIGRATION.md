# Gemini Node Selector on Cloudflare Containers

## Decision

The probe engine must run inside a Linux container. It launches `mihomo`, creates local SOCKS listeners, uses SQLite, and performs the Google checks through each candidate proxy. A plain Worker cannot replace that runtime without reimplementing the supported proxy protocols.

The migration therefore keeps the existing Node probe service and moves it into a Cloudflare Container. A Worker with a Durable Object Container binding becomes the public control plane and scheduled refresh trigger. The existing `nodaroo-sub` Worker remains the public subscription facade and fallback cache.

```text
Clash / admin client
        |
        v
existing nodaroo-sub Worker  ---- fallback YAML cache
        |
        v
new gns-container Worker
        |
        v
Durable Object -> Cloudflare Container (Node 24 + mihomo + SQLite)
        |
        +-- airport subscriptions
        +-- mihomo per-node probes
        +-- Google / IP intelligence checks
        +-- generated YAML and node ledger
```

## Why this shape fits the current code

- `src/probe_runner.mjs` requires `child_process`, `net`, temporary files, and a Linux `mihomo` binary.
- `src/storage.mjs` uses `node:sqlite` and a persistent filesystem path.
- `src/main.mjs` now accepts `GNS_HOST`, `GNS_PORT`, `GNS_TOKEN`, `GNS_ADMIN_TOKEN`, `GNS_AI_STUDIO_API_KEY`, and `GNS_ANTIGRAVITY_TOKEN` from the container environment.
- The container uses the `standard-2` instance size because the existing Nodaroo service was provisioned with 6 GiB and runs up to five concurrent probe workers.
- `nodaroo-sub` already serves the last-known-good YAML when the live origin is unavailable. Its current public fallback was verified on November 26, 2026 and returned 98,354 bytes with `x-gns-origin: worker-fallback-cache`.

## Files added or changed

- `Dockerfile`: builds a Linux AMD64 image, installs Node dependencies, downloads the pinned mihomo release, and verifies its SHA-256 before installation.
- `worker/index.js`: starts and health-checks the container, forwards API requests, and triggers an asynchronous refresh every 15 minutes.
- `wrangler.jsonc`: declares the Durable Object Container binding and the 15-minute Cron Trigger.
- `src/main.mjs`: adds runtime environment overrides while preserving local JSON defaults.

## Secrets required before deployment

Set these as Worker secrets or container environment bindings. Do not commit them:

- `GNS_TOKEN`: subscription token used by `/sub/<token>` and `/status/<token>`.
- `GNS_ADMIN_TOKEN`: admin token used by `/admin/nodes` and `/admin/refresh`.
- `GNS_AI_STUDIO_API_KEY`: optional authenticated AI Studio check.
- `GNS_ANTIGRAVITY_TOKEN`: optional authenticated `loadCodeAssist` check.

The source subscription URLs remain in `server/config/sources.json`; they should move to secrets or a protected binding before a production deployment if the Worker or image repository is shared.

## GitHub Actions deployment sequence

1. GitHub Actions checks out the repository and runs the seven Node tests.
2. The runner downloads and verifies the Linux AMD64 mihomo archive.
3. The runner builds the image with Docker and runs `wrangler deploy`.
4. The `gns.qdp.qzz.io/*` Worker Route sends requests to the new Container Worker.
5. The workflow writes the four Worker secrets from GitHub repository secrets.
6. Verify `/healthz`, `/sub/<token>`, `/status/<token>`, `/admin/nodes`, and an asynchronous `/admin/refresh?reprobe=1`.

The workflow is designed so Docker and Wrangler run only on the GitHub-hosted runner. No local Docker daemon or local mihomo artifact is required.
