import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from '../src/storage.mjs';
import { SourceFetcher } from '../src/sources.mjs';
import { Normalizer } from '../src/normalizer.mjs';
import { IpIntelligence } from '../src/ip_intel.mjs';
import { ProbeRunner } from '../src/probe_runner.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const settings = JSON.parse(fs.readFileSync(path.join(root, 'config/settings.json'), 'utf8'));
const rawSources = process.env.GNS_SOURCES_JSON;
if (!rawSources) {
  throw new Error('GNS_SOURCES_JSON is required; refusing to deploy with an empty or public source configuration');
}

let runtimeSources;
try {
  runtimeSources = JSON.parse(rawSources);
} catch (err) {
  throw new Error(`GNS_SOURCES_JSON is not valid JSON: ${err.message}`);
}
if (!runtimeSources || !Array.isArray(runtimeSources.sources) || runtimeSources.sources.length === 0) {
  throw new Error('GNS_SOURCES_JSON must contain at least one source; refusing to deploy an empty subscription');
}
const dataDir = path.join(root, 'data');
const binDir = path.join(root, 'bin');
fs.mkdirSync(dataDir, { recursive: true });
settings.server = {
  ...(settings.server || {}),
  token: process.env.GNS_TOKEN || settings.server?.token,
  admin_token: process.env.GNS_ADMIN_TOKEN || settings.server?.admin_token || process.env.GNS_TOKEN || settings.server?.token,
};
settings.probe = {
  ...(settings.probe || {}),
  ai_studio_api_key: process.env.GNS_AI_STUDIO_API_KEY || '',
  antigravity_access_token: process.env.GNS_ANTIGRAVITY_TOKEN || '',
};
settings.generated_yaml_path = path.join(dataDir, 'generated-probed.yaml');
Normalizer.setHmacSecret(settings.server?.hmac_secret || settings.server?.token || 'gns-default-hmac');

const mihomoBin = process.env.MIHOMO_BIN || path.join(binDir, 'mihomo');
const storage = new Storage(path.join(dataDir, 'state.sqlite3'));
const fetcher = new SourceFetcher(path.join(root, 'config/sources.json'), runtimeSources);
const ipIntel = new IpIntelligence(storage, settings.cache);
const probeRunner = new ProbeRunner({ mihomoBin, ipIntel, storage, settings });
const orchestrator = new Orchestrator({ fetcher, probeRunner, storage, mihomoBin, geodataDir: path.join(dataDir, 'mihomo-geodata'), settings });
const result = await orchestrator.generateSubscription({ forceRefresh: true, forceReprobe: true });
const nodes = storage.getAllNodes().map((node) => ({
  ...node,
  gemini_details: JSON.parse(node.gemini_details_json || '{}'),
  intel_sources: JSON.parse(node.intel_sources_json || '[]'),
}));
const edgeDir = path.join(root, 'edge-worker');
fs.mkdirSync(edgeDir, { recursive: true });
const generatedModule = 'export const generatedYaml = ' + JSON.stringify(result.yaml) + ';\n'
  + 'export const generatedStatus = ' + JSON.stringify(result.meta, null, 2) + ';\n'
  + 'export const generatedNodes = ' + JSON.stringify(nodes, null, 2) + ';\n';
fs.writeFileSync(path.join(edgeDir, 'generated.mjs'), generatedModule, 'utf8');
console.log(JSON.stringify({ meta: result.meta, nodes: nodes.length }));
