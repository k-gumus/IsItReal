import type { EngineDeps } from '../config.js';
import { analyze, type AnalysisReport, type AnalyzeRequest, type PdfInput } from '../core/analyze.js';
import { tierReference } from '../core/authority.js';
import { classifyInput } from '../core/input.js';
import { INPUT_LIMITS, InputError, validateInput } from '../core/pipeline.js';
import type { ProgressEvent } from '../core/types.js';
import { DailyCounter, RateLimiter, TtlCache } from '../server/limits.js';

/**
 * Çalışma ortamından bağımsız API: standart Request/Response kullanır.
 * Aynı kod hem Node sunucusunda (src/server) hem Cloudflare Workers'ta (src/worker.ts) çalışır.
 */

export interface ApiOptions {
  deps: EngineDeps;
  /** Dakikada IP başına en fazla doğrulama isteği */
  rateLimitPerMinute?: number;
  /** Günlük en fazla (önbellek dışı) doğrulama; 0 = sınırsız */
  dailyLimit?: number;
  maxConcurrent?: number;
  cacheTtlMs?: number;
  log?: (msg: string) => void;
}

export type WaitUntil = (promise: Promise<unknown>) => void;
export type ApiHandler = (request: Request, clientIp: string, waitUntil?: WaitUntil) => Promise<Response | null>;

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** JSON gövde sınırı: PDF metni tarayıcıda çıkarılıp gönderildiği için metin girdisinden büyük */
export const MAX_BODY_BYTES = 1_500_000;
export const MAX_PDF_TEXT = 400_000;

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').includes('application/json')) throw new InputError('İstek gövdesi JSON olmalı.');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new InputError('İstek gövdesi çok büyük.');
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new InputError('İstek gövdesi çok büyük.');
  try {
    return JSON.parse(text);
  } catch {
    throw new InputError('Geçersiz JSON.');
  }
}

/** Tarayıcıda çıkarılmış PDF metnini doğrular (dosyanın kendisi sunucuya hiç gelmez). */
export function validatePdf(raw: unknown): PdfInput {
  const p = (raw ?? {}) as Record<string, unknown>;
  const text = typeof p.text === 'string' ? p.text.replace(/\u0000/g, '') : '';
  if (!text.trim()) throw new InputError('Bu PDF\'te seçilebilir metin yok (taranmış bir belge olabilir).');
  if (text.length > MAX_PDF_TEXT) throw new InputError('PDF metni çok uzun; daha kısa bir belge dene.');
  const pages = typeof p.pages === 'number' && Number.isInteger(p.pages) && p.pages > 0 && p.pages <= 500 ? p.pages : 1;
  const name = (typeof p.name === 'string' ? p.name : 'belge.pdf').replace(/[\u0000-\u001f<>]/g, '').slice(0, 120) || 'belge.pdf';
  const title = typeof p.title === 'string' && p.title.trim().length > 3 ? p.title.trim().slice(0, 200) : undefined;
  return { name, pages, text, title, dois: [] };
}

async function hashKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function cacheKey(request: AnalyzeRequest): Promise<string> {
  if ('pdf' in request) return `pdf:${await hashKey(request.pdf.text)}`;
  return `text:${request.text.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim()}`;
}

