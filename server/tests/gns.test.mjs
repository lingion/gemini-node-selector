import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import yaml from 'js-yaml';

import { Parser } from '../src/parser.mjs';
import { Normalizer } from '../src/normalizer.mjs';
import { GroupBuilder } from '../src/groups.mjs';
import { ConfigValidator } from '../src/validator.mjs';
import { Storage } from '../src/storage.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { createApiServer } from '../src/api.mjs';
import { evaluateNodeTiers, extractTermsCountry, extractYoutubeGl } from '../src/probe_runner.mjs';

test('Parser & Normalizer reject junk nodes and keep HMAC fingerprints stable', () => {
  const vlessUri = 'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?security=reality&sni=www.cloudflare.com&pbk=PUBKEY&sid=SID123&fp=chrome&flow=xtls-rprx-vision#Test,Node:With[Chars]';
  const junkUri = 'trojan://pass@1.2.3.4:443#剩余流量：10GB';
  const payload = Buffer.from(`${vlessUri}\n${junkUri}`).toString('base64');

  const parsed = Parser.parse(payload);
  assert.equal(parsed.length, 2);

  Normalizer.setHmacSecret('test-secret-key');
  const r1 = Normalizer.normalizeNode(parsed[0], '[自建]', 'self');
  const r2 = Normalizer.normalizeNode(parsed[0], '[自建]', 'self');
  const rJunk = Normalizer.normalizeNode(parsed[1], '[A2]', 'a2');

  assert.equal(r1.valid, true);
  assert.equal(r1.meta.fingerprint, r2.meta.fingerprint);
  assert.equal(r1.meta.fingerprint.length, 16);
  assert.equal(rJunk.valid, false);
});

test('GroupBuilder & ConfigValidator enforce zero DIRECT leakage and grade rules', () => {
  const probed = [
    {
      success: true,
      egress_ip: '16.179.53.161',
      country_code: 'AU',
      city: 'Sydney',
      asn: 16509,
      facility_name: 'AWS-ap-southeast-2',
      facility_confidence: 'A',
      gemini_status: 'PASS',
      meta: { proxyDict: { name: 'au', type: 'vless', server: '16.179.53.161', port: 25843, uuid: 'u1' } },
    },
    {
      success: true,
      egress_ip: '36.227.228.165',
      country_code: 'TW',
      city: 'Taipei',
      asn: 3462,
      facility_name: 'HiNet',
      facility_confidence: 'B',
      gemini_status: 'FAIL',
      meta: { proxyDict: { name: 'tw', type: 'hysteria2', server: 'tw.example', port: 443, password: 'p1' } },
    },
    {
      success: true,
      egress_ip: '203.0.113.77',
      country_code: 'US',
      city: 'Seattle',
      asn: 64500,
      facility_name: 'EquinixFake',
      facility_confidence: 'C',
      gemini_status: 'FAIL_REGION',
      meta: { proxyDict: { name: 'us-c', type: 'trojan', server: 'us.example', port: 443, password: 'p2' } },
    },
  ];

  const cfg = GroupBuilder.buildFromProbedNodes(probed, {
    adWhitelist: ['safe.example.com'],
    adBlacklist: ['ads.example.com'],
  });

  // Zero structural errors
  const errs = ConfigValidator.validateStructure(cfg);
  assert.deepEqual(errs, []);

  // Only Grade A/B get facility groups; Grade C must NOT fabricate EquinixFake facility group
  const groupNames = cfg['proxy-groups'].map((g) => g.name);
  assert.ok(groupNames.includes('机房-AWS-ap-southeast-2'));
  assert.ok(groupNames.includes('机房-HiNet-推定'));
  assert.ok(!groupNames.some((n) => n.includes('EquinixFake')));

  // Gemini strict/non-strict groups MUST strictly contain only PASS node
  const geminiGrp = cfg['proxy-groups'].find((g) => g.name === 'Gemini');
  const geminiStrictGrp = cfg['proxy-groups'].find((g) => g.name === 'Gemini-严选');
  assert.ok(geminiGrp.proxies.includes('Gemini-严选自动'));
  assert.ok(geminiStrictGrp.proxies.includes('AU-Sydney-AWS-ap-southeast-2-161-01'));
  assert.ok(!geminiStrictGrp.proxies.some((p) => p.includes('HiNet')));
  assert.ok(!geminiGrp.proxies.includes('DIRECT'));

  // Ad whitelist precedes blacklist & GEOSITE ads
  const wlIdx = cfg.rules.indexOf('DOMAIN-SUFFIX,safe.example.com,国内直连');
  const blIdx = cfg.rules.indexOf('DOMAIN-SUFFIX,ads.example.com,广告拦截');
  const gsIdx = cfg.rules.indexOf('GEOSITE,category-ads-all,广告拦截');
  assert.ok(wlIdx >= 0 && blIdx > wlIdx && gsIdx > blIdx);

  // Injecting DIRECT into Gemini MUST trigger validator failure
  geminiGrp.proxies.push('DIRECT');
  const badErrs = ConfigValidator.validateStructure(cfg);
  assert.ok(badErrs.some((e) => e.includes('CRITICAL VIOLATION') && e.includes('Gemini')));
});

