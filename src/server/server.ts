import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { EngineDeps } from '../config.js';
import { createApi, json, SECURITY_HEADERS } from '../http/api.js';

/**
 * Yerel geliştirme / kendi sunucunda çalıştırma için Node adaptörü.
 * API mantığı src/http/api.ts'de; Cloudflare Workers da aynısını kullanır (src/worker.ts).
 */

export interface ServerOptions {
  deps: EngineDeps;
  publicDir: string;
  rateLimitPerMinute?: number;
  maxConcurrent?: number;
  cacheTtlMs?: number;
  dailyLimit?: number;
  log?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim()) return cf.trim();
    // X-Forwarded-For'un en sağdaki değeri güvenilen vekilin eklediğidir; soldakiler istemcice uydurulabilir
    const fwd = req.headers['x-forwarded-for'];
    const last = (Array.isArray(fwd) ? fwd.join(',') : fwd)?.split(',').map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function toWebRequest(req: http.IncomingMessage): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    // @ts-expect-error Node'un fetch uygulaması akış gövdeleri için bunu ister
    duplex: hasBody ? 'half' : undefined,
  });
}

async function sendWebResponse(res: http.ServerResponse, response: Response, onClose: () => void, req?: http.IncomingMessage) {
  const headers = Object.fromEntries(response.headers);
  // İstek gövdesi okunmadan yanıt verildiyse (ör. çok büyük gövde reddedildi) bağlantıyı kapat:
  // aksi halde okunmamış baytlar aynı bağlantıdaki sonraki isteği bozar
  const unread = req !== undefined && !req.complete;
  if (unread) {
    headers.connection = 'close';
    res.on('finish', () => req.destroy());
  }
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  res.on('close', () => {
    onClose();
    reader.cancel().catch(() => {});
  });
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

export function createServer(options: ServerOptions): http.Server {
  const { log = () => {} } = options;
  const publicDir = path.resolve(options.publicDir);
  const trustProxy = process.env.TRUST_PROXY === '1';
  const api = createApi(options);

  async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return sendWebResponse(res, json(400, { error: 'Geçersiz yol.' }), () => {});
    }
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const filePath = path.resolve(publicDir, relative);
    // Dizin dışına çıkma (../) girişimlerini ve Cloudflare'e özel _headers gibi dosyaları engelle
    if ((filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) || path.basename(filePath).startsWith('_')) {
      return sendWebResponse(res, json(403, { error: 'Erişim reddedildi.' }), () => {});
    }
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
      await sendWebResponse(res, json(404, { error: 'Bulunamadı.' }), () => {});
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const pending: Promise<unknown>[] = [];
        const response = await api(toWebRequest(req), clientIp(req, trustProxy), (p) => pending.push(p));
        return await sendWebResponse(res, response ?? json(404, { error: 'Bilinmeyen uç nokta.' }), () => {}, req);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, url.pathname);
      await sendWebResponse(res, json(405, { error: 'Yönteme izin verilmiyor.' }, { Allow: 'GET, HEAD, POST' }), () => {});
    } catch (err) {
      log(`istek hatası: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) await sendWebResponse(res, json(500, { error: 'Sunucu hatası.' }), () => {});
      else res.end();
    }
  });
}
