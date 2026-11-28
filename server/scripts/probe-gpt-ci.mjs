import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ProxyAgent, fetch } from 'undici';
import { Storage } from '../src/storage.mjs';
import { SourceFetcher } from '../src/sources.mjs';
import { Normalizer } from '../src/normalizer.mjs';
import { IpIntelligence } from '../src/ip_intel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const settings = JSON.parse(fs.readFileSync(path.join(root, 'config/settings.json'), 'utf8'));
const rawSources = process.env.GNS_SOURCES_JSON;
if (!rawSources) throw new Error('GNS_SOURCES_JSON is required');
const runtimeSources = JSON.parse(rawSources);

const dataDir = path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
Normalizer.setHmacSecret(settings.server?.hmac_secret || 'gns-gpt-probe');

const mihomoBin = process.env.MIHOMO_BIN || path.join(root, 'bin/mihomo');
const storage = new Storage(path.join(dataDir, 'gpt-probe.sqlite3'));
const fetcher = new SourceFetcher(path.join(root, 'config/sources.json'), runtimeSources);
const ipIntel = new IpIntelligence(storage, settings.cache);

const waitForPort = async (port, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.createConnection({ host: 'localhost', port });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
};

const ENDPOINTS = [
  { key: 'cf_trace', url: 'https://chatgpt.com/cdn-cgi/trace', method: 'GET' },
  { key: 'web_home', url: 'https://chatgpt.com/', method: 'GET' },
  { key: 'backend_models', url: 'https://chatgpt.com/backend-api/models', method: 'GET' },
  { key: 'api_models', url: 'https://api.openai.com/v1/models', method: 'GET' },
  { key: 'ios_status', url: 'https://ios.chat.openai.com/public-api/mobile/server_status/v1', method: 'GET' },
  { key: 'auth_home', url: 'https://auth.openai.com/', method: 'GET' },
];

function classifyError(err) {
  const cause = err?.cause || err;
  const code = String(cause?.code || err?.code || '');
  const msg = `${err?.message || ''} ${cause?.message || ''}`.trim();
  const low = `${code} ${msg}`.toLowerCase();
  if (
    low.includes('ssl') || low.includes('tls') || low.includes('cert') ||
    low.includes('eproto') || low.includes('handshake') || low.includes('cipher') ||
    low.includes('alpn') || low.includes('self_signed') || low.includes('unable_to_verify')
  ) {
    return { cat: 'SSL_TLS_ERROR', code, msg: msg.slice(0, 180) };
  }
  if (low.includes('timeout') || low.includes('aborted') || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT') {
    return { cat: 'TIMEOUT', code, msg: msg.slice(0, 180) };
  }
  if (low.includes('econnreset') || low.includes('socket') || low.includes('eof') || low.includes('closed') || low.includes('refused') || low.includes('terminated')) {
    return { cat: 'CONN_RESET_OR_EOF', code, msg: msg.slice(0, 180) };
  }
  return { cat: 'NET_OTHER', code, msg: msg.slice(0, 180) };
}

function classifyHttp(key, status, headers, body) {
  const cfMitigated = headers.get('cf-mitigated') || '';
  const cfRay = headers.get('cf-ray') || '';
  const server = headers.get('server') || '';
  const low = (body || '').toLowerCase();

  if (low.includes('unsupported_country_region_territory') || low.includes('unsupported_country') || low.includes('not available in your country')) {
    return 'GEO_UNSUPPORTED';
  }
  if (cfMitigated.toLowerCase().includes('challenge') || low.includes('just a moment') || low.includes('cf-chl') || low.includes('turnstile')) {
    return `CF_CHALLENGE_${status}`;
  }
  if (status === 403 && (low.includes('error 1020') || low.includes('access denied') || low.includes('security') || low.includes('unusual activity') || server.toLowerCase().includes('cloudflare'))) {
    return 'CF_OR_WAF_403';
  }
  if (status === 429) return 'RATE_LIMIT_429';
  if (status === 403) return 'HTTP_403_OTHER';
  if (key === 'api_models' && status === 401) return 'OK_401_AUTH_REQUIRED';
  if (key === 'backend_models' && (status === 200 || status === 401)) return `OK_${status}`;
  if (status >= 200 && status < 400) return `OK_${status}`;
  return `HTTP_${status}`;
}

