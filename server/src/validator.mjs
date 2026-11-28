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

  static validateSingBoxStructure(config) {
    const errors = [];
    for (const key of ['dns', 'inbounds', 'outbounds', 'route']) {
      if (!config || !config[key]) errors.push(`Missing essential sing-box key: ${key}`);
    }
    const outbounds = config?.outbounds || [];
    if (outbounds.length === 0) errors.push('No outbounds defined in sing-box configuration');

    const tags = new Set();
    for (const o of outbounds) {
      if (!o?.tag) {
        errors.push('Sing-box outbound missing tag');
        continue;
      }
      if (tags.has(o.tag)) errors.push(`Duplicate sing-box outbound tag '${o.tag}'`);
      tags.add(o.tag);
      if (o.type === 'block' || o.type === 'dns') {
        errors.push(`Deprecated sing-box outbound type '${o.type}' on '${o.tag}'`);
      }
    }

    const allowedDirectTags = new Set(['FCM']);
    for (const o of outbounds) {
      if (o.type === 'selector' || o.type === 'urltest') {
        const members = o.outbounds || [];
        if (members.length === 0) {
          errors.push(`Sing-box group '${o.tag}' has empty outbounds list`);
        }
        if (!allowedDirectTags.has(o.tag) && members.includes('国内直连')) {
          errors.push(`CRITICAL VIOLATION: '国内直连' found inside sing-box group '${o.tag}'`);
        }
        for (const m of members) {
          if (!tags.has(m)) {
            errors.push(`Sing-box group '${o.tag}' references undefined outbound '${m}'`);
          }
        }
        if (o.default && !members.includes(o.default)) {
          errors.push(`Sing-box selector '${o.tag}' default '${o.default}' not in outbounds`);
        }
      }
    }

    const ruleSetTags = new Set((config?.route?.rule_set || []).map((r) => r?.tag).filter(Boolean));
    if (config?.route?.final === '国内直连') {
      errors.push('CRITICAL VIOLATION: sing-box route.final cannot route to 国内直连');
    }
    if (config?.route?.final && !tags.has(config.route.final)) {
      errors.push(`Sing-box route.final targets undefined outbound '${config.route.final}'`);
    }
    for (const rule of config?.route?.rules || []) {
      if (rule.outbound && !tags.has(rule.outbound)) {
        errors.push(`Sing-box route rule targets undefined outbound '${rule.outbound}'`);
      }
      for (const rs of rule.rule_set || []) {
        if (!ruleSetTags.has(rs)) {
          errors.push(`Sing-box route rule references undefined rule_set '${rs}'`);
        }
      }
    }
    const dnsTags = new Set((config?.dns?.servers || []).map((s) => s?.tag).filter(Boolean));
    if (config?.route?.default_domain_resolver && !dnsTags.has(config.route.default_domain_resolver)) {
      errors.push(`Sing-box default_domain_resolver '${config.route.default_domain_resolver}' not in dns.servers`);
    }

    return errors;
  }

  static async validateWithSingBox(jsonString, singboxBin) {
    if (!singboxBin || !fs.existsSync(singboxBin)) return { skipped: true, ok: true };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gns-sb-validate-'));
    const cfgFile = path.join(tmpDir, 'config.json');
    try {
      fs.writeFileSync(cfgFile, jsonString, 'utf8');
      await execFileAsync(singboxBin, ['check', '-c', cfgFile], { timeout: 30000 });
      return { skipped: false, ok: true };
    } catch (err) {
      return { skipped: false, ok: false, error: err.stderr || err.stdout || err.message };
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
