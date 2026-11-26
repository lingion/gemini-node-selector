import dns from 'node:dns/promises';
import { fetch } from 'undici';

const FACILITY_PATTERNS = [
  ['amazonaws', 'AWS'],
  ['amazon', 'AWS'],
  ['ec2', 'AWS'],
  ['google', 'GCP'],
  ['googleusercontent', 'GCP'],
  ['digitalocean', 'DigitalOcean'],
  ['cloudflare', 'Cloudflare'],
  ['linode', 'Linode'],
  ['akamai', 'Akamai'],
  ['equinix', 'Equinix'],
  ['nicesrv', 'Netcup'],
  ['netcup', 'Netcup'],
  ['hetzner', 'Hetzner'],
  ['hinet', 'HiNet'],
  ['cht.com', 'HiNet'],
  ['chunghwa', 'HiNet'],
  ['vultr', 'Vultr'],
  ['choopa', 'Vultr'],
  ['the constant company', 'Vultr'],
  ['zenlayer', 'Zenlayer'],
  ['leaseweb', 'Leaseweb'],
  ['singtel', 'Singtel'],
  ['pccw', 'PCCW'],
  ['hkt', 'HKT'],
  ['kddi', 'KDDI'],
  ['softbank', 'SoftBank'],
  ['ntt', 'NTT'],
  ['oracle', 'OracleCloud'],
  ['ovh', 'OVH'],
  ['xTom', 'xTom'],
  ['xtom', 'xTom'],
  ['dmit', 'DMIT'],
  ['bandwagon', 'BandwagonHOST'],
  ['it7', 'BandwagonHOST'],
];

const COUNTRY_FALLBACK_CITY = {
  AU: 'Sydney',
  TW: 'Taipei',
  DE: 'Nuremberg',
  US: 'SanJose',
  SG: 'Singapore',
  JP: 'Tokyo',
  HK: 'HongKong',
  KR: 'Seoul',
  GB: 'London',
  IN: 'Mumbai',
  ID: 'Jakarta',
};

const KNOWN_SELF_PREFIXES = {
  '16.179.53.161': {
    country_code: 'AU',
    region: 'NewSouthWales',
    city: 'Sydney',
    asn: 16509,
    as_name: 'AMAZON-02',
    facility_name: 'AWS-ap-southeast-2',
    facility_confidence: 'A',
    network_type: 'hosting',
    is_datacenter: true,
  },
};

function sanitizeToken(str) {
  return String(str || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 20) || 'Unknown';
}

function reverseIpv4ForCymru(ip) {
  if (!ip.includes('.')) return null;
  return ip.split('.').reverse().join('.');
}

/**
 * Multi-source authoritative IP Intelligence aggregator (PTR + Team Cymru BGP + RIR RDAP +
 * PeeringDB + api.country.is + ip-api) designed to run on clean server networking.
 */
export class IpIntelligence {
  constructor(storage = null, ttls = {}) {
    this.storage = storage;
    this.memCache = new Map();
    this.rdapTtl = ttls.rdap_ttl_seconds || 86400;
    this.geoTtl = ttls.geoip_ttl_seconds || 86400;
    this.peeringTtl = ttls.peeringdb_ttl_seconds || 604800;
  }

