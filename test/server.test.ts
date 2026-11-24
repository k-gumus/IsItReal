import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DemoLLMProvider, DemoSearchProvider } from '../src/adapters/demo.js';
import { createServer } from '../src/server/server.js';
import { RateLimiter, TtlCache } from '../src/server/limits.js';

let base = '';
let close: () => Promise<void>;

before(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'isitreal-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  const server = createServer({
    deps: { mode: 'demo', searchProvider: new DemoSearchProvider(0), llm: new DemoLLMProvider(0), tracerConfig: { maxDepth: 2 } },
    publicDir: dir,
    rateLimitPerMinute: 6,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});
after(() => close());

const post = (p: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
  fetch(base + p, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('HTTP sunucusu', () => {
  it('sağlık ucu modu bildirir', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.deepEqual((await res.json()).mode, 'demo');
  });

  it('ana sayfayı güvenlik başlıklarıyla sunar', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  it('dizin dışına çıkma girişimini engeller', async () => {
    const res = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
    assert.ok(res.status === 403 || res.status === 404);
  });

  it('POST /api/verify rapor döndürür, ikinci istek önbellekten gelir', async () => {
    const text = 'Ekim ayında yıllık enflasyon yüzde 31,2 olarak açıklandı.';
    const first = await (await post('/api/verify', { text })).json();
    assert.equal(first.overallVerdict, 'SUPPORTED');
    const second = await (await post('/api/verify', { text: `  ${text}  ` })).json();
    assert.equal(second.cached, true);
  });

  it('geçersiz girdide 400 ve anlaşılır mesaj döner', async () => {
    const short = await post('/api/verify', { text: 'kısa' });
    assert.equal(short.status, 400);
    assert.match((await short.json()).error, /en az/);
    assert.equal((await post('/api/verify', '{bozuk', { 'Content-Type': 'application/json' })).status, 400);
    assert.equal((await post('/api/verify', 'text=merhaba', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 400);
  });

  it('akış ucu ilerleme olaylarını ve raporu SSE olarak yollar', async () => {
    const res = await post('/api/verify/stream', { text: 'Yarın İstanbul’da 8 büyüklüğünde deprem olacak!!!' });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /event: progress/);
    assert.match(body, /event: report/);
    const reportLine = body.split('\n\n').find((b) => b.startsWith('event: report'))!;
    const report = JSON.parse(reportLine.split('\ndata: ')[1]!);
    assert.equal(report.overallVerdict, 'CONTRADICTED');
  });

  it('hız sınırını aşınca 429 ve Retry-After döner', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 8; i++) last = await post('/api/verify', { text: 'kısa' });
    assert.equal(last?.status, 429);
    assert.ok(Number(last?.headers.get('retry-after')) > 0);
  });
});

describe('limitler', () => {
  it('RateLimiter pencere dolunca reddeder, süre geçince sıfırlar', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    assert.ok(rl.take('a').allowed);
    assert.ok(rl.take('a').allowed);
    assert.ok(!rl.take('a').allowed);
    assert.ok(rl.take('b').allowed);
    t = 1001;
    assert.ok(rl.take('a').allowed);
  });

  it('TtlCache süresi dolanı ve en eskiyi atar', () => {
    let t = 0;
    const c = new TtlCache<number>(100, 2, () => t);
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3); // en az kullanılan "b" atılır
    assert.equal(c.get('b'), undefined);
    assert.equal(c.get('a'), 1);
    t = 200;
    assert.equal(c.get('a'), undefined);
  });
});
