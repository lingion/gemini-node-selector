import yaml from 'js-yaml';

/**
 * Multi-format upstream proxy subscription parser (Clash YAML, Base64, URI lists).
 * Supports Hysteria2, Trojan, VLESS (Reality/TLS/WS), VMess, and Shadowsocks.
 */
export class Parser {
  static parse(payload) {
    if (Array.isArray(payload)) {
      return payload.filter((x) => x && typeof x === 'object');
    }
    if (typeof payload !== 'string') return [];
    const text = payload.trim();
    if (!text) return [];

    // 1. Clash YAML
    if (text.includes('proxies:') || text.startsWith('-')) {
      try {
        const data = yaml.load(text);
        if (data && typeof data === 'object') {
          if (Array.isArray(data.proxies)) {
            return data.proxies.filter((p) => p && typeof p === 'object');
          }
          if (Array.isArray(data)) {
            return data.filter((p) => p && typeof p === 'object');
          }
        }
      } catch {
        // Fallback to Base64 / plain URI parsing
      }
    }

    // 2. Base64-encoded URI list
    if (!text.includes('://')) {
      try {
        const clean = text.replace(/\s+/g, '');
        const decoded = Buffer.from(clean, 'base64').toString('utf8');
        if (decoded.includes('://')) {
          return Parser.parseUriList(decoded);
        }
      } catch {
        // Ignore invalid base64
      }
    }

    // 3. Direct URI list
    if (text.includes('://')) {
      return Parser.parseUriList(text);
    }
    return [];
  }

  static parseUriList(content) {
    const out = [];
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const p = Parser.parseSingleUri(line);
        if (p) out.push(p);
      } catch {
        // Skip malformed URI entries
      }
    }
    return out;
  }

  static parseSingleUri(uri) {
    if (uri.startsWith('hysteria2://') || uri.startsWith('hy2://')) return Parser.parseHysteria2(uri);
    if (uri.startsWith('trojan://')) return Parser.parseTrojan(uri);
    if (uri.startsWith('vless://')) return Parser.parseVless(uri);
    if (uri.startsWith('vmess://')) return Parser.parseVmess(uri);
    if (uri.startsWith('ss://')) return Parser.parseShadowsocks(uri);
    return null;
  }

  static parseHysteria2(uri) {
    const u = new URL(uri);
    const qs = u.searchParams;
    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `hy2-${u.hostname}:${u.port || 443}`;
    const node = {
      name,
      type: 'hysteria2',
      server: u.hostname,
      port: Number(u.port) || 443,
      password: decodeURIComponent(u.username || ''),
      udp: true,
      'skip-cert-verify': ['1', 'true'].includes((qs.get('insecure') || '').toLowerCase()),
    };
    if (qs.get('sni')) node.sni = qs.get('sni');
    if (qs.get('obfs')) node.obfs = qs.get('obfs');
    if (qs.get('obfs-password')) node['obfs-password'] = qs.get('obfs-password');
    return node;
  }

  static parseTrojan(uri) {
    const u = new URL(uri);
    const qs = u.searchParams;
    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `trojan-${u.hostname}:${u.port || 443}`;
    const node = {
      name,
      type: 'trojan',
      server: u.hostname,
      port: Number(u.port) || 443,
      password: decodeURIComponent(u.username || ''),
      udp: true,
      'skip-cert-verify': ['1', 'true'].includes((qs.get('allowInsecure') || qs.get('insecure') || '').toLowerCase()),
    };
    const sni = qs.get('sni') || qs.get('peer');
    if (sni) node.sni = sni;
    const netType = qs.get('type') || 'tcp';
    if (netType === 'ws') {
      node.network = 'ws';
      node['ws-opts'] = {
        path: qs.get('path') || '/',
        headers: { Host: qs.get('host') || sni || u.hostname },
      };
    } else if (netType === 'grpc') {
      node.network = 'grpc';
      node['grpc-opts'] = { 'grpc-service-name': qs.get('serviceName') || '' };
    }
    return node;
  }

  static parseVless(uri) {
    const u = new URL(uri);
    const qs = u.searchParams;
    const name = u.hash ? decodeURIComponent(u.hash.slice(1)) : `vless-${u.hostname}:${u.port || 443}`;
    const node = {
      name,
      type: 'vless',
      server: u.hostname,
      port: Number(u.port) || 443,
      uuid: decodeURIComponent(u.username || ''),
      udp: true,
      'skip-cert-verify': ['1', 'true'].includes((qs.get('allowInsecure') || qs.get('insecure') || '').toLowerCase()),
    };
    if (qs.get('flow')) node.flow = qs.get('flow');
    if (qs.get('sni')) {
      node.servername = qs.get('sni');
      node.sni = qs.get('sni');
    }
    const sec = qs.get('security');
    if (sec === 'tls' || sec === 'reality') node.tls = true;
    if (sec === 'reality') {
      node['reality-opts'] = {
        'public-key': qs.get('pbk') || '',
        'short-id': qs.get('sid') || '',
      };
    }
    if (qs.get('fp')) node['client-fingerprint'] = qs.get('fp');
    const netType = qs.get('type') || 'tcp';
    if (netType === 'ws') {
      node.network = 'ws';
      node['ws-opts'] = {
        path: qs.get('path') || '/',
        headers: { Host: qs.get('host') || qs.get('sni') || u.hostname },
      };
    } else if (netType === 'grpc') {
      node.network = 'grpc';
      node['grpc-opts'] = { 'grpc-service-name': qs.get('serviceName') || '' };
    }
    return node;
  }

  static parseVmess(uri) {
    const b64 = uri.slice(8).trim();
    const info = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const node = {
      name: info.ps || `vmess-${info.add}:${info.port}`,
      type: 'vmess',
      server: info.add,
      port: Number(info.port) || 443,
      uuid: info.id,
      alterId: Number(info.aid) || 0,
      cipher: info.scy || 'auto',
      udp: true,
      tls: info.tls === 'tls',
      network: info.net || 'tcp',
    };
    if (info.sni) node.servername = info.sni;
    if (info.net === 'ws') {
      node['ws-opts'] = {
        path: info.path || '/',
        headers: { Host: info.host || info.sni || info.add },
      };
    }
    return node;
  }

  static parseShadowsocks(uri) {
    const hashIdx = uri.indexOf('#');
    const name = hashIdx >= 0 ? decodeURIComponent(uri.slice(hashIdx + 1)) : 'ss-node';
    const mainPart = (hashIdx >= 0 ? uri.slice(5, hashIdx) : uri.slice(5)).split('?')[0];
    let userInfo, hostPort;
    if (mainPart.includes('@')) {
      const [u, h] = mainPart.split('@');
      userInfo = Buffer.from(u, 'base64').toString('utf8');
      hostPort = h;
    } else {
      const dec = Buffer.from(mainPart, 'base64').toString('utf8');
      const atIdx = dec.lastIndexOf('@');
      userInfo = dec.slice(0, atIdx);
      hostPort = dec.slice(atIdx + 1);
    }
    const colonIdx = userInfo.indexOf(':');
    const cipher = userInfo.slice(0, colonIdx);
    const password = userInfo.slice(colonIdx + 1);
    const lastColon = hostPort.lastIndexOf(':');
    const server = hostPort.slice(0, lastColon).replace(/^\[|\]$/g, '');
    const port = Number(hostPort.slice(lastColon + 1)) || 443;
    return { name, type: 'ss', server, port, cipher, password, udp: true };
  }
}
