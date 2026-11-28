const COUNTRY_DISPLAY = {
  AU: '澳大利亚',
  DE: '德国',
  TW: '台湾',
  US: '美国',
  SG: '新加坡',
  JP: '日本',
  HK: '香港',
  KR: '韩国',
  GB: '英国',
  IN: '印度',
  ID: '印度尼西亚',
  NL: '荷兰',
  FR: '法国',
  CA: '加拿大',
};

const SRS_HOST = 'cdn.jsdelivr.net';
const SRS_BASE = ['https', '://', SRS_HOST, '/gh/MetaCubeX/meta-rules-dat@sing/geo'].join('');

function sanitizeName(name) {
  return String(name || '')
    .replace(/[:{}\[\],&*#?|<>!=%@`"'\\]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 62);
}

function attachTransport(out, rawNode) {
  const net = rawNode.network;
  if (net === 'ws') {
    const ws = {
      type: 'ws',
      path: rawNode['ws-opts']?.path || '/',
    };
    const host = rawNode['ws-opts']?.headers?.Host || rawNode['ws-opts']?.headers?.host;
    if (host) {
      ws.headers = { Host: host };
    }
    out.transport = ws;
  } else if (net === 'grpc') {
    out.transport = {
      type: 'grpc',
      service_name: rawNode['grpc-opts']?.['grpc-service-name'] || '',
    };
  }
}

export function toSingBoxOutbound(rawNode, tag) {
  const type = String(rawNode.type || '').toLowerCase();
  const server = rawNode.server;
  const serverPort = Number(rawNode.port);
  const sni = rawNode.servername || rawNode.sni || '';
  const insecure = Boolean(rawNode['skip-cert-verify']);

  if (type === 'hysteria2' || type === 'hy2') {
    const out = {
      type: 'hysteria2',
      tag,
      server,
      server_port: serverPort,
      password: rawNode.password || '',
      tls: {
        enabled: true,
        ...(sni ? { server_name: sni } : {}),
        ...(insecure ? { insecure: true } : {}),
      },
    };
    if (rawNode.obfs) {
      out.obfs = {
        type: rawNode.obfs,
        ...(rawNode['obfs-password'] ? { password: rawNode['obfs-password'] } : {}),
      };
    }
    return out;
  }

  if (type === 'vless') {
    const out = {
      type: 'vless',
      tag,
      server,
      server_port: serverPort,
      uuid: rawNode.uuid || '',
    };
    if (rawNode.flow) out.flow = rawNode.flow;
    if (rawNode.tls || rawNode['reality-opts']) {
      const tls = {
        enabled: true,
        ...(sni ? { server_name: sni } : {}),
        ...(insecure ? { insecure: true } : {}),
      };
      if (rawNode['client-fingerprint'] || rawNode['reality-opts']) {
        tls.utls = {
          enabled: true,
          fingerprint: rawNode['client-fingerprint'] || 'chrome',
        };
      }
      if (rawNode['reality-opts']) {
        tls.reality = {
          enabled: true,
          public_key: rawNode['reality-opts']['public-key'] || '',
          short_id: rawNode['reality-opts']['short-id'] || '',
        };
      }
      out.tls = tls;
    }
    attachTransport(out, rawNode);
    return out;
  }

  if (type === 'trojan') {
    const out = {
      type: 'trojan',
      tag,
      server,
      server_port: serverPort,
      password: rawNode.password || '',
      tls: {
        enabled: true,
        ...(sni ? { server_name: sni } : {}),
        ...(insecure ? { insecure: true } : {}),
      },
    };
    attachTransport(out, rawNode);
    return out;
  }

  if (type === 'vmess') {
    const out = {
      type: 'vmess',
      tag,
      server,
      server_port: serverPort,
      uuid: rawNode.uuid || '',
      security: rawNode.cipher || 'auto',
      alter_id: Number(rawNode.alterId || 0),
    };
    if (rawNode.tls) {
      out.tls = {
        enabled: true,
        ...(sni ? { server_name: sni } : {}),
        ...(insecure ? { insecure: true } : {}),
      };
    }
    attachTransport(out, rawNode);
    return out;
  }

  if (type === 'ss' || type === 'shadowsocks') {
    return {
      type: 'shadowsocks',
      tag,
      server,
      server_port: serverPort,
      method: rawNode.cipher || 'aes-256-gcm',
      password: rawNode.password || '',
    };
  }

  return null;
}

function makeRuleSet(tag, kind, name) {
  return {
    tag,
    type: 'remote',
    format: 'binary',
    url: `${SRS_BASE}/${kind}/${name}.srs`,
    download_detour: '节点选择',
    update_interval: '1d',
  };
}

/**
 * Generates sing-box 1.12+ JSON configuration fully aligned with Mihomo GroupBuilder:
 * identical node naming, 3-layer strategy groups, fail-closed AI strict gates,
 * remote .srs rule sets, TPROXY/REDIRECT/mixed inbounds, and Clash API for Zashboard.
 */
export class SingBoxBuilder {
  static _buildGeneralServiceGroup(prefix, allNodes, leading = []) {
    const autoName = `${prefix}-自动选择`;
    const members = [...leading, autoName, '节点选择', ...allNodes];
    return [
      {
        type: 'selector',
        tag: prefix,
        outbounds: members,
        default: members[0],
      },
      {
        type: 'urltest',
        tag: autoName,
        outbounds: [...allNodes],
        url: 'http://cp.cloudflare.com/generate_204',
        interval: '5m',
        tolerance: 50,
      },
    ];
  }

  static _buildHardServiceGroups(prefix, strictList) {
    const autoName = `${prefix}-严选自动`;
    const strictName = `${prefix}-严选`;
    if (strictList.length > 0) {
      return [
        {
          type: 'selector',
          tag: prefix,
          outbounds: [strictName, autoName, '节点选择', '自动选择'],
          default: strictName,
        },
        {
          type: 'urltest',
          tag: autoName,
          outbounds: [...strictList],
          url: 'http://cp.cloudflare.com/generate_204',
          interval: '5m',
          tolerance: 50,
        },
        {
          type: 'selector',
          tag: strictName,
          outbounds: [...strictList],
          default: strictList[0],
        },
      ];
    }
    return [
      {
        type: 'selector',
        tag: prefix,
        outbounds: ['节点选择', '自动选择'],
        default: '节点选择',
      },
    ];
  }

  static _buildTieredServiceGroups(prefix, strictList, fallbackList) {
    const anyList = [...strictList, ...fallbackList];
    if (anyList.length === 0) {
      return { groups: [], hasPool: false };
    }

    const autoName = `${prefix}-严选自动`;
    const strictName = `${prefix}-严选`;
    const nonStrictName = `${prefix}-非严选`;
    const groups = [];

    if (strictList.length > 0) {
      groups.push(
        {
          type: 'selector',
          tag: prefix,
          outbounds: [autoName, strictName, nonStrictName],
          default: autoName,
        },
        {
          type: 'urltest',
          tag: autoName,
          outbounds: [...strictList],
          url: 'http://cp.cloudflare.com/generate_204',
          interval: '5m',
          tolerance: 50,
        },
        {
          type: 'selector',
          tag: strictName,
          outbounds: [...strictList],
          default: strictList[0],
        },
        {
          type: 'selector',
          tag: nonStrictName,
          outbounds: [...anyList],
          default: anyList[0],
        }
      );
    } else {
      groups.push(
        {
          type: 'selector',
          tag: prefix,
          outbounds: [nonStrictName],
          default: nonStrictName,
        },
        {
          type: 'selector',
          tag: nonStrictName,
          outbounds: [...anyList],
          default: anyList[0],
        }
      );
    }

    return { groups, hasPool: true };
  }

  static buildFromProbedNodes(probedResults, options = {}) {
    const proxyOutbounds = [];
    const agStrictNodes = [];
    const agFallbackNodes = [];
    const geminiStrictNodes = [];
    const geminiFallbackNodes = [];
    const googleStrictNodes = [];
    const googleFallbackNodes = [];
    const claudeStrictNodes = [];
    const gptStrictNodes = [];
    const countryGroups = new Map();
    const facilityGroups = new Map();
    const asnGroups = new Map();
    const seqCounters = new Map();
    const seenNames = new Set();

    for (const res of probedResults) {
      if (!res.success || !res.egress_ip) continue;

      const rawNode = structuredClone(res.meta.proxyDict);
      const egressIp = res.egress_ip;
      const cc = res.country_code || 'XX';
      const city = res.city || 'Unknown';
      const grade = res.facility_confidence || 'D';
      const fac = res.facility_name || 'Unknown';
      const lastOctet = egressIp.includes('.') ? egressIp.split('.').pop() : egressIp.split(':').pop();

      const key = `${cc}-${city}-${fac}`;
      const seq = (seqCounters.get(key) || 0) + 1;
      seqCounters.set(key, seq);

      let facLabel = fac;
      if (grade === 'B') facLabel = `${fac}-Inferred`;
      else if (grade === 'C' && res.asn > 0) facLabel = `AS${res.asn}`;
      else if (grade === 'D') facLabel = res.asn > 0 ? `Unknown-AS${res.asn}` : 'Unknown';

      let baseName = sanitizeName(`${cc}-${city}-${facLabel}-${lastOctet}-${String(seq).padStart(2, '0')}`);
      while (seenNames.has(baseName)) {
        baseName = `${baseName}-x`.slice(0, 62);
      }

      const converted = toSingBoxOutbound(rawNode, baseName);
      if (!converted) continue;

      seenNames.add(baseName);
      proxyOutbounds.push(converted);

      if (!countryGroups.has(cc)) countryGroups.set(cc, []);
      countryGroups.get(cc).push(baseName);

      if ((grade === 'A' || grade === 'B') && fac !== 'Unknown') {
        const facGroupName = grade === 'A' ? `机房-${fac}` : `机房-${fac}-推定`;
        if (!facilityGroups.has(facGroupName)) facilityGroups.set(facGroupName, []);
        facilityGroups.get(facGroupName).push(baseName);
      }

      if (res.asn > 0) {
        const asnGroupName = `ASN-AS${res.asn}`;
        if (!asnGroups.has(asnGroupName)) asnGroups.set(asnGroupName, []);
        asnGroups.get(asnGroupName).push(baseName);
      }

      const agTier = res.antigravity_tier || res.gemini_details?.antigravity_tier || 'FAIL';
      if (agTier === 'STRICT') agStrictNodes.push(baseName);
      else if (agTier === 'FALLBACK') agFallbackNodes.push(baseName);

      const geminiTier =
        res.gemini_tier ||
        res.gemini_details?.gemini_tier ||
        (res.gemini_status === 'PASS' ? 'STRICT' : 'FAIL');
      if (geminiTier === 'STRICT') geminiStrictNodes.push(baseName);
      else if (geminiTier === 'FALLBACK') geminiFallbackNodes.push(baseName);

      const googleTier =
        res.google_tier ||
        res.gemini_details?.google_tier ||
        (res.gemini_details?.google_clean
          ? 'STRICT'
          : res.gemini_details?.google_reachable
            ? 'FALLBACK'
            : res.gemini_status === 'PASS'
              ? 'STRICT'
              : 'FAIL');
      if (googleTier === 'STRICT') googleStrictNodes.push(baseName);
      else if (googleTier === 'FALLBACK') googleFallbackNodes.push(baseName);

      const claudeTier = res.claude_tier || res.gemini_details?.claude_tier || 'FAIL';
      if (claudeTier === 'STRICT') claudeStrictNodes.push(baseName);

      const gptTier = res.gpt_tier || res.gemini_details?.gpt_tier || 'FAIL';
      if (gptTier === 'STRICT') gptStrictNodes.push(baseName);
    }

    const allProxyTags = proxyOutbounds.map((o) => o.tag);
    if (allProxyTags.length === 0) {
      throw new Error('Zero nodes passed real egress IP probing for sing-box');
    }

    const nonHkNodes = allProxyTags.filter((n) => !n.startsWith('HK-'));
    const aiPool = nonHkNodes.length > 0 ? nonHkNodes : allProxyTags;

    const agBuilt = SingBoxBuilder._buildTieredServiceGroups('AntiGravity', agStrictNodes, agFallbackNodes);
    const geminiBuilt = SingBoxBuilder._buildTieredServiceGroups('Gemini', geminiStrictNodes, geminiFallbackNodes);
    const googleBuilt = SingBoxBuilder._buildTieredServiceGroups('Google', googleStrictNodes, googleFallbackNodes);

    const groupOutbounds = [
      {
        type: 'selector',
        tag: '节点选择',
        outbounds: ['自动选择', ...allProxyTags],
        default: '自动选择',
      },
      {
        type: 'urltest',
        tag: '自动选择',
        outbounds: [...allProxyTags],
        url: 'http://cp.cloudflare.com/generate_204',
        interval: '5m',
        tolerance: 50,
      },
      ...agBuilt.groups,
      ...geminiBuilt.groups,
      ...googleBuilt.groups,
      ...SingBoxBuilder._buildHardServiceGroups('Claude', claudeStrictNodes),
      ...SingBoxBuilder._buildHardServiceGroups('GPT', gptStrictNodes),
      ...SingBoxBuilder._buildGeneralServiceGroup('微软', allProxyTags),
      ...SingBoxBuilder._buildGeneralServiceGroup('Apple', allProxyTags),
      ...SingBoxBuilder._buildGeneralServiceGroup('FCM', allProxyTags, ['国内直连']),
      {
        type: 'selector',
        tag: 'AI-Other',
        outbounds: ['节点选择', '自动选择', ...aiPool],
        default: '节点选择',
      },
      {
        type: 'selector',
        tag: 'YouTube',
        outbounds: ['节点选择', '自动选择', ...allProxyTags],
        default: '节点选择',
      },
      {
        type: 'selector',
        tag: 'Telegram',
        outbounds: ['节点选择', '自动选择', ...allProxyTags],
        default: '节点选择',
      },
      {
        type: 'selector',
        tag: 'GitHub',
        outbounds: ['节点选择', '自动选择', ...allProxyTags],
        default: '节点选择',
      },
    ];

    for (const [cc, list] of countryGroups.entries()) {
      const label = COUNTRY_DISPLAY[cc] || cc;
      groupOutbounds.push({
        type: 'urltest',
        tag: `${label} (实测出口)`,
        outbounds: list,
        url: 'http://cp.cloudflare.com/generate_204',
        interval: '5m',
        tolerance: 50,
      });
    }

    for (const [fName, list] of facilityGroups.entries()) {
      groupOutbounds.push({
        type: 'selector',
        tag: fName,
        outbounds: list,
        default: list[0],
      });
    }

    for (const [aName, list] of asnGroups.entries()) {
      if (list.length >= 2) {
        groupOutbounds.push({
          type: 'selector',
          tag: aName,
          outbounds: list,
          default: list[0],
        });
      }
    }

    groupOutbounds.push(
      {
        type: 'selector',
        tag: '漏网之鱼',
        outbounds: ['节点选择', '自动选择'],
        default: '节点选择',
      },
      {
        type: 'direct',
        tag: '国内直连',
      }
    );

    const targetAction = (hasPool, tag) => (hasPool ? { outbound: tag } : { action: 'reject' });

    const rules = [
      { action: 'sniff' },
      { protocol: 'dns', action: 'hijack-dns' },
      { network: 'udp', port: 443, action: 'reject' },
    ];

    const adWhitelist = options.adWhitelist || [];
    if (adWhitelist.length > 0) {
      rules.push({ domain_suffix: adWhitelist, outbound: '国内直连' });
    }
    const adBlacklist = options.adBlacklist || [];
    if (adBlacklist.length > 0) {
      rules.push({ domain_suffix: adBlacklist, action: 'reject' });
    }

    rules.push(
      { rule_set: ['geosite-category-ads-all'], action: 'reject' },
      { ip_is_private: true, outbound: '国内直连' },
      { rule_set: ['geosite-cn'], outbound: '国内直连' },

      // 1. AntiGravity (fail-closed to reject when empty)
      {
        domain_suffix: [
          'cloudaicompanion.googleapis.com',
          'cloudcode-pa.googleapis.com',
          'daily-cloudcode-pa.googleapis.com',
          'aisandbox-pa.googleapis.com',
        ],
        ...targetAction(agBuilt.hasPool, 'AntiGravity'),
      },
      {
        domain_keyword: ['cloudaicompanion', 'cloudcode', 'antigravity'],
        ...targetAction(agBuilt.hasPool, 'AntiGravity'),
      },

      // 2. Gemini (fail-closed to reject when empty)
      {
        domain: ['gemini.google.com', 'oauth2.googleapis.com', 'accounts.google.com'],
        ...targetAction(geminiBuilt.hasPool, 'Gemini'),
      },
      {
        domain_suffix: [
          'bard.google.com',
          'generativelanguage.googleapis.com',
          'proactivebackend-pa.googleapis.com',
          'alkalimakersuite-pa.googleapis.com',
          'aistudio.google.com',
          'deepmind.com',
          'deepmind.google',
        ],
        ...targetAction(geminiBuilt.hasPool, 'Gemini'),
      },
      {
        domain_keyword: ['gemini'],
        ...targetAction(geminiBuilt.hasPool, 'Gemini'),
      },

      // 3. Claude
      {
        domain: [
          'api.anthropic.com',
          'claude.com',
          'platform.claude.com',
          'sso.claude.com',
          'mcp-proxy.anthropic.com',
          'downloads.claude.ai',
          'code.claude.com',
          'bridge.claudeusercontent.com',
        ],
        outbound: 'Claude',
      },
      {
        domain_suffix: [
          'anthropic.com',
          'claude.ai',
          'claudeusercontent.com',
          'claudemcpcontent.com',
        ],
        outbound: 'Claude',
      },

      // 4. GPT / OpenAI
      { rule_set: ['geosite-openai'], outbound: 'GPT' },
      {
        domain_suffix: [
          'openai.com',
          'chatgpt.com',
          'oaistatic.com',
          'oaiusercontent.com',
          'chat.com',
        ],
        outbound: 'GPT',
      },

      // 5. Microsoft (mainland direct, global via 微软)
      { rule_set: ['geosite-microsoft@cn'], outbound: '国内直连' },
      {
        domain_suffix: ['microsoft.cn', 'azure.cn', 'office365.cn', 'office.com.cn'],
        outbound: '国内直连',
      },
      { rule_set: ['geosite-microsoft'], outbound: '微软' },
      {
        domain_suffix: [
          'microsoft.com',
          'microsoftonline.com',
          'office.com',
          'office365.com',
          'sharepoint.com',
          'teams.microsoft.com',
          'teams.cloud.microsoft',
          'live.com',
          'onedrive.com',
          '1drv.ms',
        ],
        outbound: '微软',
      },

      // 6. Apple (mainland direct, global via Apple)
      { rule_set: ['geosite-apple@cn'], outbound: '国内直连' },
      { domain_suffix: ['apple.cn', 'apple.com.cn'], outbound: '国内直连' },
      { rule_set: ['geosite-apple'], outbound: 'Apple' },
      {
        domain_suffix: [
          'apple.com',
          'icloud.com',
          'mzstatic.com',
          'itunes.apple.com',
          'apps.apple.com',
          'apple-mapkit.com',
        ],
        outbound: 'Apple',
      },

      // 7. FCM (before broad Google)
      { rule_set: ['geosite-googlefcm'], outbound: 'FCM' },
      {
        domain: [
          'alt1-mtalk.google.com',
          'alt2-mtalk.google.com',
          'alt3-mtalk.google.com',
          'alt4-mtalk.google.com',
          'alt5-mtalk.google.com',
          'alt6-mtalk.google.com',
          'alt7-mtalk.google.com',
          'alt8-mtalk.google.com',
          'mtalk-dev.google.com',
          'mtalk-staging.google.com',
        ],
        outbound: 'FCM',
      },
      {
        domain_suffix: [
          'fcm.googleapis.com',
          'iid.googleapis.com',
          'firebaseinstallations.googleapis.com',
          'mtalk.google.com',
          'mtalk4.google.com',
          'android.apis.google.com',
          'device-provisioning.googleapis.com',
        ],
        outbound: 'FCM',
      },

      // 8. YouTube / Google / Telegram / GitHub
      { rule_set: ['geosite-youtube'], outbound: 'YouTube' },
      { rule_set: ['geosite-google'], ...targetAction(googleBuilt.hasPool, 'Google') },
      {
        domain_suffix: ['google.com', 'googleapis.com', 'gstatic.com'],
        ...targetAction(googleBuilt.hasPool, 'Google'),
      },
      { rule_set: ['geosite-telegram', 'geoip-telegram'], outbound: 'Telegram' },
      { rule_set: ['geosite-github'], outbound: 'GitHub' },

      // 9. China IP fallback after all service rules
      { rule_set: ['geoip-cn'], outbound: '国内直连' }
    );

    const ruleSets = [
      makeRuleSet('geosite-category-ads-all', 'geosite', 'category-ads-all'),
      makeRuleSet('geosite-cn', 'geosite', 'cn'),
      makeRuleSet('geosite-openai', 'geosite', 'openai'),
      makeRuleSet('geosite-microsoft@cn', 'geosite', 'microsoft@cn'),
      makeRuleSet('geosite-microsoft', 'geosite', 'microsoft'),
      makeRuleSet('geosite-apple@cn', 'geosite', 'apple@cn'),
      makeRuleSet('geosite-apple', 'geosite', 'apple'),
      makeRuleSet('geosite-googlefcm', 'geosite', 'googlefcm'),
      makeRuleSet('geosite-youtube', 'geosite', 'youtube'),
      makeRuleSet('geosite-google', 'geosite', 'google'),
      makeRuleSet('geosite-telegram', 'geosite', 'telegram'),
      makeRuleSet('geoip-telegram', 'geoip', 'telegram'),
      makeRuleSet('geosite-github', 'geosite', 'github'),
      makeRuleSet('geoip-cn', 'geoip', 'cn'),
    ];

    return {
      log: {
        level: 'info',
        timestamp: true,
      },
      dns: {
        servers: [
          {
            type: 'udp',
            tag: 'dns-direct',
            server: '223.5.5.5',
            server_port: 53,
          },
          {
            type: 'https',
            tag: 'dns-remote',
            server: '1.1.1.1',
            server_port: 443,
            path: '/dns-query',
            detour: '节点选择',
          },
          {
            type: 'fakeip',
            tag: 'dns-fakeip',
            inet4_range: '198.18.0.0/15',
          },
        ],
        rules: [
          {
            domain_suffix: ['lan', 'localhost.ptlogin2.qq.com'],
            server: 'dns-direct',
          },
          {
            rule_set: ['geosite-cn'],
            server: 'dns-direct',
          },
          {
            query_type: ['A', 'AAAA'],
            server: 'dns-fakeip',
          },
        ],
        final: 'dns-remote',
        strategy: 'ipv4_only',
        independent_cache: true,
      },
      inbounds: [
        {
          type: 'mixed',
          tag: 'mixed-in',
          listen: '127.0.0.1',
          listen_port: 7890,
        },
        {
          type: 'redirect',
          tag: 'redirect-in',
          listen: '::',
          listen_port: 7892,
        },
        {
          type: 'tproxy',
          tag: 'tproxy-in',
          listen: '::',
          listen_port: 7893,
        },
      ],
      outbounds: [...groupOutbounds, ...proxyOutbounds],
      route: {
        auto_detect_interface: true,
        default_domain_resolver: 'dns-direct',
        final: '漏网之鱼',
        rules,
        rule_set: ruleSets,
      },
      experimental: {
        cache_file: {
          enabled: true,
        },
        clash_api: {
          external_controller: '127.0.0.1:9090',
        },
      },
    };
  }
}
