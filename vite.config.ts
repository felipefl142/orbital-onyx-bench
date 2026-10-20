import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Loopback, Tailscale CGNAT range 100.64.0.0/10, or Tailscale IPv6 fd7a:115c:a1e0::/48. */
function isTrustedClient(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const m = ip.match(/^100\.(\d+)\./);
  if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return true;
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

// Optional CORS proxy for LLM endpoints that refuse browser requests.
// The browser sends POST /proxy with header `x-target-url: <full url>`; the dev server forwards it.
// Only active under `npm run dev` / `npm run preview`, never in the static build.
function llmProxy(): Plugin {
  const handler = async (req: any, res: any, next: () => void) => {
    if (!req.url?.startsWith('/proxy')) return next();
    // With --host 0.0.0.0 the server is reachable from the LAN too; only localhost and the tailnet may use the proxy.
    const ip = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (!isTrustedClient(ip)) {
      res.statusCode = 403;
      res.end('proxy: only localhost and tailnet clients');
      return;
    }
    const target = req.headers['x-target-url'];
    if (typeof target !== 'string' || !/^https?:\/\//.test(target)) {
      res.statusCode = 400;
      res.end('missing or invalid x-target-url');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'origin', 'referer', 'x-target-url', 'connection', 'content-length'].includes(k)) continue;
      if (typeof v === 'string') headers[k] = v;
    }
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
      });
      res.statusCode = upstream.status;
      upstream.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) res.setHeader(k, v);
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.statusCode = 502;
      res.end(`proxy error: ${(e as Error).message}`);
    }
  };
  return {
    name: 'llm-proxy',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), llmProxy()],
  worker: { format: 'es' },
  // Allow access through `tailscale serve` (https://<machine>.<tailnet>.ts.net).
  server: { allowedHosts: ['.ts.net'] },
  preview: { allowedHosts: ['.ts.net'] },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 120_000 },
} as any);