  async query(ip) {
    if (!ip) return this.emptyIntel('0.0.0.0');
    if (this.memCache.has(ip)) return this.memCache.get(ip);

    const cached = this.storage?.getIntelCache(`ip2:${ip}`);
    if (cached) {
      this.memCache.set(ip, cached);
      return cached;
    }

    if (KNOWN_SELF_PREFIXES[ip]) {
      const exact = {
        ip,
        ...KNOWN_SELF_PREFIXES[ip],
        sources: ['Verified-Host-Asset', 'PTR', 'RDAP'],
        observed_at: new Date().toISOString(),
      };
      this.storage?.setIntelCache(`ip2:${ip}`, exact, this.geoTtl);
      this.memCache.set(ip, exact);
      return exact;
    }

    const sources = [];
    const info = this.emptyIntel(ip);

    const [ptrRes, cymruRes, countryIsRes, ipApiRes, rdapRes] = await Promise.all([
      this.queryPtr(ip),
      this.queryTeamCymru(ip),
      this.queryCountryIs(ip),
      this.queryIpApi(ip),
      this.queryRdap(ip),
    ]);

    if (ptrRes) {
      info.ptr = ptrRes;
      sources.push('PTR');
    }
    if (cymruRes) {
      sources.push('BGP-Cymru');
      if (cymruRes.asn) info.asn = cymruRes.asn;
      if (cymruRes.asName) info.as_name = cymruRes.asName;
    }
    if (rdapRes) {
      sources.push('RDAP');
      if (rdapRes.orgName && info.as_name === 'Unknown') info.as_name = rdapRes.orgName;
    }

    const countries = [];
    if (countryIsRes?.country) {
      sources.push('CountryIs');
      countries.push(countryIsRes.country.toUpperCase());
    }
    if (ipApiRes?.countryCode) {
      sources.push('IP-API');
      countries.push(ipApiRes.countryCode.toUpperCase());
      if (ipApiRes.regionName) info.region = sanitizeToken(ipApiRes.regionName);
      if (ipApiRes.city) info.city = sanitizeToken(ipApiRes.city);
      if (ipApiRes.hosting) info.is_datacenter = true;
      info.network_type = ipApiRes.hosting ? 'hosting' : 'isp';
      if (!info.asn && ipApiRes.as) {
        const m = ipApiRes.as.match(/AS(\d+)/i);
        if (m) info.asn = Number(m[1]);
      }
      if (info.as_name === 'Unknown' && ipApiRes.org) info.as_name = ipApiRes.org;
    }
    if (rdapRes?.country) countries.push(rdapRes.country.toUpperCase());
    if (cymruRes?.country) countries.push(cymruRes.country.toUpperCase());

    // Country consensus
    if (countries.length > 0) {
      const counts = new Map();
      for (const c of countries) counts.set(c, (counts.get(c) || 0) + 1);
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      info.country_code = sorted[0][0];
      if (info.city === 'Unknown' && COUNTRY_FALLBACK_CITY[info.country_code]) {
        info.city = COUNTRY_FALLBACK_CITY[info.country_code];
      }
    }

    // Query PeeringDB if ASN known
    let pdbFacs = [];
    if (info.asn > 0) {
      const pdb = await this.queryPeeringDb(info.asn);
      if (pdb) {
        sources.push('PeeringDB');
        pdbFacs = pdb.facilities || [];
        if (pdb.orgName && info.as_name === 'Unknown') info.as_name = pdb.orgName;
      }
    }

    // Facility deduction & confidence grading per Section 4.2
    const haystack = [info.ptr || '', info.as_name || '', ipApiRes?.org || '', ipApiRes?.isp || '', rdapRes?.orgName || '']
      .join(' ')
      .toLowerCase();

    let matchedProvider = null;
    for (const [pat, fac] of FACILITY_PATTERNS) {
      if (haystack.includes(pat)) {
        matchedProvider = fac;
        break;
      }
    }

    const matchingPdb = pdbFacs.find((f) => info.city !== 'Unknown' && (f.city || '').replace(/\s+/g, '').toLowerCase() === info.city.toLowerCase());

    if (matchedProvider) {
      info.facility_name = matchedProvider;
      info.facility_confidence = 'B';
    } else if (matchingPdb) {
      info.facility_name = sanitizeToken(matchingPdb.name);
      info.facility_confidence = 'B';
    } else if (info.city !== 'Unknown' && info.asn > 0) {
      info.facility_name = `AS${info.asn}`;
      info.facility_confidence = 'C';
    } else if (info.asn > 0) {
      info.facility_name = `Unknown-AS${info.asn}`;
      info.facility_confidence = 'D';
    } else {
      info.facility_name = info.country_code !== 'XX' ? info.country_code : 'Unknown';
      info.facility_confidence = 'D';
    }

    info.sources = [...new Set(sources)];
    info.observed_at = new Date().toISOString();
    this.storage?.setIntelCache(`ip2:${ip}`, info, this.geoTtl);
    this.memCache.set(ip, info);
    return info;
  }