test('Empty Gemini pool defaults to REJECT rather than unverified fallback or DIRECT', () => {
  const probed = [
    {
      success: true,
      egress_ip: '203.0.113.99',
      country_code: 'HK',
      city: 'HongKong',
      asn: 64501,
      facility_name: 'Unknown',
      facility_confidence: 'D',
      gemini_status: 'FAIL_REGION',
      meta: { proxyDict: { name: 'hk', type: 'trojan', server: 'hk.example', port: 443, password: 'p' } },
    },
  ];
  const cfg = GroupBuilder.buildFromProbedNodes(probed);
  const geminiGrp = cfg['proxy-groups'].find((g) => g.name === 'Gemini');
  const agGrp = cfg['proxy-groups'].find((g) => g.name === 'AntiGravity');
  const googleGrp = cfg['proxy-groups'].find((g) => g.name === 'Google');
  assert.deepEqual(geminiGrp.proxies, ['REJECT']);
  assert.deepEqual(agGrp.proxies, ['REJECT']);
  assert.deepEqual(googleGrp.proxies, ['REJECT']);
  assert.deepEqual(ConfigValidator.validateStructure(cfg), []);
});

test('evaluateNodeTiers enforces strictness gradient AntiGravity > Gemini > Google and fail-closed geo', () => {
  assert.equal(extractTermsCountry('<div>Country version: <span>United States</span></div>'), 'USA');
  assert.equal(extractTermsCountry('Country version: Hong Kong'), 'HKG');
  assert.equal(extractYoutubeGl('{"INNERTUBE_CONTEXT_GL":"JP"}'), 'JPN');

  const baseCleanDetails = {
    api_supported: true,
    web_app_ok: true,
    feature_flag: true,
    oauth_reachable: true,
    antigravity_endpoints_ok: true,
    load_code_assist_status: 'SKIPPED',
    google_reachable: true,
    google_clean: true,
    geo_gemini: 'USA',
    geo_terms: 'USA',
    geo_youtube: 'USA',
    geo_search: null,
    region_blocked: false,
  };

  // 1. Perfect node -> STRICT across all three tiers
  const perfect = evaluateNodeTiers({
    countryCode: 'US',
    ipConsensus: true,
    ipStable: true,
    ipv6Clean: true,
    details: baseCleanDetails,
  });
  assert.equal(perfect.antigravity_tier, 'STRICT');
  assert.equal(perfect.gemini_tier, 'STRICT');
  assert.equal(perfect.google_tier, 'STRICT');

  // 2. Rotating multi-egress IP -> AntiGravity/Gemini drop to FALLBACK, Google stays STRICT
  const rotating = evaluateNodeTiers({
    countryCode: 'US',
    ipConsensus: true,
    ipStable: false,
    ipv6Clean: true,
    details: baseCleanDetails,
  });
  assert.equal(rotating.antigravity_tier, 'FALLBACK');
  assert.equal(rotating.gemini_tier, 'FALLBACK');
  assert.equal(rotating.google_tier, 'STRICT');

  // 3. Google CAPTCHA (/sorry/) -> AntiGravity FAIL, Gemini FALLBACK, Google FALLBACK
  const sorry = evaluateNodeTiers({
    countryCode: 'JP',
    ipConsensus: true,
    ipStable: true,
    ipv6Clean: true,
    details: { ...baseCleanDetails, google_clean: false, geo_gemini: 'JPN', geo_terms: 'JPN', geo_youtube: 'JPN' },
  });
  assert.equal(sorry.antigravity_tier, 'FAIL');
  assert.equal(sorry.gemini_tier, 'FALLBACK');
  assert.equal(sorry.google_tier, 'FALLBACK');

  // 4. Dirty remote IPv6 -> AntiGravity FAIL, Gemini FALLBACK
  const dirtyV6 = evaluateNodeTiers({
    countryCode: 'US',
    ipConsensus: true,
    ipStable: true,
    ipv6Clean: false,
    details: baseCleanDetails,
  });
  assert.equal(dirtyV6.antigravity_tier, 'FAIL');
  assert.equal(dirtyV6.gemini_tier, 'FALLBACK');

  // 5. Missing internal Google geo (fail-closed) -> AntiGravity & Gemini FAIL, Google STRICT
  const missingGeo = evaluateNodeTiers({
    countryCode: 'US',
    ipConsensus: true,
    ipStable: true,
    ipv6Clean: true,
    details: { ...baseCleanDetails, geo_gemini: null, geo_terms: null, geo_youtube: null },
  });
  assert.equal(missingGeo.antigravity_tier, 'FAIL');
  assert.equal(missingGeo.gemini_tier, 'FAIL');
  assert.equal(missingGeo.google_tier, 'STRICT');

  // 6. Send-to-China (JP IP but Google Terms says CHN) -> AntiGravity & Gemini FAIL_REGION
  const sendToCn = evaluateNodeTiers({
    countryCode: 'JP',
    ipConsensus: true,
    ipStable: true,
    ipv6Clean: true,
    details: { ...baseCleanDetails, geo_gemini: 'JPN', geo_terms: 'CHN', geo_youtube: 'JPN' },
  });
  assert.equal(sendToCn.antigravity_tier, 'FAIL');
  assert.equal(sendToCn.gemini_tier, 'FAIL');
  assert.equal(sendToCn.gemini_status, 'FAIL_REGION');

  // 7. loadCodeAssist returns 1008 UNSUPPORTED_LOCATION -> AntiGravity FAIL even if Gemini passes
  const lcaBlocked = evaluateNodeTiers({
    countryCode: 'US',
    ipConsensus: true,
    ipStable: true,
    ipv6Clean: true,
    details: { ...baseCleanDetails, load_code_assist_status: 'FAIL_LOCATION' },
  });
  assert.equal(lcaBlocked.antigravity_tier, 'FAIL');
  assert.equal(lcaBlocked.gemini_tier, 'STRICT');
});

