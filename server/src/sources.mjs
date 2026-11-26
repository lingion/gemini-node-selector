import fs from 'node:fs';
import { Agent, fetch } from 'undici';

/**
 * Fetches all configured upstream sources (airports + self-built local entries).
 * Secrets/subscription URLs are kept out of logs to respect security boundaries.
 */
export class SourceFetcher {
  constructor(sourcesConfigPath, sourcesConfig = null) {
    this.sourcesConfigPath = sourcesConfigPath;
    this.sourcesConfig = sourcesConfig;
  }

  loadConfig() {
    if (this.sourcesConfig) return this.sourcesConfig;
    const raw = fs.readFileSync(this.sourcesConfigPath, 'utf8');
    return JSON.parse(raw);
  }

  async fetchAll() {
    const cfg = this.loadConfig();
    const results = [];
    for (const src of cfg.sources || []) {
      if (src.enabled === false) continue;
      const prefix = src.prefix || `[${src.id}]`;
      if (src.type === 'local') {
        results.push({
          sourceId: src.id,
          name: src.name,
          prefix,
          type: 'clash_proxies',
          data: src.nodes || [],
        });
      } else if (src.type === 'subscription') {
        try {
          const payload = await this.fetchUrl(src.url, Boolean(src.skip_cert_verify));
          results.push({
            sourceId: src.id,
            name: src.name,
            prefix,
            type: 'raw_payload',
            data: payload,
          });
        } catch (err) {
          console.error(`[sources] Failed to fetch source ${src.id}: ${err.message}`);
        }
      }
    }
    return results;
  }

  async fetchUrl(url, skipVerify = false) {
    const dispatcher = skipVerify
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
    try {
      const resp = await fetch(url, {
        dispatcher,
        headers: {
          'User-Agent': 'clash-verge/v2.0.0 mihomo/1.19.34',
          Accept: '*/*',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.text();
    } finally {
      if (dispatcher) await dispatcher.close();
    }
  }
}