async function probeEndpoint(agent, ep) {
  const t0 = Date.now();
  try {
    const r = await fetch(ep.url, {
      method: ep.method,
      dispatcher: agent,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/json,text/html,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    const body = (await r.text().catch(() => '')).slice(0, 1000);
    const cat = classifyHttp(ep.key, r.status, r.headers, body);
    const extra = {};
    if (ep.key === 'cf_trace') {
      extra.loc = (body.match(/^loc=(.+)$/m) || [])[1]?.trim() || null;
      extra.colo = (body.match(/^colo=(.+)$/m) || [])[1]?.trim() || null;
      extra.tls = (body.match(/^tls=(.+)$/m) || [])[1]?.trim() || null;
      extra.warp = (body.match(/^warp=(.+)$/m) || [])[1]?.trim() || null;
    }
    return {
      ok: cat.startsWith('OK_'),
      cat,
      status: r.status,
      ms: Date.now() - t0,
      cf_mitigated: r.headers.get('cf-mitigated') || null,
      location: r.headers.get('location')?.slice(0, 100) || null,
      ...extra,
      snippet: cat.startsWith('OK_') ? '' : body.replace(/\s+/g, ' ').slice(0, 140),
    };
  } catch (err) {
    const e = classifyError(err);
    return {
      ok: false,
      cat: e.cat,
      status: null,
      ms: Date.now() - t0,
      err_code: e.code,
      err_msg: e.msg,
    };
  }
}

async function probeOne(nodeMeta, workerId) {
  const port = 34000 + workerId;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `gpt-w${workerId}-`));
  const probeNode = structuredClone(nodeMeta.node);
  probeNode.name = 'candidate';
  const cfg = {
    'mixed-port': port,
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'silent',
    ipv6: false,
    dns: { enable: true, 'enhanced-mode': 'fake-ip', nameserver: ['1.1.1.1', '8.8.8.8'] },
    proxies: [probeNode],
    rules: ['MATCH,candidate'],
  };
  fs.writeFileSync(path.join(workDir, 'config.yaml'), yaml.dump(cfg, { lineWidth: -1 }), 'utf8');

  let proc = null;
  let agent = null;
  const out = {
    name: nodeMeta.raw_name || nodeMeta.node?.name || 'unknown',
    source: nodeMeta.source_id,
    type: nodeMeta.node?.type,
    skip_cert_verify: Boolean(nodeMeta.node?.['skip-cert-verify']),
    country: null,
    asn: null,
    as_name: null,
    is_dc: null,
    egress_ok: false,
    endpoints: {},
  };

  try {
    proc = spawn(mihomoBin, ['-d', workDir], { stdio: 'ignore' });
    const ready = await waitForPort(port, 7000);
    if (!ready) {
      out.fatal = 'MIHOMO_START_TIMEOUT';
      return out;
    }
    agent = new ProxyAgent(`http://localhost:${port}`);

    // Egress IP check
    let ip = null;
    try {
      const r = await fetch('http://api.ipify.org', { dispatcher: agent, signal: AbortSignal.timeout(6000) });
      if (r.ok) ip = (await r.text()).trim();
    } catch {}
    if (!ip) {
      try {
        const r = await fetch('http://icanhazip.com', { dispatcher: agent, signal: AbortSignal.timeout(6000) });
        if (r.ok) ip = (await r.text()).trim();
      } catch {}
    }

    if (ip && net.isIP(ip)) {
      out.egress_ok = true;
      try {
        const intel = await ipIntel.query(ip);
        out.country = intel.country_code;
        out.asn = intel.asn;
        out.as_name = intel.as_name;
        out.is_dc = intel.is_datacenter;
      } catch {}
    }

    const resList = await Promise.all(ENDPOINTS.map((ep) => probeEndpoint(agent, ep)));
    ENDPOINTS.forEach((ep, idx) => { out.endpoints[ep.key] = resList[idx]; });
    return out;
  } finally {
    if (agent) await agent.close().catch(() => {});
    if (proc) {
      try { proc.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 150));
      try { proc.kill('SIGKILL'); } catch {}
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

const fetched = await fetcher.fetchAll();
const rawNodes = [];
for (const s of fetched.results) {
  for (const n of s.nodes || []) {
    rawNodes.push({ source_id: s.id, raw_name: n.name, node: n });
  }
}
const normalized = Normalizer.deduplicate(rawNodes);
console.log(`Fetched=${rawNodes.length}, Deduplicated=${normalized.length}`);

const CONCURRENCY = Number(process.env.GPT_PROBE_CONCURRENCY || 8);
const results = new Array(normalized.length);
let cursor = 0;

async function worker(wid) {
  while (true) {
    const idx = cursor++;
    if (idx >= normalized.length) break;
    results[idx] = await probeOne(normalized[idx], wid);
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, normalized.length) }, (_, i) => worker(i + 1)));

const summary = {};
for (const ep of ENDPOINTS) summary[ep.key] = {};
let fatalCnt = 0;
let egressFailCnt = 0;

for (const r of results) {
  if (r.fatal) { fatalCnt++; continue; }
  if (!r.egress_ok) egressFailCnt++;
  for (const ep of ENDPOINTS) {
    const cat = r.endpoints[ep.key]?.cat || 'MISSING';
    summary[ep.key][cat] = (summary[ep.key][cat] || 0) + 1;
  }
}

const report = {
  probed_at: new Date().toISOString(),
  total_nodes: results.length,
  fatal_nodes: fatalCnt,
  egress_fail_nodes: egressFailCnt,
  summary,
  nodes: results,
};

const outPath = path.join(dataDir, 'gpt-probe-report.json');
fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ total_nodes: results.length, fatal_nodes: fatalCnt, egress_fail_nodes: egressFailCnt, summary }, null, 2));
