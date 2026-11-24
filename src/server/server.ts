import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { extractPdf, MAX_PDF_BYTES, PdfError } from '../adapters/pdf.js';
import type { EngineDeps } from '../config.js';
import { analyze, type AnalysisReport, type AnalyzeRequest, type PdfInput } from '../core/analyze.js';
import { tierReference } from '../core/authority.js';
import { classifyInput } from '../core/input.js';
import { INPUT_LIMITS, InputError, validateInput } from '../core/pipeline.js';
import type { ProgressEvent } from '../core/types.js';
import { DailyCounter, RateLimiter, TtlCache } from './limits.js';

export interface ServerOptions {
  deps: EngineDeps;
  publicDir: string;
  /** Dakikada IP başına en fazla doğrulama isteği */
  rateLimitPerMinute?: number;
  maxConcurrent?: number;
  cacheTtlMs?: number;
  /** Sunucu genelinde günlük en fazla (önbellek dışı) doğrulama; 0 = sınırsız */
  dailyLimit?: number;
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

const MAX_BODY_BYTES = 16 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(payload);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('application/json')) throw new InputError('İstek gövdesi JSON olmalı.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new InputError('İstek gövdesi çok büyük.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new InputError('Geçersiz JSON.');
  }
}

async function readRawBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new InputError('Dosya çok büyük (en fazla 15 MB).');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new InputError('Dosya çok büyük (en fazla 15 MB).');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // Cloudflare arkasındaki platformlar (ör. Render) gerçek istemci IP'sini bu başlıkta verir
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
    // X-Forwarded-For'un en sağdaki değeri güvenilen vekilin eklediğidir; soldakiler istemcice uydurulabilir
    const fwd = req.headers['x-forwarded-for'];
    const last = (Array.isArray(fwd) ? fwd.join(',') : fwd)?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function cacheKey(request: AnalyzeRequest, pdfId?: string): string {
  if ('pdf' in request) return `pdf:${pdfId}`;
  return `text:${request.text.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim()}`;
}

