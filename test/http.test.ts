import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GeminiJSONProvider } from '../src/adapters/gemini.js';
import { fetchWithRetry, ProviderError } from '../src/adapters/http.js';
import { TavilySearchProvider } from '../src/adapters/tavily.js';

const noSleep = async () => {};

function sequence(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('beklenmeyen çağrı');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('fetchWithRetry', () => {
  it('503 sonrası yeniden dener ve başarılı yanıtı döndürür', async () => {
    const { impl, calls } = sequence(new Response('busy', { status: 503 }), new Response('{"ok":true}'));
    const res = await fetchWithRetry('Test', 'https://x', {}, { fetchImpl: impl, sleep: noSleep });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
  });

  it('400 hatasında yeniden denemez', async () => {
    const { impl, calls } = sequence(new Response('bad', { status: 400 }), new Response('{}'));
    await assert.rejects(fetchWithRetry('Test', 'https://x', {}, { fetchImpl: impl, sleep: noSleep }), (e: ProviderError) => e.status === 400);
    assert.equal(calls.length, 1);
  });

  it('ağ hatasında deneme hakkı bitince ProviderError fırlatır', async () => {
    const { impl, calls } = sequence(new TypeError('fetch failed'), new TypeError('fetch failed'), new TypeError('fetch failed'));
    await assert.rejects(fetchWithRetry('Test', 'https://x', {}, { fetchImpl: impl, sleep: noSleep, retries: 2 }), ProviderError);
    assert.equal(calls.length, 3);
  });
});

describe('adaptörler', () => {
  it('Gemini anahtarı URL\'de değil başlıkta gönderir ve kod çitli JSON\'u ayıklar', async () => {
    const body = { candidates: [{ content: { parts: [{ text: '```json\n{"verdict":"SUPPORTED"}\n```' }] } }] };
    const { impl, calls } = sequence(new Response(JSON.stringify(body)));
    const out = await new GeminiJSONProvider('GIZLI', 'gemini-3.8-flash', { fetchImpl: impl, sleep: noSleep }).generateJSON('s', 'u');
    assert.deepEqual(out, { verdict: 'SUPPORTED' });
    assert.ok(!calls[0]!.url.includes('GIZLI'));
    assert.equal((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key'], 'GIZLI');
  });

  it('Gemini güvenlik engelini anlaşılır hataya çevirir', async () => {
    const { impl } = sequence(new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })));
    await assert.rejects(new GeminiJSONProvider('k', 'gemini-3.8-flash', { fetchImpl: impl }).generateJSON('s', 'u'), /SAFETY/);
  });

  it('geçersiz model adını reddeder (URL enjeksiyonu)', () => {
    assert.throws(() => new GeminiJSONProvider('k', '../../evil?x='), ProviderError);
  });

  it('Tavily anahtarı Bearer başlığında gönderir, gövdede göndermez', async () => {
    const { impl, calls } = sequence(new Response(JSON.stringify({ results: [{ url: 'https://a.example', title: 't', content: 'c' }, { title: 'urlsiz' }] })));
    const hits = await new TavilySearchProvider('tvly-GIZLI', { fetchImpl: impl }).search('q', 50);
    assert.equal(hits.length, 1);
    const init = calls[0]!.init;
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer tvly-GIZLI');
    const sent = JSON.parse(String(init.body));
    assert.equal(sent.api_key, undefined);
    assert.equal(sent.max_results, 10);
  });
});
