import { generatedYaml, generatedStatus, generatedNodes } from './generated.mjs';

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

function yaml(body) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/yaml; charset=utf-8',
      'content-disposition': 'attachment; filename="Gemini-Node-Selector.yaml"',
      'access-control-allow-origin': '*',
      'cache-control': 'private, no-store',
      'profile-update-interval': '24',
      'subscription-userinfo': 'upload=0; download=0; total=1073741824000; expire=1893456000',
      'x-gns-origin': 'github-actions-cloud-probe',
      'x-gns-cached': 'false',
      'x-gns-stale': 'false',
      'x-gns-generated-at': String(generatedStatus.generated_at || ''),
    },
  });
}

function isAuthorized(request, url, env) {
  const provided = url.searchParams.get('token') || request.headers.get('x-admin-token') || '';
  return Boolean(provided) && [env.GNS_TOKEN, env.GNS_ADMIN_TOKEN].includes(provided);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/healthz') {
      return json({ status: 'ok', service: 'gemini-node-selector-edge', generated_at: generatedStatus.generated_at || null });
    }
    if (path.startsWith('/sub/')) {
      const token = path.slice('/sub/'.length);
      if (!token || token !== env.GNS_TOKEN) return new Response('Forbidden', { status: 403 });
      return yaml(generatedYaml);
    }
    if (path.startsWith('/status/')) {
      const token = path.slice('/status/'.length);
      if (!token || token !== env.GNS_TOKEN) return json({ error: 'Forbidden' }, 403);
      return json(generatedStatus);
    }
    if (path === '/admin/nodes') {
      if (!isAuthorized(request, url, env)) return json({ error: 'Forbidden' }, 403);
      if (url.searchParams.get('format') === 'json') return json({ status: generatedStatus, nodes: generatedNodes });
      return new Response('<html><body><h1>Gemini Node Selector</h1><pre>' + escapeHtml(JSON.stringify({ status: generatedStatus, nodes: generatedNodes }, null, 2)) + '</pre></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (path === '/admin/refresh' && request.method === 'POST') {
      if (!isAuthorized(request, url, env)) return json({ error: 'Forbidden' }, 403);
      return json({ accepted: false, message: 'Refresh runs from GitHub Actions every 6 hours.' }, 202);
    }
    return json({ error: 'Not found' }, 404);
  },
};

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
