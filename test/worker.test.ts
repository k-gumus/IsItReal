import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import worker from '../src/worker.js';

const env = {
  ASSETS: { fetch: async (req: Request) => new Response(`asset:${new URL(req.url).pathname}`) },
  DEMO_MODE: '1',
  DEMO_LATENCY_MS: '0',
  DAILY_LIMIT: '100',
};
const ctx = () => {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => pending.push(p), pending };
};

describe('Cloudflare Worker girişi', () => {
  it('API dışındaki istekleri statik dosyalara yönlendirir', async () => {
    const res = await worker.fetch(new Request('https://isitreal.example/index.html'), env, ctx());
    assert.equal(await res.text(), 'asset:/index.html');
  });

  it('sağlık ucunda demo modunu ve kalan günlük hakkı bildirir', async () => {
    const body = await (await worker.fetch(new Request('https://isitreal.example/api/health'), env, ctx())).json();
    assert.equal(body.mode, 'demo');
    assert.equal(body.dailyRemaining, 100);
  });

  it("akış ucunda raporu SSE olarak gönderir ve işi waitUntil'e bağlar", async () => {
    const c = ctx();
    const res = await worker.fetch(
      new Request('https://isitreal.example/api/verify/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify({ text: 'Ekim ayında yıllık enflasyon yüzde 31,2 olarak açıklandı.' }),
      }),
      env,
      c
    );
    assert.match(res.headers.get('content-type') ?? '', /event-stream/);
    const text = await res.text();
    assert.equal(c.pending.length, 1);
    const report = JSON.parse(text.split('\n\n').find((b) => b.startsWith('event: report'))!.split('\ndata: ')[1]!);
    assert.equal(report.overallVerdict, 'SUPPORTED');
  });
});
