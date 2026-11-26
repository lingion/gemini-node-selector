import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { ProxyAgent, fetch } from 'undici';

export const PROBE_VERSION = 3;

const BLOCK_TEXT_REGEX = /not supported in your country|country_unavailable|not available in your region|isn.?t currently supported in your country|BardErrorInfo[^0-9]*1060/i;

// Blocked countries/regions for Gemini & AntiGravity (ISO-2 & ISO-3)
export const BLOCKED_ISO2 = new Set(['CN', 'HK', 'MO', 'RU', 'BY', 'KP', 'IR', 'SY', 'CU']);
export const BLOCKED_ISO3 = new Set(['CHN', 'HKG', 'MAC', 'RUS', 'BLR', 'PRK', 'IRN', 'SYR', 'CUB']);

// Explicit whitelist of countries supported by Gemini & Gemini Code Assist / AntiGravity (ISO-2 -> ISO-3)
export const SUPPORTED_ISO2_TO_ISO3 = {
  US: 'USA', CA: 'CAN', GB: 'GBR', AU: 'AUS', NZ: 'NZL',
  JP: 'JPN', KR: 'KOR', SG: 'SGP', TW: 'TWN',
  DE: 'DEU', FR: 'FRA', NL: 'NLD', IE: 'IRL', CH: 'CHE',
  SE: 'SWE', FI: 'FIN', NO: 'NOR', DK: 'DNK', BE: 'BEL',
  AT: 'AUT', IT: 'ITA', ES: 'ESP', PT: 'PRT', PL: 'POL',
  CZ: 'CZE', RO: 'ROU', GR: 'GRC', HU: 'HUN',
  IN: 'IND', ID: 'IDN', MY: 'MYS', TH: 'THA', PH: 'PHL', VN: 'VNM',
  BR: 'BRA', MX: 'MEX', AR: 'ARG', CL: 'CHL', CO: 'COL',
  IL: 'ISR', AE: 'ARE', TR: 'TUR', ZA: 'ZAF',
};
export const SUPPORTED_ISO3 = new Set(Object.values(SUPPORTED_ISO2_TO_ISO3));

// Anthropic publishes a wider supported-region list than Gemini. Keep this
// separate so Claude does not inherit Gemini's narrower country allowlist.
export const CLAUDE_SUPPORTED_ISO2 = new Set([
  'AL','DZ','AD','AO','AG','AR','AM','AU','AT','AZ','BS','BH','BD','BB','BE','BZ','BJ','BT','BO','BA','BW','BR','BN','BG','BF','BI','CV','KH','CM','CA','TD','CL','CO','KM','CG','CR','CI','HR','CY','CZ','DK','DJ','DM','DO','EC','SV','GQ','EE','SZ','FJ','FI','FR','GA','GM','GE','DE','GH','GR','GD','GT','GN','GW','GY','HT','VA','HN','HU','IS','IN','ID','IQ','IE','IL','IT','JM','JP','JO','KZ','KE','KI','KW','KG','LA','LV','LB','LS','LR','LI','LT','LU','MG','MW','MY','MV','MT','MH','MR','MU','MX','FM','MD','MC','MN','ME','MA','MZ','NA','NR','NP','NL','NZ','NE','NG','MK','NO','OM','PK','PW','PS','PA','PG','PY','PE','PH','PL','PT','QA','RO','RW','KN','LC','VC','WS','SM','ST','SA','SN','RS','SC','SL','SK','SI','SB','ZA','KR','ES','LK','SR','SE','CH','TW','TJ','TZ','TH','TL','TG','TO','TT','TN','TR','TM','TV','UG','UA','AE','GB','US','UY','UZ','VU','ZM','ZW'
]);

