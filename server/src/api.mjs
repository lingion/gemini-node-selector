import http from 'node:http';
import crypto from 'node:crypto';

function safeTokenEqual(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderNodesHtml(nodes, statusMeta) {
  const rows = nodes
    .map((n) => {
      const details = JSON.parse(n.gemini_details_json || '{}');
      const sources = JSON.parse(n.intel_sources_json || '[]').join(', ');
      const badge = (tier) => {
        if (tier === 'STRICT') return '<span class="ok">严选</span>';
        if (tier === 'FALLBACK') return '<span class="warn">非严选</span>';
        return '<span class="fail">FAIL</span>';
      };
      const agTier = details.antigravity_tier || 'FAIL';
      const gemTier = details.gemini_tier || (n.gemini_status === 'PASS' ? 'FALLBACK' : 'FAIL');
      const gooTier = details.google_tier || (details.google_reachable ? 'FALLBACK' : 'FAIL');
      return `<tr>
        <td><code>${escapeHtml(n.fingerprint.slice(0, 8))}</code></td>
        <td>${escapeHtml(n.source_id)}</td>
        <td>${escapeHtml(n.original_name)}</td>
        <td><strong>${escapeHtml(n.normalized_name)}</strong></td>
        <td>${escapeHtml(n.protocol)}</td>
        <td><code>${escapeHtml(n.egress_ip)}</code> (v${n.ip_family})</td>
        <td>${escapeHtml(n.country_code)} / ${escapeHtml(n.city)}</td>
        <td>AS${n.asn} ${escapeHtml(n.as_name)}</td>
        <td>${escapeHtml(n.facility_name)} (${escapeHtml(n.facility_confidence)})</td>
        <td>${escapeHtml(sources)}</td>
        <td>Claude:${badge(details.claude_tier || 'FAIL')} / GPT:${badge(details.gpt_tier || 'FAIL')} / AG:${badge(agTier)} / Gem:${badge(gemTier)} / Goo:${badge(gooTier)}</td>
        <td>API:${details.api_supported ? 'Y' : 'N'} App:${details.web_app_ok ? 'Y' : 'N'} Flag:${details.feature_flag ? 'Y' : 'N'} Clean:${details.google_clean ? 'Y' : 'N'} AG:${details.antigravity_endpoints_ok ? 'Y' : 'N'} Stable:${details.ip_stable ? 'Y' : 'N'} v6:${details.ipv6_clean !== false ? 'Y' : 'N'} Geo:${escapeHtml([details.geo_gemini, details.geo_terms, details.geo_youtube].filter(Boolean).join('/') || '-')}</td>
      </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>Gemini Node Selector - Server Observability</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f172a; color: #e2e8f0; margin: 20px; }
  h1 { color: #38bdf8; font-size: 20px; }
  .meta { background: #1e293b; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; background: #1e293b; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #334155; text-align: left; }
  th { background: #0f172a; color: #94a3b8; position: sticky; top: 0; }
  .ok { color: #4ade80; font-weight: 700; }
  .warn { color: #facc15; font-weight: 700; }
  .fail { color: #f87171; font-weight: 600; }
</style>
</head>
<body>
  <h1>Gemini Node Selector 服务端实时节点状态台账</h1>
  <div class="meta">
    状态: ${escapeHtml(statusMeta.run_state)} | 最近完成: ${escapeHtml(statusMeta.last_finished_at || 'N/A')} | 活跃实测节点: ${nodes.length} | AntiGravity 严选: ${nodes.filter((n) => JSON.parse(n.gemini_details_json || '{}').antigravity_tier === 'STRICT').length} | Gemini 合格: ${nodes.filter((n) => n.gemini_status === 'PASS').length} | Google 可达: ${nodes.filter((n) => ['STRICT', 'FALLBACK'].includes(JSON.parse(n.gemini_details_json || '{}').google_tier)).length}
  </div>
  <table>
    <thead>
      <tr>
        <th>指纹</th><th>来源</th><th>原名</th><th>自动命名</th><th>协议</th>
        <th>实测出口IP</th><th>地区</th><th>ASN/组织</th><th>机房/置信度</th>
        <th>情报源</th><th>分级结论</th><th>探测细项</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

export function createApiServer({ orchestrator, storage, settings }) {
  const subToken = settings.server?.token;
  const adminToken = settings.server?.admin_token || subToken;

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname;

      if (p === '/healthz') {
        const cached = storage.getSubCache('sub_probed_clash_yaml', true);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'ok',
          service: 'gemini-node-selector-server',
          has_cached_sub: Boolean(cached),
          run_state: orchestrator.lastRunStatus.state,
        }));
        return;
      }

      if (p.startsWith('/sub/')) {
        const tok = p.slice(5);
        if (!safeTokenEqual(tok, subToken)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        const stale = storage.getSubCache('sub_probed_clash_yaml', true);
        const fresh = storage.getSubCache('sub_probed_clash_yaml', false);
        let result;
        if (fresh) {
          result = { yaml: fresh.value, meta: { ...fresh.meta, cached: true, stale: false } };
        } else if (stale && u.searchParams.get('sync') !== '1') {
          // Trigger background refresh while immediately returning last valid YAML so clients don't timeout
          orchestrator.generateSubscription({ forceRefresh: true }).catch((e) => console.error('[bg-refresh]', e.message));
          result = { yaml: stale.value, meta: { ...stale.meta, cached: true, stale: true } };
        } else {
          result = await orchestrator.generateSubscription({ forceRefresh: true });
        }

        res.writeHead(200, {
          'Content-Type': 'text/yaml; charset=utf-8',
          'Content-Disposition': 'attachment; filename="Gemini-Node-Selector.yaml"',
          'Profile-Update-Interval': '24',
          'Subscription-Userinfo': 'upload=0; download=0; total=1073741824000; expire=1893456000',
          'Cache-Control': 'private, no-store',
          'X-GNS-Cached': String(Boolean(result.meta?.cached)),
          'X-GNS-Stale': String(Boolean(result.meta?.stale)),
          'X-GNS-Generated-At': String(result.meta?.generated_at || ''),
        });
        res.end(result.yaml);
        return;
      }

      if (p.startsWith('/status/')) {
        const tok = p.slice(8);
        if (!safeTokenEqual(tok, subToken)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        const nodes = storage.getAllNodes();
        const sub = storage.getSubCache('sub_probed_clash_yaml', true);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'healthy',
          run_state: orchestrator.lastRunStatus,
          subscription_meta: sub?.meta || null,
          stale: sub?.stale ?? true,
          total_nodes_in_db: nodes.length,
          gemini_pass_count: nodes.filter((n) => n.gemini_status === 'PASS').length,
        }, null, 2));
        return;
      }

      if (p === '/admin/nodes') {
        const tok = u.searchParams.get('token') || req.headers['x-admin-token'];
        if (!safeTokenEqual(tok, adminToken)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        const nodes = storage.getAllNodes();
        if (u.searchParams.get('format') === 'json') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            run_state: orchestrator.lastRunStatus,
            nodes: nodes.map((n) => ({
              ...n,
              gemini_details: JSON.parse(n.gemini_details_json || '{}'),
              intel_sources: JSON.parse(n.intel_sources_json || '[]'),
            })),
          }, null, 2));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderNodesHtml(nodes, {
            run_state: orchestrator.lastRunStatus.state,
            last_finished_at: orchestrator.lastRunStatus.last_finished_at,
          }));
        }
        return;
      }

      if (p === '/admin/refresh' && req.method === 'POST') {
        const tok = u.searchParams.get('token') || req.headers['x-admin-token'];
        if (!safeTokenEqual(tok, adminToken)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden' }));
          return;
        }
        const forceReprobe = u.searchParams.get('reprobe') === '1';
        if (u.searchParams.get('async') === '1') {
          orchestrator.generateSubscription({ forceRefresh: true, forceReprobe }).catch((e) => console.error('[manual-refresh]', e.message));
          res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ accepted: true, state: orchestrator.lastRunStatus.state }));
        } else {
          const result = await orchestrator.generateSubscription({ forceRefresh: true, forceReprobe });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ message: 'Refreshed', meta: result.meta }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      console.error('[api] Request error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  return server;
}
