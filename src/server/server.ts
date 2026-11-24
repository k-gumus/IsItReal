import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import type { EngineDeps } from '../config.js';
import { INPUT_LIMITS, InputError, validateInput, verifyContent } from '../core/pipeline.js';
import type { ProgressEvent, VerificationReport } from '../core/types.js';
import { RateLimiter, TtlCache } from './limits.js';

export interface ServerOptions {
  deps: EngineDeps;
  publicDir: string;
  /** Dakikada IP başına en fazla doğrulama isteği */
  rateLimitPerMinute?: number;
  maxConcurrent?: number;
  cacheTtlMs?: number;
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

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const cacheKey = (text: string) => text.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();

export function createServer(options: ServerOptions): http.Server {
  const { deps, log = () => {} } = options;
  const publicDir = path.resolve(options.publicDir);
  const limiter = new RateLimiter(options.rateLimitPerMinute ?? 8, 60_000);
  const cache = new TtlCache<VerificationReport>(options.cacheTtlMs ?? 10 * 60_000, 100);
  const maxConcurrent = options.maxConcurrent ?? 4;
  const trustProxy = process.env.TRUST_PROXY === '1';
  let active = 0;

  /** Ortak ön kontroller: hız sınırı, eşzamanlılık, gövde ve girdi doğrulaması */
  async function prepare(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
    const ip = clientIp(req, trustProxy);
    const limit = limiter.take(ip);
    if (!limit.allowed) {
      send(res, 429, { error: 'Çok fazla istek. Lütfen biraz bekleyin.' }, { 'Retry-After': String(Math.ceil(limit.retryAfterMs / 1000)) });
      return null;
    }
    try {
      const body = (await readJsonBody(req)) as { text?: unknown };
      return validateInput(body?.text);
    } catch (err) {
      send(res, 400, { error: err instanceof InputError ? err.message : 'Geçersiz istek.' });
      return null;
    }
  }

  async function handleVerify(req: http.IncomingMessage, res: http.ServerResponse) {
    const text = await prepare(req, res);
    if (text === null) return;

    const cached = cache.get(cacheKey(text));
    if (cached) return send(res, 200, { ...cached, cached: true });
    if (active >= maxConcurrent) return send(res, 503, { error: 'Sunucu şu an meşgul, birkaç saniye sonra tekrar deneyin.' }, { 'Retry-After': '5' });

    active++;
    try {
      const report = await verifyContent(text, deps);
      cache.set(cacheKey(text), report);
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
    const text = await prepare(req, res);
    if (text === null) return;
    const cached = cache.get(cacheKey(text));
    if (!cached && active >= maxConcurrent) {
      return send(res, 503, { error: 'Sunucu şu an meşgul, birkaç saniye sonra tekrar deneyin.' }, { 'Retry-After': '5' });
    }

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
      const report = await verifyContent(text, { ...deps, onProgress: (e: ProgressEvent) => write('progress', e) });
      cache.set(cacheKey(text), report);
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
        return send(res, 200, { ok: true, mode: deps.mode, limits: INPUT_LIMITS });
      }
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