const TERMS_COUNTRY_NAME_TO_ISO3 = {
  'united states': 'USA',
  'japan': 'JPN',
  'singapore': 'SGP',
  'taiwan': 'TWN',
  'australia': 'AUS',
  'united kingdom': 'GBR',
  'canada': 'CAN',
  'south korea': 'KOR',
  'korea': 'KOR',
  'germany': 'DEU',
  'netherlands': 'NLD',
  'france': 'FRA',
  'ireland': 'IRL',
  'switzerland': 'CHE',
  'sweden': 'SWE',
  'finland': 'FIN',
  'norway': 'NOR',
  'denmark': 'DNK',
  'belgium': 'BEL',
  'austria': 'AUT',
  'italy': 'ITA',
  'spain': 'ESP',
  'portugal': 'PRT',
  'poland': 'POL',
  'india': 'IND',
  'indonesia': 'IDN',
  'malaysia': 'MYS',
  'thailand': 'THA',
  'philippines': 'PHL',
  'vietnam': 'VNM',
  'new zealand': 'NZL',
  'brazil': 'BRA',
  'mexico': 'MEX',
  'israel': 'ISR',
  'united arab emirates': 'ARE',
  'turkey': 'TUR',
  'hong kong': 'HKG',
  'china': 'CHN',
  'macao': 'MAC',
  'macau': 'MAC',
  'russia': 'RUS',
  'belarus': 'BLR',
};

export function iso2ToIso3(code) {
  if (!code) return null;
  const up = String(code).trim().toUpperCase();
  if (up.length === 3) return up;
  if (SUPPORTED_ISO2_TO_ISO3[up]) return SUPPORTED_ISO2_TO_ISO3[up];
  const blockedMap = { CN: 'CHN', HK: 'HKG', MO: 'MAC', RU: 'RUS', BY: 'BLR', KP: 'PRK', IR: 'IRN', SY: 'SYR', CU: 'CUB' };
  return blockedMap[up] || null;
}

