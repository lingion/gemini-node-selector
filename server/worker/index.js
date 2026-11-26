const PORT = 8089;
const STARTUP_ATTEMPTS = 100;
const STARTUP_DELAY_MS = 200;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

export class GnsContainer extends DurableObject {
  starting;

  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    if (ctx.container?.running) {
      void ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  async fetch(request) {
    this.starting ??= this.startAndWaitForReady().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = 'http:';
    url.host = 'container';
    const forwarded = new Request(url, request);
    forwarded.headers.delete('host');
    return this.ctx.container.getTcpPort(PORT).fetch(forwarded);
  }

  async startAndWaitForReady() {
    const container = this.ctx.container;
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: 'standard-2',
        enableInternet: true,
        env: {
          GNS_HOST: '0.0.0.0',
          GNS_PORT: String(PORT),
          GNS_TOKEN: this.env.GNS_TOKEN || '',
          GNS_ADMIN_TOKEN: this.env.GNS_ADMIN_TOKEN || this.env.GNS_TOKEN || '',
          GNS_SOURCES_JSON: this.env.GNS_SOURCES_JSON || '',
          GNS_AI_STUDIO_API_KEY: this.env.GNS_AI_STUDIO_API_KEY || '',
          GNS_ANTIGRAVITY_TOKEN: this.env.GNS_ANTIGRAVITY_TOKEN || '',
        },
      });
    }

    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const port = container.getTcpPort(PORT);
    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
      try {
        const response = await port.fetch('http://container/healthz', {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // The process may still be unpacking, installing, or warming its first probe.
      }
      await scheduler.wait(STARTUP_DELAY_MS);
    }
    throw new Error('GNS container did not become ready on port 8089');
  }
}

function containerStub(env) {
  const id = env.GNS_CONTAINER.idFromName('gns-primary');
  return env.GNS_CONTAINER.get(id);
}

async function forward(request, env) {
  return containerStub(env).fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz' || url.pathname.startsWith('/sub/') || url.pathname.startsWith('/status/') || url.pathname === '/admin/nodes' || url.pathname === '/admin/refresh') {
      return forward(request, env);
    }
    return new Response(JSON.stringify({ service: 'gemini-node-selector-container', status: 'ok' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  },

  async scheduled(controller, env, ctx) {
    const request = new Request('https://container.internal/admin/refresh?reprobe=1&async=1', {
      method: 'POST',
      headers: {
        'x-admin-token': env.GNS_ADMIN_TOKEN || env.GNS_TOKEN || '',
      },
    });
    ctx.waitUntil(forward(request, env).catch((error) => {
      console.error('[gns-cron] refresh failed', error);
    }));
  },
};
