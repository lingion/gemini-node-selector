import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import yaml from 'js-yaml';

const execFileAsync = promisify(execFile);

const ALLOWED_DIRECT_GROUPS = new Set(['国内直连', '广告拦截']);

/**
 * Validates generated Mihomo YAML for structural integrity, zero DIRECT leakage into
 * proxy groups, and native `mihomo -t` compatibility before publication.
 */
export class ConfigValidator {
  static validateStructure(config) {
    const errors = [];
    for (const key of ['proxies', 'proxy-groups', 'rules']) {
      if (!config || !config[key]) errors.push(`Missing essential key: ${key}`);
    }
    const proxies = config?.proxies || [];
    if (proxies.length === 0) errors.push('No proxies defined in configuration');

    const proxyNames = new Set(proxies.map((p) => p?.name).filter(Boolean));
    const groups = config?.['proxy-groups'] || [];
    const groupNames = new Set(groups.map((g) => g?.name).filter(Boolean));

    for (const g of groups) {
      const gName = g.name;
      const members = g.proxies || [];
      if (!ALLOWED_DIRECT_GROUPS.has(gName) && members.includes('DIRECT')) {
        errors.push(`CRITICAL VIOLATION: 'DIRECT' found inside non-domestic group '${gName}'`);
      }
      if (members.length === 0) {
        errors.push(`Group '${gName}' has empty proxies list`);
      }
      for (const m of members) {
        if (m === 'DIRECT' || m === 'REJECT' || m === 'PASS') continue;
        if (!proxyNames.has(m) && !groupNames.has(m)) {
          errors.push(`Group '${gName}' references undefined member '${m}'`);
        }
      }
    }

    const RULE_MODIFIERS = new Set(['no-resolve']);
    for (const rule of config?.rules || []) {
      if (rule.startsWith('AND,') || rule.startsWith('OR,') || rule.startsWith('NOT,')) {
        const idx = rule.lastIndexOf(')),');
        if (idx >= 0) {
          const target = rule.slice(idx + 3).split(',')[0].trim();
          if (target !== 'DIRECT' && target !== 'REJECT' && target !== 'PASS' && !groupNames.has(target) && !proxyNames.has(target)) {
            errors.push(`Rule '${rule}' targets undefined group '${target}'`);
          }
        }
        continue;
      }
      const parts = rule.split(',');
      if (parts.length >= 2) {
        let target = parts[parts.length - 1].trim();
        if (RULE_MODIFIERS.has(target) && parts.length >= 3) {
          target = parts[parts.length - 2].trim();
        }
        if (parts[0] === 'MATCH' && target === 'DIRECT') {
          errors.push('CRITICAL VIOLATION: MATCH rule cannot route to DIRECT');
        }
        if (target !== 'DIRECT' && target !== 'REJECT' && target !== 'PASS' && !groupNames.has(target) && !proxyNames.has(target)) {
          errors.push(`Rule '${rule}' targets undefined group '${target}'`);
        }
      }
    }

    return errors;
  }

  static async validateWithMihomo(yamlString, mihomoBin, geodataDir = null) {
    if (!mihomoBin || !fs.existsSync(mihomoBin)) return { skipped: true, ok: true };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gns-validate-'));
    const cfgFile = path.join(tmpDir, 'config.yaml');
    const dataDir = geodataDir || tmpDir;
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      fs.writeFileSync(cfgFile, yamlString, 'utf8');
      await execFileAsync(mihomoBin, ['-t', '-d', dataDir, '-f', cfgFile], { timeout: 30000 });
      return { skipped: false, ok: true };
    } catch (err) {
      return { skipped: false, ok: false, error: err.stderr || err.stdout || err.message };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