test('GroupBuilder separates AntiGravity, Gemini, Google into strict & non-strict pools and orders rules properly', () => {
  const mkNode = (ip, cc, ag, gem, goo) => ({
    success: true,
    egress_ip: ip,
    country_code: cc,
    city: 'Tokyo',
    asn: 1000,
    facility_name: 'CleanDC',
    facility_confidence: 'A',
    gemini_status: gem === 'FAIL' ? 'FAIL' : 'PASS',
    antigravity_tier: ag,
    gemini_tier: gem,
    google_tier: goo,
    meta: { proxyDict: { name: ip, type: 'vless', server: ip, port: 443, uuid: 'u' } },
  });

  const cfg = GroupBuilder.buildFromProbedNodes([
    mkNode('1.1.1.1', 'JP', 'STRICT', 'STRICT', 'STRICT'),
    mkNode('1.1.1.2', 'JP', 'FALLBACK', 'FALLBACK', 'STRICT'),
    mkNode('1.1.1.3', 'SG', 'FAIL', 'FALLBACK', 'FALLBACK'),
    mkNode('1.1.1.4', 'HK', 'FAIL', 'FAIL', 'STRICT'),
    mkNode('1.1.1.5', 'HK', 'FAIL', 'FAIL', 'FAIL'),
  ]);

  assert.deepEqual(ConfigValidator.validateStructure(cfg), []);

  const byName = (n) => cfg['proxy-groups'].find((g) => g.name === n);
  assert.equal(byName('AntiGravity-严选').proxies.length, 1);
  assert.equal(byName('AntiGravity-非严选').proxies.length, 2);
  assert.equal(byName('Gemini-严选').proxies.length, 1);
  assert.equal(byName('Gemini-非严选').proxies.length, 3);
  assert.equal(byName('Google-严选').proxies.length, 3);
  assert.equal(byName('Google-非严选').proxies.length, 4);
  // Dead Google node (1.1.1.5) must NOT enter Google-非严选
  assert.ok(!byName('Google-非严选').proxies.some((p) => p.includes('-5-')));

  // AntiGravity rule must precede Gemini rule, which must precede Google rule
  const agIdx = cfg.rules.indexOf('DOMAIN-SUFFIX,cloudaicompanion.googleapis.com,AntiGravity');
  const gemIdx = cfg.rules.indexOf('DOMAIN,gemini.google.com,Gemini');
  const gooIdx = cfg.rules.indexOf('GEOSITE,google,Google');
  assert.ok(agIdx >= 0 && gemIdx > agIdx && gooIdx > gemIdx);
});