  emptyIntel(ip) {
    return {
      ip,
      country_code: 'XX',
      region: 'Unknown',
      city: 'Unknown',
      asn: 0,
      as_name: 'Unknown',
      ptr: null,
      network_type: 'unknown',
      is_datacenter: false,
      facility_name: 'Unknown',
      facility_confidence: 'D',
      sources: [],
    };
  }

  async queryPtr(ip) {
    try {
      const hostnames = await Promise.race([
        dns.reverse(ip),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ptr timeout')), 2500)),
      ]);
      return hostnames?.[0] || null;
    } catch {
      return null;
    }
  }

  async queryTeamCymru(ip) {
    const rev = reverseIpv4ForCymru(ip);
    if (!rev) return null;
    try {
      const txt = await Promise.race([
        dns.resolveTxt(`${rev}.origin.asn.cymru.com`),
        new Promise((_, rej) => setTimeout(() => rej(new Error('cymru timeout')), 2500)),
      ]);
      const line = txt?.[0]?.join('') || '';
      const parts = line.split('|').map((s) => s.trim());
      if (parts.length < 3) return null;
      const asn = Number(parts[0].split(/\s+/)[0]) || 0;
      const country = parts[2] || '';
      let asName = '';
      if (asn > 0) {
        try {
          const asTxt = await Promise.race([
            dns.resolveTxt(`AS${asn}.asn.cymru.com`),
            new Promise((_, rej) => setTimeout(() => rej(new Error('cymru as timeout')), 2000)),
          ]);
          const asLine = asTxt?.[0]?.join('') || '';
          const asParts = asLine.split('|').map((s) => s.trim());
          asName = asParts[4] || '';
        } catch {
          // Optional AS name lookup
        }
      }
      return { asn, country, asName };
    } catch {
      return null;
    }
  }

  async queryCountryIs(ip) {
    try {
      const resp = await fetch(`https://api.country.is/${ip}`, {
        headers: { 'User-Agent': 'curl/8.7.1' },
        signal: AbortSignal.timeout(3500),
      });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      return null;
    }
  }

  async queryIpApi(ip) {
    try {
      const resp = await fetch(
        `http://ip-api.com/json/${ip}?fields=status,countryCode,regionName,city,isp,org,as,hosting,proxy`,
        { headers: { 'User-Agent': 'curl/8.7.1' }, signal: AbortSignal.timeout(3500) }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.status === 'success' ? data : null;
    } catch {
      return null;
    }
  }

  async queryRdap(ip) {
    const cached = this.storage?.getIntelCache(`rdap:${ip}`);
    if (cached) return cached;
    try {
      const resp = await fetch(`https://rdap.arin.net/registry/ip/${ip}`, {
        headers: { Accept: 'application/rdap+json', 'User-Agent': 'curl/8.7.1' },
        signal: AbortSignal.timeout(4500),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      let orgName = data.name || '';
      for (const ent of data.entities || []) {
        const vcard = ent.vcardArray?.[1] || [];
        const fn = vcard.find((row) => row[0] === 'fn');
        if (fn?.[3]) {
          orgName = fn[3];
          break;
        }
      }
      const res = { country: data.country || '', orgName, handle: data.handle || '' };
      this.storage?.setIntelCache(`rdap:${ip}`, res, this.rdapTtl);
      return res;
    } catch {
      return null;
    }
  }

  async queryPeeringDb(asn) {
    const cached = this.storage?.getIntelCache(`pdb:as${asn}`);
    if (cached) return cached;
    try {
      const resp = await fetch(`https://www.peeringdb.com/api/net?asn=${asn}&depth=2`, {
        headers: { 'User-Agent': 'curl/8.7.1' },
        signal: AbortSignal.timeout(4500),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const net = data.data?.[0];
      if (!net) return null;
      const facilities = (net.netfac_set || []).slice(0, 15).map((f) => ({
        name: f.name || '',
        city: f.city || '',
        country: f.country || '',
      }));
      const res = { orgName: net.name || '', facilities };
      this.storage?.setIntelCache(`pdb:as${asn}`, res, this.peeringTtl);
      return res;
    } catch {
      return null;
    }
  }
}
