import { createEngineDeps } from './config.js';
import { createApi, json, type ApiHandler } from './http/api.js';

/**
 * Cloudflare Workers girişi. Statik arayüz dosyaları (public/) Workers Static Assets ile,
 * /api/* istekleri ise Node sunucusuyla aynı API koduyla (src/http/api.ts) yanıtlanır.
 *
 * Not: Hız sınırı, günlük sınır ve önbellek bellek içidir ve her Worker örneği (isolate) için ayrı tutulur;
 * kaba bir koruma sağlar. Asıl tavan Tavily ve Gemini'nin ücretsiz kotalarıdır: kota dolarsa ücret çıkmaz,
 * istekler hata verir.
 */

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  [key: string]: unknown;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

let api: ApiHandler | undefined;

function stringEnv(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (!api) {
      const vars = stringEnv(env);
      api = createApi({
        deps: createEngineDeps(vars),
        rateLimitPerMinute: Number.parseInt(vars.RATE_LIMIT_PER_MINUTE ?? '8', 10),
        dailyLimit: Number.parseInt(vars.DAILY_LIMIT ?? '0', 10) || 0,
        log: (msg) => console.error(msg),
      });
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    return (await api(request, ip, (p) => ctx.waitUntil(p))) ?? json(404, { error: 'Bilinmeyen uç nokta.' });
  },
};