test('Domestic, Microsoft, Apple, FCM and Claude rules are isolated and ordered before broad Google', () => {
  const cfg = GroupBuilder.buildFromProbedNodes([{
    success: true,
    egress_ip: '16.179.53.161',
    country_code: 'AU',
    city: 'Sydney',
    asn: 16509,
    facility_name: 'AWS',
    facility_confidence: 'A',
    gemini_status: 'PASS',
    gemini_tier: 'STRICT',
    antigravity_tier: 'STRICT',
    google_tier: 'STRICT',
    claude_tier: 'STRICT',
    meta: { proxyDict: { name: 'au', type: 'vless', server: '16.179.53.161', port: 443, uuid: 'u' } },
  }]);

  const names = new Set(cfg['proxy-groups'].map((g) => g.name));
  for (const name of ['国内直连', '微软', 'Apple', 'FCM', 'Claude', 'Claude-严选', 'Claude-非严选']) {
    assert.ok(names.has(name), `missing group ${name}`);
  }

  const index = (rule) => cfg.rules.indexOf(rule);
  const domestic = index('GEOSITE,cn,国内直连');
  const microsoft = index('GEOSITE,microsoft,微软');
  const apple = index('GEOSITE,apple,Apple');
  const fcm = index('DOMAIN-SUFFIX,fcm.googleapis.com,FCM');
  const claude = index('DOMAIN,api.anthropic.com,Claude');
  const google = index('GEOSITE,google,Google');

  assert.ok(domestic >= 0);
  assert.ok(domestic >= 0);
  assert.ok(claude > domestic && microsoft > domestic && apple > domestic && fcm > domestic);
  assert.ok(google > claude && google > microsoft && google > apple && google > fcm);
  assert.ok(index('GEOIP,CN,国内直连') > google);
  assert.equal(cfg['proxy-groups'].find((g) => g.name === 'Claude-严选').proxies.length, 1);
  assert.deepEqual(cfg['proxy-groups'].find((g) => g.name === 'Claude-非严选').proxies, ['REJECT']);
  assert.deepEqual(ConfigValidator.validateStructure(cfg), []);
});

test('Claude tier is fail-closed and independent from Gemini tier', () => {
  const base = {
    countryCode: 'US',
    ipConsensus: true,
    ipStable: true,
    ipv6Clean: true,
    details: {
      google_reachable: true,
      google_clean: true,
      api_supported: true,
      web_app_ok: true,
      feature_flag: true,
      oauth_reachable: true,
      antigravity_endpoints_ok: true,
      geo_gemini: 'USA',
      geo_terms: 'USA',
      geo_youtube: 'USA',
      claude_api_ok: true,
      claude_web_ok: true,
      claude_platform_ok: true,
      claude_sso_ok: true,
      load_code_assist_status: 'SKIPPED',
    },
  };
  assert.equal(evaluateNodeTiers(base).claude_tier, 'STRICT');
  assert.equal(evaluateNodeTiers({ ...base, details: { ...base.details, claude_platform_ok: false } }).claude_tier, 'FAIL');
  assert.equal(evaluateNodeTiers({ ...base, countryCode: 'CN' }).claude_tier, 'FAIL');
});