export function createApi(options: ApiOptions): ApiHandler {
  const { deps, log = () => {} } = options;
  const limiter = new RateLimiter(options.rateLimitPerMinute ?? 8, 60_000);
  const daily = new DailyCounter(options.dailyLimit ?? 0);
  const cache = new TtlCache<AnalysisReport>(options.cacheTtlMs ?? 10 * 60_000, 100);
  const maxConcurrent = options.maxConcurrent ?? 4;
  let active = 0;

  const busy = () => json(503, { error: 'Sunucu şu an meşgul, birkaç saniye sonra tekrar deneyin.' }, { 'Retry-After': '5' });
  const exhausted = () =>
    json(429, { error: 'Bugünkü ücretsiz doğrulama hakkı doldu. Yarın tekrar dene ya da uygulamayı kendi bilgisayarında çalıştır.' }, { 'Retry-After': '3600' });

  async function prepare(request: Request, ip: string): Promise<{ req: AnalyzeRequest; key: string } | Response> {
    const limit = limiter.take(ip);
    if (!limit.allowed) return json(429, { error: 'Çok fazla istek. Lütfen biraz bekleyin.' }, { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) });
    try {
      const body = (await readJson(request)) as { text?: unknown; pdf?: unknown };
      if (body && typeof body === 'object' && 'pdf' in body) {
        const req = { pdf: validatePdf(body.pdf) };
        return { req, key: await cacheKey(req) };
      }
      const raw = typeof body?.text === 'string' ? body.text.trim() : body?.text;
      // DOI ve bağlantılar kısa olabilir; en az uzunluk şartı yalnızca serbest metne uygulanır
      const text = typeof raw === 'string' && classifyInput(raw).kind !== 'text' && raw.length <= INPUT_LIMITS.maxLength ? raw : validateInput(raw);
      const req = { text };
      return { req, key: await cacheKey(req) };
    } catch (err) {
      return json(400, { error: err instanceof InputError ? err.message : 'Geçersiz istek.' });
    }
  }

  async function verify(request: Request, ip: string): Promise<Response> {
    const prepared = await prepare(request, ip);
    if (prepared instanceof Response) return prepared;
    const cached = cache.get(prepared.key);
    if (cached) return json(200, { ...cached, cached: true });
    if (active >= maxConcurrent) return busy();
    if (!daily.take()) return exhausted();
    active++;
    try {
      const report = await analyze(prepared.req, deps);
      cache.set(prepared.key, report);
      return json(200, report);
    } catch (err) {
      if (!(err instanceof InputError)) log(`verify hatası: ${(err as Error).stack ?? err}`);
      return json(err instanceof InputError ? 400 : 500, { error: err instanceof InputError ? err.message : 'Doğrulama sırasında beklenmeyen bir hata oluştu.' });
    } finally {
      active--;
    }
  }

  /** Server-Sent Events: aşamaları canlı yayınlar, en sonda "report" olayını gönderir */
  async function stream(request: Request, ip: string, waitUntil?: WaitUntil): Promise<Response> {
    const prepared = await prepare(request, ip);
    if (prepared instanceof Response) return prepared;
    const cached = cache.get(prepared.key);
    if (!cached && active >= maxConcurrent) return busy();
    if (!cached && !daily.take()) return exhausted();

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    let open = true;
    const write = (event: string, data: unknown) => {
      if (!open) return;
      writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => (open = false));
    };

    const work = (async () => {
      if (cached) {
        write('report', { ...cached, cached: true });
        return;
      }
      active++;
      const heartbeat = setInterval(() => open && writer.write(encoder.encode(': ping\n\n')).catch(() => (open = false)), 15_000);
      try {
        const report = await analyze(prepared.req, { ...deps, onProgress: (e: ProgressEvent) => write('progress', e) });
        cache.set(prepared.key, report);
        write('report', report);
      } catch (err) {
        if (!(err instanceof InputError)) log(`stream hatası: ${(err as Error).stack ?? err}`);
        write('error', { error: err instanceof InputError ? err.message : 'Doğrulama sırasında beklenmeyen bir hata oluştu.' });
      } finally {
        clearInterval(heartbeat);
        active--;
      }
    })().finally(() => {
      open = false;
      writer.close().catch(() => {});
    });
    waitUntil?.(work);

    return new Response(readable, {
      status: 200,
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' },
    });
  }

  return async (request, clientIp, waitUntil) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return null;
    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json(200, { ok: true, mode: deps.mode, limits: INPUT_LIMITS, dailyRemaining: daily.remaining() });
      }
      if (url.pathname === '/api/tiers' && request.method === 'GET') return json(200, tierReference());
      if (url.pathname === '/api/verify' && request.method === 'POST') return await verify(request, clientIp);
      if (url.pathname === '/api/verify/stream' && request.method === 'POST') return await stream(request, clientIp, waitUntil);
      return json(404, { error: 'Bilinmeyen uç nokta.' });
    } catch (err) {
      log(`istek hatası: ${(err as Error).stack ?? err}`);
      return json(500, { error: 'Sunucu hatası.' });
    }
  };
}
