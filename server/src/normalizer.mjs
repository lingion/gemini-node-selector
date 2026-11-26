import crypto from 'node:crypto';

const JUNK_REGEX = /剩余流量|重置|到期|官网|最新修改|节点全红|请更新|过滤掉|官方|群|网站|频道|说明|提示|通知|Notice|Expire|Traffic|Reset|http|续费|入口|导航|防失联|套餐/i;

/**
 * Normalizes upstream proxy definitions and derives a keyed HMAC-SHA256 fingerprint
 * so raw passwords/UUIDs are never leaked in logs or public APIs.
 */
export class Normalizer {
  static hmacSecret = crypto.randomBytes(32);

  static setHmacSecret(secret) {
    if (secret) Normalizer.hmacSecret = Buffer.from(String(secret), 'utf8');
  }

  static calculateFingerprint(p) {
    const core = [
      p.type || '',
      p.server || '',
      String(p.port || ''),
      p.uuid || p.password || '',
      p.network || 'tcp',
      p.sni || p.servername || '',
      p['ws-opts']?.path || '',
    ].join('|');
    return crypto.createHmac('sha256', Normalizer.hmacSecret).update(core).digest('hex').slice(0, 16);
  }

  static normalizeNode(rawNode, sourcePrefix, sourceId) {
    if (!rawNode || typeof rawNode !== 'object') return { valid: false };
    const origName = String(rawNode.name || '').trim();
    if (!origName || JUNK_REGEX.test(origName)) return { valid: false };
    if (!rawNode.server || !rawNode.port || !rawNode.type) return { valid: false };

    const portNum = Number(rawNode.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return { valid: false };

    const node = structuredClone(rawNode);
    node.port = portNum;
    node.udp = true;
    const cleanedOrig = origName.replace(/[\s\t]+/g, ' ');
    node.name = `${sourcePrefix} ${cleanedOrig}`.trim();

    return {
      valid: true,
      meta: {
        fingerprint: Normalizer.calculateFingerprint(node),
        sourceId,
        originalName: origName,
        sourceName: node.name,
        proxyDict: node,
      },
    };
  }
}