test('Orchestrator deduplicates concurrent refreshes and falls back to last valid YAML on error', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gns-test-'));
  try {
    const storage = new Storage(path.join(tmpDir, 'state.sqlite3'));
    let fetchCalls = 0;
    let shouldFail = false;

    const fetcher = {
      async fetchAll() {
        fetchCalls++;
        if (shouldFail) throw new Error('Simulated upstream outage');
        return [{
          sourceId: 's1',
          prefix: '[T]',
          type: 'clash_proxies',
          data: [{ name: 'Node1', type: 'vless', server: '1.1.1.1', port: 443, uuid: 'u' }],
        }];
      },
    };
    const probeRunner = {
      async probeAllNodes(metas) {
        await new Promise((r) => setTimeout(r, 40));
        return metas.map((meta) => ({
          success: true,
          egress_ip: '16.179.53.161',
          country_code: 'AU',
          city: 'Sydney',
          asn: 16509,
          facility_name: 'AWS',
          facility_confidence: 'A',
          gemini_status: 'PASS',
          meta,
        }));
      },
    };
    const settings = { cache: { upstream_ttl_seconds: 900 }, ads: {} };
    const orc = new Orchestrator({ fetcher, probeRunner, storage, mihomoBin: null, geodataDir: null, settings });

    // Fire 3 concurrent force-refreshes -> must coalesce to 1 fetch
    const [r1, r2, r3] = await Promise.all([
      orc.generateSubscription({ forceRefresh: true }),
      orc.generateSubscription({ forceRefresh: true }),
      orc.generateSubscription({ forceRefresh: true }),
    ]);
    assert.equal(fetchCalls, 1);
    assert.equal(r1.meta.gemini_pass_nodes, 1);
    assert.equal(r1.yaml, r2.yaml);
    assert.equal(r2.yaml, r3.yaml);

    // Subsequent failure -> must return stale fallback YAML cleanly
    shouldFail = true;
    const degraded = await orc.generateSubscription({ forceRefresh: true });
    assert.equal(degraded.meta.stale, true);
    assert.ok(degraded.meta.fallback_reason.includes('Simulated upstream outage'));
    const parsedYaml = yaml.load(degraded.yaml);
    assert.equal(parsedYaml.proxies.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('API server enforces auth, redacts secrets, and serves valid YAML', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gns-api-test-'));
  let server;
  try {
    const storage = new Storage(path.join(tmpDir, 'state.sqlite3'));
    const fetcher = {
      async fetchAll() {
        return [{
          sourceId: 's1',
          prefix: '[T]',
          type: 'clash_proxies',
          data: [{ name: 'N1', type: 'vless', server: '1.1.1.1', port: 443, uuid: 'super-secret-uuid-999' }],
        }];
      },
    };
    const probeRunner = {
      async probeAllNodes(metas) {
        return metas.map((meta) => ({
          success: true,
          egress_ip: '16.179.53.161',
          country_code: 'AU',
          city: 'Sydney',
          asn: 16509,
          facility_name: 'AWS',
          facility_confidence: 'A',
          gemini_status: 'PASS',
          gemini_details: { api_supported: true, web_app_ok: true, oauth_reachable: true },
          intel_sources: ['PTR', 'RDAP'],
          meta,
        }));
      },
    };
    const settings = { server: { token: 'tok-test-123' }, cache: { upstream_ttl_seconds: 900 }, ads: {} };
    const orc = new Orchestrator({ fetcher, probeRunner, storage, mihomoBin: null, geodataDir: null, settings });
    await orc.generateSubscription({ forceRefresh: true });
    // Store simulated node row as ProbeRunner does
    storage.upsertNode({
      fingerprint: 'fp1234567890abcd',
      source_id: 's1',
      original_name: 'N1',
      normalized_name: 'AU-Sydney-AWS',
      protocol: 'vless',
      egress_ip: '16.179.53.161',
      country_code: 'AU',
      city: 'Sydney',
      asn: 16509,
      as_name: 'AMAZON-02',
      facility_name: 'AWS',
      facility_confidence: 'A',
      intel_sources: ['PTR', 'RDAP'],
      gemini_status: 'PASS',
      gemini_details: { api_supported: true, web_app_ok: true, oauth_reachable: true },
    });

    server = createApiServer({ orchestrator: orc, storage, settings });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const hz = await fetch(`${base}/healthz`);
    assert.equal(hz.status, 200);
    const hzJson = await hz.json();
    assert.equal(hzJson.status, 'ok');
    assert.equal(JSON.stringify(hzJson).includes('tok-test-123'), false);

    const badSub = await fetch(`${base}/sub/wrong`);
    assert.equal(badSub.status, 403);

    const okSub = await fetch(`${base}/sub/tok-test-123`);
    assert.equal(okSub.status, 200);
    const yamlTxt = await okSub.text();
    assert.ok(yaml.load(yamlTxt).proxies.length === 1);

    const adminNodes = await fetch(`${base}/admin/nodes?token=tok-test-123&format=json`);
    assert.equal(adminNodes.status, 200);
    const adminTxt = await adminNodes.text();
    assert.equal(adminTxt.includes('super-secret-uuid-999'), false);
  } finally {
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
