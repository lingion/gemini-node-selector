import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureServerBinaries } from './bootstrap.mjs';
import { Storage } from './storage.mjs';
import { SourceFetcher } from './sources.mjs';
import { Normalizer } from './normalizer.mjs';
import { IpIntelligence } from './ip_intel.mjs';
import { ProbeRunner } from './probe_runner.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { createApiServer } from './api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

async function main() {
  const settingsPath = path.join(ROOT_DIR, 'config', 'settings.json');
  const sourcesPath = path.join(ROOT_DIR, 'config', 'sources.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const runtimeSources = process.env.GNS_SOURCES_JSON
    ? JSON.parse(process.env.GNS_SOURCES_JSON)
    : null;

  // Container deployments provide runtime values through secrets/environment
  // bindings. Keep the checked-in JSON usable for local development while
  // allowing Cloudflare Containers to bind the listener and credentials.
  settings.server = {
    ...(settings.server || {}),
    host: process.env.GNS_HOST || settings.server?.host || '127.0.0.1',
    port: Number(process.env.GNS_PORT || settings.server?.port || 8089),
    token: process.env.GNS_TOKEN || settings.server?.token,
    admin_token: process.env.GNS_ADMIN_TOKEN || settings.server?.admin_token || process.env.GNS_TOKEN || settings.server?.token,
  };
  settings.probe = {
    ...(settings.probe || {}),
    ai_studio_api_key: process.env.GNS_AI_STUDIO_API_KEY || settings.probe?.ai_studio_api_key || '',
    antigravity_access_token: process.env.GNS_ANTIGRAVITY_TOKEN || settings.probe?.antigravity_access_token || '',
  };

  const dataDir = path.join(ROOT_DIR, 'data');
  const binDir = path.join(ROOT_DIR, 'bin');
  const geodataDir = path.join(dataDir, 'mihomo-geodata');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(geodataDir, { recursive: true });

  settings.generated_yaml_path = path.join(dataDir, 'generated-probed.yaml');
  Normalizer.setHmacSecret(settings.server?.hmac_secret || settings.server?.token || 'gns-default-hmac');

  const { mihomoBin } = await ensureServerBinaries(binDir, false);
  const storage = new Storage(path.join(dataDir, 'state.sqlite3'));
  const fetcher = new SourceFetcher(sourcesPath, runtimeSources);
  const ipIntel = new IpIntelligence(storage, settings.cache);
  const probeRunner = new ProbeRunner({ mihomoBin, ipIntel, storage, settings });
  const orchestrator = new Orchestrator({ fetcher, probeRunner, storage, mihomoBin, geodataDir, settings });

  const host = settings.server?.host || '127.0.0.1';
  const port = Number(settings.server?.port || 8089);
  const server = createApiServer({ orchestrator, storage, settings });

  server.listen(port, host, () => {
    console.log(`[gns] Server listening on http://${host}:${port}`);
    // Initial warm-up probe in background
    orchestrator.generateSubscription({ forceRefresh: true }).catch((err) => {
      console.error('[gns] Initial probe error:', err.message);
    });
  });

  // Periodic background refresh follows the configured upstream TTL.
  const intervalMs = (settings.cache?.upstream_ttl_seconds || 21600) * 1000;
  setInterval(() => {
    orchestrator.generateSubscription({ forceRefresh: true }).catch((err) => {
      console.error('[gns] Scheduled refresh error:', err.message);
    });
  }, intervalMs).unref();
}

main().catch((err) => {
  console.error('[gns] Fatal startup error:', err);
  process.exit(1);
});