export function createServer(options: ServerOptions): http.Server {
  const { deps, log = () => {} } = options;
  const publicDir = path.resolve(options.publicDir);
  const limiter = new RateLimiter(options.rateLimitPerMinute ?? 8, 60_000);
  const cache = new TtlCache<AnalysisReport>(options.cacheTtlMs ?? 10 * 60_000, 100);
  // Yüklenen PDF'lerin çıkarılmış metni: dosyanın kendisi saklanmaz, 30 dakika sonra silinir
  const pdfStore = new TtlCache<PdfInput>(30 * 60_000, 50);
  const maxConcurrent = options.maxConcurrent ?? 4;
  const daily = new DailyCounter(options.dailyLimit ?? 0);
  const dailyExhausted = (res: http.ServerResponse) =>
    send(res, 429, { error: 'Bugünkü ücretsiz doğrulama hakkı doldu. Yarın tekrar dene ya da uygulamayı kendi bilgisayarında çalıştır.' }, { 'Retry-After': '3600' });
  const trustProxy = process.env.TRUST_PROXY === '1';
  let active = 0;

  function checkRate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const limit = limiter.take(clientIp(req, trustProxy));
    if (limit.allowed) return true;
    send(res, 429, { error: 'Çok fazla istek. Lütfen biraz bekleyin.' }, { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) });
    return false;
  }

  /** Ortak ön kontroller: hız sınırı, gövde ve girdi doğrulaması */
  async function prepare(req: http.IncomingMessage, res: http.ServerResponse): Promise<{ request: AnalyzeRequest; key: string } | null> {
    if (!checkRate(req, res)) return null;
    try {
      const body = (await readJsonBody(req)) as { text?: unknown; pdfId?: unknown };
      if (typeof body?.pdfId === 'string') {
        const pdf = pdfStore.get(body.pdfId);
        if (!pdf) throw new InputError('PDF oturumu sona erdi; dosyayı yeniden yükle.');
        const request = { pdf };
        return { request, key: cacheKey(request, body.pdfId) };
      }
      const raw = typeof body?.text === 'string' ? body.text.trim() : body?.text;
      // DOI ve bağlantılar kısa olabilir; en az uzunluk şartı yalnızca serbest metne uygulanır
      const text = typeof raw === 'string' && classifyInput(raw).kind !== 'text' && raw.length <= INPUT_LIMITS.maxLength ? raw : validateInput(raw);
      const request = { text };
      return { request, key: cacheKey(request) };
    } catch (err) {
      send(res, 400, { error: err instanceof InputError ? err.message : 'Geçersiz istek.' });
      return null;
    }
  }

  async function handlePdf(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!checkRate(req, res)) return;
    try {
      if (!(req.headers['content-type'] ?? '').includes('application/pdf')) throw new InputError('Yalnızca PDF dosyası yüklenebilir.');
      const bytes = await readRawBody(req, MAX_PDF_BYTES);
      const extraction = await extractPdf(new Uint8Array(bytes));
      if (!extraction.text) throw new InputError('Bu PDF\'te seçilebilir metin yok (taranmış bir belge olabilir).');
      let name = 'belge.pdf';
      try {
        name = decodeURIComponent(String(req.headers['x-filename'] ?? name)).replace(/[\u0000-\u001f<>]/g, '').slice(0, 120) || name;
      } catch {
        // varsayılan ad
      }
      const id = randomUUID();
      pdfStore.set(id, { name, pages: extraction.pages, text: extraction.text, title: extraction.title, dois: extraction.dois });
      send(res, 200, { id, name, pages: extraction.pages, chars: extraction.text.length, dois: extraction.dois.length, title: extraction.title ?? null });
    } catch (err) {
      const known = err instanceof InputError || err instanceof PdfError;
      if (!known) log(`pdf hatası: ${(err as Error).stack ?? err}`);
      send(res, known ? 400 : 500, { error: known ? (err as Error).message : 'PDF işlenirken beklenmeyen bir hata oluştu.' });
    }
  }

  async function handleVerify(req: http.IncomingMessage, res: http.ServerResponse) {
    const prepared = await prepare(req, res);
    if (prepared === null) return;

    const cached = cache.get(prepared.key);
    if (cached) return send(res, 200, { ...cached, cached: true });
    if (active >= maxConcurrent) return send(res, 503, { error: 'Sunucu şu an meşgul, birkaç saniye sonra tekrar deneyin.' }, { 'Retry-After': '5' });
    if (!daily.take()) return dailyExhausted(res);

    active++;
    try {
      const report = await analyze(prepared.request, deps);
      cache.set(prepared.key, report);
      send(res, 200, report);
    } catch (err) {
      log(`verify hatası: ${(err as Error).stack ?? err}`);
      send(res, err instanceof InputError ? 400 : 500, { error: err instanceof InputError ? err.message : 'Doğrulama sırasında beklenmeyen bir hata oluştu.' });
    } finally {
      active--;
    }
  }

  /** Server-Sent Events: aşamaları canlı yayınlar, en sonda "report" olayını gönderir */
  async function handleStream(req: http.IncomingMessage, res: http.ServerResponse) {
    const prepared = await prepare(req, res);
    if (prepared === null) return;
    const cached = cache.get(prepared.key);
    if (!cached && active >= maxConcurrent) {
      return send(res, 503, { error: 'Sunucu şu an meşgul, birkaç saniye sonra tekrar deneyin.' }, { 'Retry-After': '5' });
    }
    if (!cached && !daily.take()) return dailyExhausted(res);

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let open = true;
    req.on('close', () => (open = false));
    const write = (event: string, data: unknown) => {
      if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => open && res.write(': ping\n\n'), 15_000);

    if (cached) {
      write('report', { ...cached, cached: true });
      clearInterval(heartbeat);
      return res.end();
    }

    active++;
    try {
      const report = await analyze(prepared.request, { ...deps, onProgress: (e: ProgressEvent) => write('progress', e) });
      cache.set(prepared.key, report);
      write('report', report);
    } catch (err) {
      log(`stream hatası: ${(err as Error).stack ?? err}`);
      write('error', { error: err instanceof InputError ? err.message : 'Doğrulama sırasında beklenmeyen bir hata oluştu.' });
    } finally {
      active--;
      clearInterval(heartbeat);
      res.end();
    }
  }

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, { error: 'Geçersiz yol.' });
    }
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const filePath = path.resolve(publicDir, relative);
    // Dizin dışına çıkma (../) girişimlerini engelle
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) return send(res, 403, { error: 'Erişim reddedildi.' });

    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('not a file');
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(filePath).pipe(res);
    } catch {
      send(res, 404, { error: 'Bulunamadı.' });
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') {
        return send(res, 200, { ok: true, mode: deps.mode, limits: INPUT_LIMITS, dailyRemaining: daily.remaining() });
      }
      if (url.pathname === '/api/tiers' && req.method === 'GET') return send(res, 200, tierReference());
      if (url.pathname === '/api/pdf' && req.method === 'POST') return await handlePdf(req, res);
      if (url.pathname === '/api/verify' && req.method === 'POST') return await handleVerify(req, res);
      if (url.pathname === '/api/verify/stream' && req.method === 'POST') return await handleStream(req, res);
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Bilinmeyen uç nokta.' });
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
      send(res, 405, { error: 'Yönteme izin verilmiyor.' }, { Allow: 'GET, HEAD, POST' });
    } catch (err) {
      log(`istek hatası: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) send(res, 500, { error: 'Sunucu hatası.' });
      else res.end();
    }
  });
}
