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

function sanitizeName(name) {
  return String(name || '')
    .replace(/[:{}\[\],&*#?|<>!=%@`"'\\]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 62);
}

/**
 * Generates automatic node names strictly from probed egress IP & facility confidence
 * and compiles 3-layer Mihomo strategy groups + rules with zero DIRECT leakage.
 */
export class GroupBuilder {
  static _buildTieredServiceGroups(prefix, strictList, fallbackList) {
    const anyList = [...strictList, ...fallbackList];
    const hasStrict = strictList.length > 0;
    const hasAny = anyList.length > 0;
    const strictPool = hasStrict ? [...strictList] : ['REJECT'];
    const anyPool = hasAny ? [...anyList] : ['REJECT'];

    const autoName = `${prefix}-严选自动`;
    const fbName = `${prefix}-严选故障转移`;
    const strictName = `${prefix}-严选`;
    const nonStrictName = `${prefix}-非严选`;

    let topProxies;
    if (!hasAny) {
      topProxies = ['REJECT'];
    } else if (hasStrict) {
      topProxies = [autoName, fbName, strictName, nonStrictName];
    } else {
      topProxies = [nonStrictName, autoName, fbName, strictName];
    }

    return [
      {
        name: prefix,
        type: 'select',
        proxies: topProxies,
      },
      {
        name: autoName,
        type: 'url-test',
        url: 'http://cp.cloudflare.com/generate_204',
        interval: 300,
        tolerance: 50,
        proxies: strictPool,
      },
      {
        name: fbName,
        type: 'fallback',
        url: 'http://cp.cloudflare.com/generate_204',
        interval: 300,
        proxies: strictPool,
      },
      {
        name: strictName,
        type: 'select',
        proxies: strictPool,
      },
      {
        name: nonStrictName,
        type: 'select',
        proxies: anyPool,
      },
    ];
  }

  static buildFromProbedNodes(probedResults, options = {}) {
    const activeNodes = [];
    const agStrictNodes = [];
    const agFallbackNodes = [];
    const geminiStrictNodes = [];
    const geminiFallbackNodes = [];
    const googleStrictNodes = [];
    const googleFallbackNodes = [];
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

      // Grade B gets -B suffix per Section 6.1; Grade C/D use City-ASN/Unknown without fabricating facility names
      let facLabel = fac;
      if (grade === 'B') facLabel = `${fac}-Inferred`;
      else if (grade === 'C' && res.asn > 0) facLabel = `AS${res.asn}`;
      else if (grade === 'D') facLabel = res.asn > 0 ? `Unknown-AS${res.asn}` : `Unknown`;

      let baseName = sanitizeName(`${cc}-${city}-${facLabel}-${lastOctet}-${String(seq).padStart(2, '0')}`);
      while (seenNames.has(baseName)) {
        const alt = `${baseName}-x`;
        baseName = alt.slice(0, 62);
      }
      seenNames.add(baseName);

      rawNode.name = baseName;
      rawNode.udp = true;
      activeNodes.push(rawNode);

      if (!countryGroups.has(cc)) countryGroups.set(cc, []);
      countryGroups.get(cc).push(baseName);

      // Section 6.2: Only A and B confidence enter specific facility groups
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
    }

    const allProxyNames = activeNodes.map((n) => n.name);
    if (allProxyNames.length === 0) {
      throw new Error('Zero nodes passed real egress IP probing');
    }

    const nonHkNodes = allProxyNames.filter((n) => !n.startsWith('HK-'));
    const aiPool = nonHkNodes.length > 0 ? nonHkNodes : allProxyNames;

    const proxyGroups = [
      {
        name: '节点选择',
        type: 'select',
        proxies: ['自动选择', '故障转移', ...allProxyNames],
      },
      {
        name: '自动选择',
        type: 'url-test',
        url: 'http://cp.cloudflare.com/generate_204',
        interval: 300,
        tolerance: 50,
        proxies: [...allProxyNames],
      },
      {
        name: '故障转移',
        type: 'fallback',
        url: 'http://cp.cloudflare.com/generate_204',
        interval: 300,
        proxies: [...allProxyNames],
      },
      // Tiered service groups (strictest -> loosest): AntiGravity > Gemini > Google
      // Empty pools fail closed to REJECT; never mix unverified nodes or DIRECT.
      ...GroupBuilder._buildTieredServiceGroups('AntiGravity', agStrictNodes, agFallbackNodes),
      ...GroupBuilder._buildTieredServiceGroups('Gemini', geminiStrictNodes, geminiFallbackNodes),
      ...GroupBuilder._buildTieredServiceGroups('Google', googleStrictNodes, googleFallbackNodes),
      {
        name: 'AI-Other',
        type: 'select',
        proxies: ['节点选择', '自动选择', ...aiPool],
      },
      {
        name: 'YouTube',
        type: 'select',
        proxies: ['节点选择', '自动选择', ...allProxyNames],
      },
      {
        name: 'Telegram',
        type: 'select',
        proxies: ['节点选择', '自动选择', ...allProxyNames],
      },
      {
        name: 'GitHub',
        type: 'select',
        proxies: ['节点选择', '自动选择', ...allProxyNames],
      },
    ];

    // Geographic Groups (strictly from real probed egress IP)
    for (const [cc, list] of countryGroups.entries()) {
      const label = COUNTRY_DISPLAY[cc] || cc;
      proxyGroups.push({
        name: `${label} (实测出口)`,
        type: 'url-test',
        url: 'http://cp.cloudflare.com/generate_204',
        interval: 300,
        tolerance: 50,
        proxies: list,
      });
    }

    // Verified/Inferred Facility Groups (Grade A/B only)
    for (const [fName, list] of facilityGroups.entries()) {
      proxyGroups.push({
        name: fName,
        type: 'select',
        proxies: list,
      });
    }

    // Major ASN Groups (>= 2 nodes)
    for (const [aName, list] of asnGroups.entries()) {
      if (list.length >= 2) {
        proxyGroups.push({
          name: aName,
          type: 'select',
          proxies: list,
        });
      }
    }

    // Domestic, Toggleable Ads (Section 8.2), and Final Fallback
    proxyGroups.push(
      {
        name: '国内直连',
        type: 'select',
        proxies: ['DIRECT'],
      },
      {
        name: '广告拦截',
        type: 'select',
        proxies: ['REJECT', 'PASS', '国内直连'],
      },
      {
        name: '漏网之鱼',
        type: 'select',
        proxies: ['节点选择', '自动选择'],
      }
    );

    // Rules strictly ordered per Section 7.3, 8.1 & Antigravity endpoints
    const adWhitelistRules = (options.adWhitelist || []).map((d) => `DOMAIN-SUFFIX,${d},国内直连`);
    const adBlacklistRules = (options.adBlacklist || []).map((d) => `DOMAIN-SUFFIX,${d},广告拦截`);

    const rules = [
      'AND,((NETWORK,udp),(DST-PORT,443)),REJECT',
      ...adWhitelistRules,
      ...adBlacklistRules,
      'GEOSITE,category-ads-all,广告拦截',

      // 1. Strictest: AntiGravity / Gemini Code Assist endpoints BEFORE Gemini & broad Google
      'DOMAIN-SUFFIX,cloudaicompanion.googleapis.com,AntiGravity',
      'DOMAIN-SUFFIX,cloudcode-pa.googleapis.com,AntiGravity',
      'DOMAIN-SUFFIX,daily-cloudcode-pa.googleapis.com,AntiGravity',
      'DOMAIN-SUFFIX,aisandbox-pa.googleapis.com,AntiGravity',
      'DOMAIN-KEYWORD,cloudaicompanion,AntiGravity',
      'DOMAIN-KEYWORD,cloudcode,AntiGravity',
      'DOMAIN-KEYWORD,antigravity,AntiGravity',

      // 2. Medium: Gemini Web & AI Studio BEFORE broad Google
      'DOMAIN,gemini.google.com,Gemini',
      'DOMAIN-SUFFIX,bard.google.com,Gemini',
      'DOMAIN-SUFFIX,generativelanguage.googleapis.com,Gemini',
      'DOMAIN-SUFFIX,proactivebackend-pa.googleapis.com,Gemini',
      'DOMAIN-SUFFIX,alkalimakersuite-pa.googleapis.com,Gemini',
      'DOMAIN-SUFFIX,aistudio.google.com,Gemini',
      'DOMAIN-KEYWORD,gemini,Gemini',
      'DOMAIN,oauth2.googleapis.com,Gemini',
      'DOMAIN,accounts.google.com,Gemini',
      'DOMAIN-SUFFIX,deepmind.com,Gemini',
      'DOMAIN-SUFFIX,deepmind.google,Gemini',

      // Non-Gemini AI
      'GEOSITE,openai,AI-Other',
      'DOMAIN-SUFFIX,openai.com,AI-Other',
      'DOMAIN-SUFFIX,chatgpt.com,AI-Other',
      'DOMAIN-SUFFIX,anthropic.com,AI-Other',
      'DOMAIN-SUFFIX,claude.ai,AI-Other',

      // 3. Streaming / Loosest Google (verified Google-reachable only) / Dev
      'GEOSITE,youtube,YouTube',
      'GEOSITE,google,Google',
      'DOMAIN-SUFFIX,google.com,Google',
      'DOMAIN-SUFFIX,googleapis.com,Google',
      'DOMAIN-SUFFIX,gstatic.com,Google',
      'GEOSITE,telegram,Telegram',
      'GEOIP,telegram,Telegram',
      'GEOSITE,github,GitHub',

      // Domestic & LAN (DIRECT strictly isolated here)
      'IP-CIDR,127.0.0.0/8,国内直连',
      'IP-CIDR,172.16.0.0/12,国内直连',
      'IP-CIDR,192.168.0.0/16,国内直连',
      'IP-CIDR,10.0.0.0/8,国内直连',
      'GEOIP,LAN,国内直连,no-resolve',
      'GEOSITE,cn,国内直连',
      'GEOIP,CN,国内直连',

      // Final Fallback (Never DIRECT!)
      'MATCH,漏网之鱼',
    ];

    return {
      port: 7890,
      'socks-port': 7891,
      'mixed-port': 7890,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'info',
      ipv6: false,
      'external-controller': '127.0.0.1:9090',
      'tcp-concurrent': true,
      'unified-delay': true,
      dns: {
        enable: true,
        listen: '0.0.0.0:1053',
        ipv6: false,
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        'fake-ip-filter': ['*.lan', 'localhost.ptlogin2.qq.com'],
        nameserver: ['223.5.5.5', '119.29.29.29'],
        'proxy-server-nameserver': ['223.5.5.5', '119.29.29.29'],
      },
      proxies: activeNodes,
      'proxy-groups': proxyGroups,
      rules,
    };
  }
}
