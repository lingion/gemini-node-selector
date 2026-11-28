import fs from 'node:fs';
import yaml from 'js-yaml';
import { Parser } from './parser.mjs';
import { Normalizer } from './normalizer.mjs';
import { GroupBuilder } from './groups.mjs';
import { ConfigValidator } from './validator.mjs';

/**
 * Coordinates upstream fetch, single-flight deduplication, server-side probing,
 * structural + mihomo -t validation, and atomic cache promotion with fallback.
 */
export class Orchestrator {
  constructor({ fetcher, probeRunner, storage, mihomoBin, geodataDir, settings }) {
    this.fetcher = fetcher;
    this.probeRunner = probeRunner;
    this.storage = storage;
    this.mihomoBin = mihomoBin;
    this.geodataDir = geodataDir;
    this.settings = settings;
    this.inflight = null;
    this.lastRunStatus = {
      state: 'idle',
      last_started_at: null,
      last_finished_at: null,
      last_error: null,
      upstream_counts: {},
    };
  }

  async generateSubscription({ forceRefresh = false, forceReprobe = false } = {}) {
    const cacheKey = 'sub_probed_clash_yaml';
    if (!forceRefresh && !forceReprobe) {
      const cached = this.storage.getSubCache(cacheKey, false);
      if (cached) {
        return { yaml: cached.value, meta: { ...cached.meta, cached: true, stale: false } };
      }
    }

    if (this.inflight) {
      return await this.inflight;
    }

    this.inflight = this._runPipeline({ forceReprobe, cacheKey }).finally(() => {
      this.inflight = null;
    });
    return await this.inflight;
  }

  async _runPipeline({ forceReprobe, cacheKey }) {
    this.lastRunStatus.state = 'running';
    this.lastRunStatus.last_started_at = new Date().toISOString();
    this.lastRunStatus.last_error = null;

    try {
      const rawSources = await this.fetcher.fetchAll();
      if (rawSources.length === 0) {
        throw new Error('All upstream sources failed or returned empty');
      }

      const candidateMetas = [];
      const seenFp = new Set();
      const upstreamCounts = {};

      for (const src of rawSources) {
        const parsed = Parser.parse(src.data);
        let kept = 0;
        for (const rawNode of parsed) {
          const { valid, meta } = Normalizer.normalizeNode(rawNode, src.prefix, src.sourceId);
          if (valid && !seenFp.has(meta.fingerprint)) {
            seenFp.add(meta.fingerprint);
            candidateMetas.push(meta);
            kept++;
          }
        }
        upstreamCounts[src.sourceId] = kept;
      }
      this.lastRunStatus.upstream_counts = upstreamCounts;

      if (candidateMetas.length === 0) {
        throw new Error('Zero valid candidate nodes after normalization');
      }

      const probedResults = await this.probeRunner.probeAllNodes(candidateMetas, forceReprobe);
      const config = GroupBuilder.buildFromProbedNodes(probedResults, {
        adWhitelist: this.settings.ads?.whitelist || [],
        adBlacklist: this.settings.ads?.blacklist || [],
      });

      const structErrors = ConfigValidator.validateStructure(config);
      if (structErrors.length > 0) {
        throw new Error(`Structure audit failed: ${structErrors.join('; ')}`);
      }

      const renderedYaml = yaml.dump(config, {
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
      });

      const mihomoValidation = await ConfigValidator.validateWithMihomo(
        renderedYaml,
        this.mihomoBin,
        this.geodataDir
      );
      if (!mihomoValidation.ok) {
        throw new Error(`Mihomo native validation failed: ${mihomoValidation.error}`);
      }

      const countRealMembers = (groupName) => {
        const g = config['proxy-groups'].find((x) => x.name === groupName);
        return (g?.proxies || []).filter((n) => n !== 'REJECT').length;
      };

      const meta = {
        cached: false,
        stale: false,
        generated_at: new Date().toISOString(),
        total_candidates: candidateMetas.length,
        total_active_probed_nodes: config.proxies.length,
        antigravity_strict_nodes: countRealMembers('AntiGravity-严选'),
        antigravity_any_nodes: countRealMembers('AntiGravity-非严选'),
        claude_strict_nodes: countRealMembers('Claude-严选'),
        gpt_strict_nodes: countRealMembers('GPT-严选'),
        gemini_strict_nodes: countRealMembers('Gemini-严选'),
        gemini_pass_nodes: countRealMembers('Gemini-非严选'),
        google_strict_nodes: countRealMembers('Google-严选'),
        google_any_nodes: countRealMembers('Google-非严选'),
        groups_count: config['proxy-groups'].length,
        upstream_counts: upstreamCounts,
        mihomo_validated: !mihomoValidation.skipped,
      };

      const subTtl = this.settings.cache?.upstream_ttl_seconds || 21600;
      this.storage.setSubCache(cacheKey, renderedYaml, meta, subTtl);

      if (this.settings.generated_yaml_path) {
        fs.writeFileSync(this.settings.generated_yaml_path, renderedYaml, 'utf8');
      }

      this.lastRunStatus.state = 'idle';
      this.lastRunStatus.last_finished_at = meta.generated_at;
      return { yaml: renderedYaml, meta };
    } catch (err) {
      this.lastRunStatus.state = 'error';
      this.lastRunStatus.last_error = err.message;
      this.lastRunStatus.last_finished_at = new Date().toISOString();

      // Section 12 Degradation: Serve last-known-good subscription on failure
      const fallback = this.storage.getSubCache(cacheKey, true);
      if (fallback) {
        console.warn(`[orchestrator] Pipeline failed (${err.message}); returning stale fallback YAML.`);
        return {
          yaml: fallback.value,
          meta: { ...fallback.meta, cached: true, stale: true, fallback_reason: err.message },
        };
      }
      throw err;
    }
  }
}