function extractGoogleCountry(html) {
  const m = html.match(/2,1,200,"([A-Z]{3})"/) || html.match(/\[1,null,null,\d+,\d+,"([A-Z]{3})"/);
  return m ? m[1] : null;
}

export function extractTermsCountry(html) {
  if (!html) return null;
  // Match "Country version: United States" or similar in policies.google.com/terms?hl=en
  const m1 = html.match(/Country version:\s*<[^>]*>([^<]+)</i) || html.match(/Country version:\s*([A-Za-z][A-Za-z\s.&'-]{1,40})/i);
  if (m1) {
    const key = m1[1].trim().toLowerCase().replace(/\s+/g, ' ');
    if (TERMS_COUNTRY_NAME_TO_ISO3[key]) return TERMS_COUNTRY_NAME_TO_ISO3[key];
  }
  const m2 = html.match(/data-country="([A-Z]{2})"/i) || html.match(/"countryCode"\s*:\s*"([A-Z]{2})"/i);
  if (m2) return iso2ToIso3(m2[1]);
  return null;
}

export function extractYoutubeGl(html) {
  if (!html) return null;
  const m = html.match(/"INNERTUBE_CONTEXT_GL"\s*:\s*"([A-Z]{2})"/i) || html.match(/"gl"\s*:\s*"([A-Z]{2})"/i);
  return m ? iso2ToIso3(m[1]) : null;
}

function hasGeminiFeatureFlag(html) {
  return html.includes('\\"45631641\\":true') || html.includes('"45631641":true') || html.includes('45631641,null,true');
}

/**
 * Pure deterministic tier classifier for Claude, AntiGravity (strictest), Gemini (medium) and Google (loosest).
 * Claude has its own hard gate and never falls back to a generic AI pool.
 */
export function evaluateNodeTiers({ countryCode, ipConsensus, ipStable, ipv6Clean, details }) {
  const intelIso3 = iso2ToIso3(countryCode);
  const intelBlocked = !countryCode || BLOCKED_ISO2.has(String(countryCode).toUpperCase());
  const intelSupported = Boolean(intelIso3 && SUPPORTED_ISO3.has(intelIso3));

  const geoSignals = [
    details.geo_gemini,
    details.geo_terms,
    details.geo_youtube,
    details.geo_search,
  ].filter(Boolean);
  const uniqueGeo = [...new Set(geoSignals)];
  const anyGeoBlocked = uniqueGeo.some((c) => BLOCKED_ISO3.has(c));
  const allGeoSupported = uniqueGeo.length > 0 && uniqueGeo.every((c) => SUPPORTED_ISO3.has(c));
  const multiSourceGeoConsistent = geoSignals.length >= 2 && uniqueGeo.length === 1 && allGeoSupported;

  // 1. Google tier (loosest, but must actually reach Google)
  let googleTier = 'FAIL';
  if (details.google_reachable) {
    googleTier = details.google_clean && ipConsensus ? 'STRICT' : 'FALLBACK';
  }

  // 2. Gemini tier (medium: fail-closed whitelist, requires API + Web /app + feature flag + OAuth)
  const geminiHardOk = Boolean(
    !details.region_blocked &&
    !intelBlocked &&
    intelSupported &&
    !anyGeoBlocked &&
    allGeoSupported &&
    details.api_supported &&
    details.web_app_ok &&
    details.feature_flag &&
    details.oauth_reachable
  );

  let geminiTier = 'FAIL';
  let geminiStatus = 'FAIL';
  if (details.region_blocked || intelBlocked || anyGeoBlocked || (uniqueGeo.length > 0 && !allGeoSupported)) {
    geminiStatus = 'FAIL_REGION';
  }
  if (geminiHardOk) {
    const geminiStrictOk = Boolean(
      details.google_clean &&
      ipConsensus &&
      ipStable &&
      ipv6Clean &&
      uniqueGeo.length === 1
    );
    geminiTier = geminiStrictOk ? 'STRICT' : 'FALLBACK';
    geminiStatus = 'PASS';
  }

  // 3. AntiGravity tier (strictest: requires Gemini pass + AntiGravity endpoints + clean Google + clean IPv6 + >=2 consistent internal Google geo sources + optional loadCodeAssist pass)
  const lcaStatus = details.load_code_assist_status || 'SKIPPED';
  const lcaOk = lcaStatus === 'SKIPPED' || lcaStatus === 'PASS';
  const antigravityHardOk = Boolean(
    geminiHardOk &&
    details.antigravity_endpoints_ok &&
    details.google_clean &&
    ipv6Clean &&
    ipConsensus &&
    multiSourceGeoConsistent &&
    lcaOk
  );

  let antigravityTier = 'FAIL';
  if (antigravityHardOk) {
    const geoMatchesIntel = intelIso3 && uniqueGeo[0] === intelIso3;
    antigravityTier = ipStable && geoMatchesIntel ? 'STRICT' : 'FALLBACK';
  }

  const claudeCountryOk = Boolean(
    countryCode &&
    !BLOCKED_ISO2.has(String(countryCode).toUpperCase()) &&
    CLAUDE_SUPPORTED_ISO2.has(String(countryCode).toUpperCase())
  );
  const claudeHardOk = Boolean(
    claudeCountryOk &&
    ipConsensus &&
    ipStable &&
    ipv6Clean &&
    details.claude_api_ok &&
    details.claude_web_ok &&
    details.claude_platform_ok &&
    details.claude_sso_ok
  );

  return {
    claude_tier: claudeHardOk ? 'STRICT' : 'FAIL',
    google_tier: googleTier,
    gemini_tier: geminiTier,
    antigravity_tier: antigravityTier,
    gemini_status: geminiStatus,
  };
}

function waitForPort(port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const attempt = () => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start >= timeoutMs) resolve(false);
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function isValidIp(text) {
  if (!text) return false;
  const s = text.trim();
  return net.isIP(s) !== 0;
}

/**
 * Isolated per-node Mihomo probe runner. Executes egress IP consensus checks and
 * multi-tier Gemini / AI Studio / Antigravity / Google Search verification.
 */
export class ProbeRunner {
  constructor({ mihomoBin, ipIntel, storage, settings = {} }) {
    this.mihomoBin = mihomoBin;
    this.ipIntel = ipIntel;
    this.storage = storage;
    this.maxWorkers = settings.probe?.max_workers || 5;
    this.basePort = settings.probe?.base_port || 28000;
    this.startupTimeoutMs = settings.probe?.startup_timeout_ms || 7000;
    this.httpTimeoutMs = settings.probe?.http_timeout_ms || 12000;
    this.stabilityDelayMs = settings.probe?.stability_delay_ms ?? 1200;
    this.aiStudioApiKey = settings.probe?.ai_studio_api_key || process.env.GNS_AI_STUDIO_API_KEY || '';
    this.antigravityAccessToken = settings.probe?.antigravity_access_token || process.env.GNS_ANTIGRAVITY_TOKEN || '';
    this.passTtl = settings.cache?.gemini_pass_ttl_seconds || 1800;
    this.failTtl = settings.cache?.gemini_fail_ttl_seconds || 600;
  }

  async probeSingleNode(nodeMeta, workerId, forceReprobe = false) {
    const node = nodeMeta.proxyDict;
    const fp = nodeMeta.fingerprint;
    const nowSec = Math.floor(Date.now() / 1000);

    // Check fresh DB cache if not forcing full reprobe
    if (!forceReprobe && this.storage) {
      const existing = this.storage.getNode(fp);
      if (existing && existing.egress_ip && existing.gemini_last_checked > 0) {
        const cachedDetails = JSON.parse(existing.gemini_details_json || '{}');
        const ttl = existing.gemini_status === 'PASS' ? this.passTtl : this.failTtl;
        if (cachedDetails.probe_version === PROBE_VERSION && nowSec - existing.gemini_last_checked < ttl) {
          return {
            success: true,
            cached: true,
            meta: nodeMeta,
            egress_ip: existing.egress_ip,
            ip_family: existing.ip_family,
            ip_consensus: Boolean(existing.ip_consensus),
            ip_stable: cachedDetails.ip_stable !== false,
            ipv6_egress: cachedDetails.ipv6_egress || null,
            ipv6_clean: cachedDetails.ipv6_clean !== false,
            country_code: existing.country_code,
            region: existing.region,
            city: existing.city,
            asn: existing.asn,
            as_name: existing.as_name,
            network_type: existing.network_type,
            is_datacenter: Boolean(existing.is_datacenter),
            facility_name: existing.facility_name,
            facility_confidence: existing.facility_confidence,
            intel_sources: JSON.parse(existing.intel_sources_json || '[]'),
            gemini_status: existing.gemini_status,
            gemini_tier: cachedDetails.gemini_tier || (existing.gemini_status === 'PASS' ? 'FALLBACK' : 'FAIL'),
            antigravity_tier: cachedDetails.antigravity_tier || 'FAIL',
            claude_tier: cachedDetails.claude_tier || 'FAIL',
            google_tier: cachedDetails.google_tier || (cachedDetails.google_reachable ? 'FALLBACK' : 'FAIL'),
            gemini_details: cachedDetails,
            duration_ms: existing.duration_ms,
          };
        }
      }
    }

    const startMs = Date.now();
    const port = this.basePort + workerId;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `gns-w${workerId}-`));
    const configPath = path.join(workDir, 'config.yaml');

    const probeNode = structuredClone(node);
    probeNode.name = 'candidate';
    // Inside the Nodaroo host container itself, route self-probe to container loopback if hairpin NAT is restricted
    if (probeNode.server === '16.179.53.161' && process.platform === 'linux' && fs.existsSync('/home/container/.xray-core-26.11.9/config.json')) {
      probeNode.server = '127.0.0.1';
    }

    const minimalCfg = {
      'mixed-port': port,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'silent',
      ipv6: false,
      dns: {
        enable: true,
        'enhanced-mode': 'fake-ip',
        nameserver: ['1.1.1.1', '8.8.8.8'],
      },
      proxies: [probeNode],
      rules: ['MATCH,candidate'],
    };
    fs.writeFileSync(configPath, yaml.dump(minimalCfg, { lineWidth: -1 }), 'utf8');

    const result = {
      success: false,
      cached: false,
      meta: nodeMeta,
      egress_ip: null,
      ip_family: 4,
      ip_consensus: false,
      ip_stable: false,
      ipv6_egress: null,
      ipv6_clean: true,
      country_code: 'XX',
      region: 'Unknown',
      city: 'Unknown',
      asn: 0,
      as_name: 'Unknown',
      network_type: 'unknown',
      is_datacenter: false,
      facility_name: 'Unknown',
      facility_confidence: 'D',
      intel_sources: [],
      gemini_status: 'FAIL_CLOSED',
      gemini_tier: 'FAIL',
      antigravity_tier: 'FAIL',
      google_tier: 'FAIL',
      gemini_details: {
        probe_version: PROBE_VERSION,
        api_supported: false,
        web_app_ok: false,
        web_root_ok: false,
        feature_flag: false,
        oauth_reachable: false,
        antigravity_endpoints_ok: false,
        claude_api_ok: false,
        claude_web_ok: false,
        claude_platform_ok: false,
        claude_sso_ok: false,
        load_code_assist_status: 'SKIPPED',
        google_reachable: false,
        google_clean: false,
        detected_country: null,
        geo_gemini: null,
        geo_terms: null,
        geo_youtube: null,
        geo_search: null,
        region_blocked: false,
        ip_stable: false,
        ipv6_egress: null,
        ipv6_clean: true,
        error: null,
      },
      duration_ms: 0,
    };

    let proc = null;
    let agent = null;
    try {
      proc = spawn(this.mihomoBin, ['-d', workDir], { stdio: 'ignore' });
      const ready = await waitForPort(port, this.startupTimeoutMs);
      if (!ready) {
        result.gemini_details.error = 'mihomo startup timeout';
        return result;
      }

      agent = new ProxyAgent(`http://127.0.0.1:${port}`);

      // 1. Real Egress IP Dual-Source Consensus (Section 3.2)
      const egressCheck = await this.probeEgressIp(agent);
      if (!egressCheck.ip) {
        result.gemini_details.error = 'egress IP unavailable';
        return result;
      }
      result.success = true;
      result.egress_ip = egressCheck.ip;
      result.ip_family = net.isIPv6(egressCheck.ip) ? 6 : 4;
      result.ip_consensus = egressCheck.consensus;
      result.ip_stable = egressCheck.stable;
      result.ipv6_egress = egressCheck.ipv6 || null;

      // 2. Authoritative Multi-Source IP Intelligence
      const intel = await this.ipIntel.query(egressCheck.ip);
      result.country_code = intel.country_code;
      result.region = intel.region;
      result.city = intel.city;
      result.asn = intel.asn;
      result.as_name = intel.as_name;
      result.network_type = intel.network_type;
      result.is_datacenter = intel.is_datacenter;
      result.facility_name = intel.facility_name;
      result.facility_confidence = intel.facility_confidence;
      result.intel_sources = intel.sources || [];

      // 2b. Remote IPv6 egress purity check (if node exits over IPv6, verify its country is clean)
      if (result.ipv6_egress) {
        try {
          const v6Intel = await this.ipIntel.query(result.ipv6_egress);
          const v6Cc = String(v6Intel.country_code || '').toUpperCase();
          result.ipv6_clean = Boolean(v6Cc && !BLOCKED_ISO2.has(v6Cc) && SUPPORTED_ISO2_TO_ISO3[v6Cc]);
        } catch {
          result.ipv6_clean = false;
        }
      } else {
        result.ipv6_clean = true;
      }

      // 3. Multi-Tier Gemini & Antigravity Probing ("能用上都用上")
      const geminiRes = await this.probeGeminiSuite(agent);
      Object.assign(geminiRes, await this.probeClaudeSuite(agent));
      geminiRes.probe_version = PROBE_VERSION;
      geminiRes.ip_stable = result.ip_stable;
      geminiRes.ipv6_egress = result.ipv6_egress;
      geminiRes.ipv6_clean = result.ipv6_clean;

      // 3b. Optional authenticated loadCodeAssist check (only for candidates that already passed unauthenticated gates)
      if (this.antigravityAccessToken && geminiRes.antigravity_endpoints_ok && geminiRes.api_supported && geminiRes.web_app_ok && !geminiRes.region_blocked) {
        geminiRes.load_code_assist_status = await this.probeLoadCodeAssist(agent, this.antigravityAccessToken);
      }

      const tiers = evaluateNodeTiers({
        countryCode: result.country_code,
        ipConsensus: result.ip_consensus,
        ipStable: result.ip_stable,
        ipv6Clean: result.ipv6_clean,
        details: geminiRes,
      });

      geminiRes.google_tier = tiers.google_tier;
      geminiRes.gemini_tier = tiers.gemini_tier;
      geminiRes.antigravity_tier = tiers.antigravity_tier;
      geminiRes.claude_tier = tiers.claude_tier;
      result.gemini_details = geminiRes;
      result.gemini_status = tiers.gemini_status;
      result.gemini_tier = tiers.gemini_tier;
      result.antigravity_tier = tiers.antigravity_tier;
      result.claude_tier = tiers.claude_tier;
      result.google_tier = tiers.google_tier;
    } catch (err) {
      result.gemini_details.error = err.message;
    } finally {
      result.duration_ms = Date.now() - startMs;
      if (agent) {
        await agent.close().catch(() => {});
      }
      if (proc && !proc.killed) {
        proc.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 150));
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    }

    return result;
  }

  async fetchViaProxy(agent, url, timeoutMs = 10000) {
    return await fetch(url, {
      dispatcher: agent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async probeEgressIp(agent) {
    const fetchOne = async (url, timeoutMs = 6000) => {
      try {
        const r = await fetch(url, {
          dispatcher: agent,
          headers: { 'User-Agent': 'curl/8.7.1' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!r.ok) return null;
        const txt = (await r.text()).trim();
        return isValidIp(txt) ? txt : null;
      } catch {
        return null;
      }
    };

    const [ip1, ip2, ipv6] = await Promise.all([
      fetchOne('http://api.ipify.org'),
      fetchOne('http://icanhazip.com'),
      fetchOne('https://api6.ipify.org', 4000),
    ]);

    let primaryIp = null;
    let consensus = false;
    if (ip1 && ip2 && ip1 === ip2) {
      primaryIp = ip1;
      consensus = true;
    } else if (ip1 && !ip2) {
      primaryIp = ip1;
      consensus = true;
    } else if (ip2 && !ip1) {
      primaryIp = ip2;
      consensus = true;
    } else if (!ip1 && !ip2) {
      const ip3 = await fetchOne('http://checkip.amazonaws.com');
      primaryIp = ip3;
      consensus = Boolean(ip3);
    } else {
      // Mismatch -> 3rd tie-breaker via Cloudflare trace
      try {
        const r3 = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
          dispatcher: agent,
          signal: AbortSignal.timeout(6000),
        });
        const body = await r3.text();
        const ip3 = (body.match(/^ip=(.+)$/m) || [])[1]?.trim();
        if (ip3 && (ip3 === ip1 || ip3 === ip2)) {
          primaryIp = ip3;
          consensus = true;
        } else {
          primaryIp = ip1;
          consensus = false;
        }
      } catch {
        primaryIp = ip1;
        consensus = false;
      }
    }

    if (!primaryIp) {
      return { ip: null, consensus: false, stable: false, ipv6: null };
    }

    // Second-round stability check to catch rotating multi-egress airport pools
    let stable = consensus;
    if (consensus && this.stabilityDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.stabilityDelayMs));
      const round2 = (await fetchOne('http://api.ipify.org', 5000)) || (await fetchOne('http://icanhazip.com', 5000));
      if (round2) {
        stable = round2 === primaryIp;
      }
    }

    return {
      ip: primaryIp,
      consensus,
      stable,
      ipv6: ipv6 && net.isIPv6(ipv6) ? ipv6 : null,
    };
  }

  async probeLoadCodeAssist(agent, accessToken) {
    try {
      const r = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
        method: 'POST',
        dispatcher: agent,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'google-api-nodejs-client/9.15.1',
        },
        body: JSON.stringify({
          metadata: {
            ideType: 'IDE_UNSPECIFIED',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
        signal: AbortSignal.timeout(9000),
      });
      const body = await r.text().catch(() => '');
      if (r.status === 200) return 'PASS';
      if (r.status === 403 && (/UNSUPPORTED_LOCATION/i.test(body) || /"error_number"\s*:\s*"1008"/.test(body) || /not currently available in your location/i.test(body))) {
        return 'FAIL_LOCATION';
      }
      if (r.status === 401) return 'FAIL_AUTH';
      return `FAIL_HTTP_${r.status}`;
    } catch {
      return 'FAIL_NETWORK';
    }
  }

  async probeGeminiSuite(agent) {
    const details = {
      probe_version: PROBE_VERSION,
      api_supported: false,
      web_app_ok: false,
      web_root_ok: false,
      feature_flag: false,
      oauth_reachable: false,
      antigravity_endpoints_ok: false,
      load_code_assist_status: 'SKIPPED',
      google_reachable: false,
      google_clean: false,
      detected_country: null,
      geo_gemini: null,
      geo_terms: null,
      geo_youtube: null,
      geo_search: null,
      region_blocked: false,
      final_app_url: null,
      error: null,
    };

    const apiKeyParam = this.aiStudioApiKey ? encodeURIComponent(this.aiStudioApiKey) : 'x';
    const [apiRes, appRes, termsRes, ytRes, oauthRes, gSearchRes, ag1Res, ag2Res] = await Promise.allSettled([
      this.fetchViaProxy(agent, `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${apiKeyParam}`, 8000),
      this.fetchViaProxy(agent, 'https://gemini.google.com/app', this.httpTimeoutMs),
      this.fetchViaProxy(agent, 'https://policies.google.com/terms?hl=en', 8000),
      this.fetchViaProxy(agent, 'https://www.youtube.com/', 8000),
      this.fetchViaProxy(agent, 'https://oauth2.googleapis.com/token', 7000),
      this.fetchViaProxy(agent, 'https://www.google.com/', 8000),
      this.fetchViaProxy(agent, 'https://cloudaicompanion.googleapis.com/', 7000),
      this.fetchViaProxy(agent, 'https://cloudcode-pa.googleapis.com/', 7000),
    ]);

    // 1. AI Studio REST Endpoint
    if (apiRes.status === 'fulfilled') {
      const r = apiRes.value;
      const body = await r.text().catch(() => '');
      if (r.status === 200) {
        details.api_supported = true;
      } else if (r.status === 400) {
        try {
          const j = JSON.parse(body);
          const statusStr = j.error?.status || '';
          const msgStr = j.error?.message || '';
          if (statusStr === 'INVALID_ARGUMENT' || /API key not valid/i.test(msgStr)) {
            details.api_supported = true;
          } else if (statusStr === 'FAILED_PRECONDITION' || /location is not supported/i.test(msgStr)) {
            details.api_supported = false;
            details.region_blocked = true;
          }
        } catch {
          // Non-JSON 400
        }
      } else if (r.status === 403 || r.status === 451) {
        details.region_blocked = true;
      }
    }

    // 2. Gemini /app strict host/path + SSR feature flag + country check
    if (appRes.status === 'fulfilled') {
      const r = appRes.value;
      details.final_app_url = r.url;
      const body = await r.text().catch(() => '');
      try {
        const u = new URL(r.url);
        const hostOk = u.hostname === 'gemini.google.com';
        const pathOk = u.pathname === '/app' || u.pathname === '/app/';
        const blocked = BLOCK_TEXT_REGEX.test(body) || u.pathname.includes('unsupported') || u.hostname === 'support.google.com';
        const cc = extractGoogleCountry(body);
        if (cc) {
          details.geo_gemini = cc;
          details.detected_country = cc;
        }
        if (hasGeminiFeatureFlag(body)) details.feature_flag = true;
        if (blocked) details.region_blocked = true;
        if (r.status === 200 && hostOk && pathOk && !blocked) {
          details.web_app_ok = true;
          details.web_root_ok = true;
        }
      } catch {
        // Ignore parse error
      }
    }

    // 3. Google Terms internal GeoIP check
    if (termsRes.status === 'fulfilled') {
      const r = termsRes.value;
      const body = await r.text().catch(() => '');
      const cc = extractTermsCountry(body);
      if (cc) {
        details.geo_terms = cc;
        if (!details.detected_country) details.detected_country = cc;
      }
    }

    // 3b. YouTube INNERTUBE_CONTEXT_GL internal GeoIP check
    if (ytRes.status === 'fulfilled') {
      const r = ytRes.value;
      const body = await r.text().catch(() => '');
      const cc = extractYoutubeGl(body);
      if (cc) {
        details.geo_youtube = cc;
        if (!details.detected_country) details.detected_country = cc;
      }
    }

    // 4. Antigravity OAuth Gateway reachability
    if (oauthRes.status === 'fulfilled') {
      if ([200, 400, 404, 405].includes(oauthRes.value.status)) {
        details.oauth_reachable = true;
      }
      await oauthRes.value.body?.cancel().catch(() => {});
    }

    // 4b. AntiGravity backend endpoints reachability & 403 location block guard
    const checkAgEndpoint = async (settled) => {
      if (settled.status !== 'fulfilled') return false;
      const r = settled.value;
      const body = await r.text().catch(() => '');
      if (r.status === 403 && (/UNSUPPORTED_LOCATION/i.test(body) || /not currently available in your location/i.test(body))) {
        details.region_blocked = true;
        return false;
      }
      return [200, 400, 401, 404, 405].includes(r.status);
    };
    const [ag1Ok, ag2Ok] = await Promise.all([checkAgEndpoint(ag1Res), checkAgEndpoint(ag2Res)]);
    details.antigravity_endpoints_ok = ag1Ok && ag2Ok;

    // 5. Google Search CAPTCHA-free + GLS country check
    if (gSearchRes.status === 'fulfilled') {
      const r = gSearchRes.value;
      const body = await r.text().catch(() => '');
      const isSorry = r.url.includes('/sorry/');
      const cc = extractGoogleCountry(body);
      if (cc) {
        details.geo_search = cc;
        if (!details.detected_country) details.detected_country = cc;
      }
      details.google_reachable = r.status >= 200 && r.status < 400;
      details.google_clean = r.status === 200 && !isSorry;
    }

    return details;
  }

  async probeClaudeSuite(agent) {
    const check = async (url, acceptedStatuses) => {
      try {
        const r = await fetch(url, {
          dispatcher: agent,
          headers: { 'User-Agent': 'claude-code-network-probe/1.0' },
          signal: AbortSignal.timeout(9000),
        });
        await r.body?.cancel().catch(() => {});
        return acceptedStatuses.includes(r.status);
      } catch {
        return false;
      }
    };

    const [api, web, platform, sso] = await Promise.all([
      // Claude Code's direct API endpoint normally answers unauthenticated probes with 401.
      check('https://api.anthropic.com/v1/models', [200, 400, 401, 404, 405]),
      check('https://claude.ai/', [200, 204, 301, 302, 307, 308]),
      check('https://platform.claude.com/', [200, 204, 301, 302, 307, 308, 401, 404]),
      check('https://sso.claude.com/', [200, 204, 301, 302, 307, 308, 401, 404]),
    ]);

    return {
      claude_api_ok: api,
      claude_web_ok: web,
      claude_platform_ok: platform,
      claude_sso_ok: sso,
    };
  }

  async probeAllNodes(nodeMetas, forceReprobe = false) {
    console.log(`[probe] Starting server-side probe across ${nodeMetas.length} candidate nodes (workers=${this.maxWorkers}, force=${forceReprobe})...`);
    const results = [];
    let index = 0;

    const runWorker = async (workerId) => {
      while (true) {
        const idx = index++;
        if (idx >= nodeMetas.length) break;
        const meta = nodeMetas[idx];
        const res = await this.probeSingleNode(meta, workerId, forceReprobe);
        results.push(res);

        if (this.storage && res.success && res.egress_ip && !res.cached) {
          this.storage.upsertNode({
            fingerprint: meta.fingerprint,
            source_id: meta.sourceId,
            original_name: meta.originalName,
            normalized_name: `${res.country_code}-${res.city}-${res.facility_name}`,
            protocol: meta.proxyDict.type,
            egress_ip: res.egress_ip,
            ip_family: res.ip_family,
            ip_consensus: res.ip_consensus,
            country_code: res.country_code,
            region: res.region,
            city: res.city,
            asn: res.asn,
            as_name: res.as_name,
            network_type: res.network_type,
            is_datacenter: res.is_datacenter,
            facility_name: res.facility_name,
            facility_confidence: res.facility_confidence,
            intel_sources: res.intel_sources,
            gemini_status: res.gemini_status,
            gemini_details: res.gemini_details,
            duration_ms: res.duration_ms,
          });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.maxWorkers, Math.max(1, nodeMetas.length)) }, (_, w) => runWorker(w)));
    console.log(
      `[probe] Finished ${results.length} nodes; active=${results.filter((r) => r.success).length}, ` +
      `AG-strict=${results.filter((r) => r.antigravity_tier === 'STRICT').length}, ` +
      `AG-any=${results.filter((r) => r.antigravity_tier === 'STRICT' || r.antigravity_tier === 'FALLBACK').length}, ` +
      `Gemini-strict=${results.filter((r) => r.gemini_tier === 'STRICT').length}, ` +
      `Gemini-any=${results.filter((r) => r.gemini_status === 'PASS').length}, ` +
      `Google-any=${results.filter((r) => r.google_tier === 'STRICT' || r.google_tier === 'FALLBACK').length}`
    );
    return results;
  }
}
