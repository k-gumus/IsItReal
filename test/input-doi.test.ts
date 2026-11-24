import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDois } from '../src/core/citations.js';
import { OpenDoiResolver, parseCrossrefWork, RoutingDoiResolver } from '../src/adapters/doi.js';
import { classifyInput, cleanDoi, extractDois, pickAnalysisWindow } from '../src/core/input.js';

describe('classifyInput', () => {
  it('DOI\'yi çıplak, doi: önekli ve doi.org bağlantısı olarak tanır', () => {
    assert.deepEqual(classifyInput('10.1038/nature12373'), { kind: 'doi', doi: '10.1038/nature12373' });
    assert.deepEqual(classifyInput(' doi: 10.1038/Nature12373 '), { kind: 'doi', doi: '10.1038/nature12373' });
    assert.deepEqual(classifyInput('https://doi.org/10.1000/xyz123'), { kind: 'doi', doi: '10.1000/xyz123' });
  });

  it('tek bir http(s) bağlantısını URL sayar, metin içindeki bağlantıyı saymaz', () => {
    assert.equal(classifyInput('https://www.example.com/haber/1').kind, 'url');
    assert.equal(classifyInput('Şu habere bak https://example.com/a').kind, 'text');
    assert.equal(classifyInput('javascript:alert(1)').kind, 'text');
    assert.equal(classifyInput('http://localhost/admin').kind, 'text');
  });
});

describe('extractDois', () => {
  it('metindeki DOI\'leri tekilleştirerek ve sondaki noktalamayı atarak bulur', () => {
    const text = 'Bkz. (doi:10.1000/ABC.1), ayrıca https://doi.org/10.1000/abc.1. ve 10.5555/x(2)y;';
    assert.deepEqual(extractDois(text), ['10.1000/abc.1', '10.5555/x(2)y']);
  });

  it('dengeli parantezleri korur, dengesiz kapanışı atar', () => {
    assert.equal(cleanDoi('10.1002/(sici)1097-0258)'), '10.1002/(sici)1097-0258');
    assert.equal(cleanDoi('10.1000/abc)'), '10.1000/abc');
  });
});

describe('pickAnalysisWindow', () => {
  it('özet bölümünden başlar ve yarım cümleyi atar', () => {
    const doc = `Başlık Sayfası Yazarlar ${'x '.repeat(50)} Özet Bu çalışma şunu gösteriyor. ${'Uzun bir cümle daha. '.repeat(400)}`;
    const w = pickAnalysisWindow(doc, 500);
    assert.ok(w.startsWith('Özet'));
    assert.ok(w.endsWith('.'));
    assert.ok(w.length <= 500);
  });
});

const crossrefRetracted = {
  title: ['A retracted study'],
  author: [{ given: 'Ada', family: 'Yılmaz' }],
  'container-title': ['Journal of Tests'],
  publisher: 'Test Pub',
  issued: { 'date-parts': [[2012, 3]] },
  type: 'journal-article',
  'is-referenced-by-count': 44,
  'updated-by': [{ DOI: '10.1000/NOTICE', type: 'retraction', label: 'Retraction', source: 'retraction-watch', updated: { 'date-time': '2019-07-01T00:00:00Z' } }],
};

describe('parseCrossrefWork', () => {
  it('geri çekme bildirimini (updated-by) tespit eder ve üst veriyi ayrıştırır', () => {
    const c = parseCrossrefWork('10.1000/x', crossrefRetracted);
    assert.equal(c.status, 'found');
    assert.equal(c.isRetracted, true);
    assert.equal(c.year, 2012);
    assert.deepEqual(c.authors, ['Ada Yılmaz']);
    assert.deepEqual(c.updates[0], { type: 'retraction', label: 'Retraction', source: 'retraction-watch', date: '2019-07-01', noticeDoi: '10.1000/notice' });
  });

  it('düzeltme (correction) geri çekme sayılmaz', () => {
    const c = parseCrossrefWork('10.1000/y', { ...crossrefRetracted, 'updated-by': [{ type: 'correction', label: 'Correction' }] });
    assert.equal(c.isRetracted, false);
    assert.equal(c.updates.length, 1);
  });
});

function routeFetch(routes: Record<string, () => Response | Error>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const out = key ? routes[key]!() : new Response('', { status: 404 });
    if (out instanceof Error) throw out;
    return out;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('OpenDoiResolver', () => {
  it('Crossref kaydını bulur', async () => {
    const { impl, calls } = routeFetch({ 'api.crossref.org': () => json({ message: crossrefRetracted }) });
    const c = await new OpenDoiResolver('a@b.c', { fetchImpl: impl, sleep: async () => {} }).check('10.1000/X');
    assert.equal(c.agency, 'Crossref');
    assert.equal(c.isRetracted, true);
    assert.match(calls[0]!, /mailto=a%40b\.c/);
  });

  it('Crossref\'te ve doi.org\'da yoksa not_found döner', async () => {
    const { impl } = routeFetch({
      'api.crossref.org': () => new Response('Resource not found.', { status: 404 }),
      'doi.org/api/handles': () => json({ responseCode: 100, handle: '10.1000/yok' }, 404),
    });
    const c = await new OpenDoiResolver(undefined, { fetchImpl: impl, sleep: async () => {} }).check('10.1000/yok');
    assert.equal(c.status, 'not_found');
  });

  it('Crossref\'te yok ama kayıtlıysa DataCite üst verisini kullanır', async () => {
    const { impl } = routeFetch({
      'api.crossref.org': () => new Response('', { status: 404 }),
      'doi.org/api/handles': () => json({ responseCode: 1 }),
      'api.datacite.org': () => json({ data: { attributes: { titles: [{ title: 'Zenodo veri seti' }], publicationYear: 2023, publisher: { name: 'Zenodo' }, creators: [{ name: 'Kaya, E.' }] } } }),
    });
    const c = await new OpenDoiResolver(undefined, { fetchImpl: impl, sleep: async () => {} }).check('10.5281/zenodo.1');
    assert.equal(c.status, 'found');
    assert.equal(c.agency, 'DataCite');
    assert.equal(c.publisher, 'Zenodo');
    assert.equal(c.year, 2023);
  });

  it('ağ hatasında fırlatmaz, error durumu döner', async () => {
    const { impl } = routeFetch({ 'api.crossref.org': () => new TypeError('fetch failed') });
    const c = await new OpenDoiResolver(undefined, { fetchImpl: impl, sleep: async () => {}, retries: 0 }).check('10.1000/z');
    assert.equal(c.status, 'error');
    assert.ok(c.error);
  });

  it('demo DOI\'lerini ağa çıkmadan yanıtlar', async () => {
    const { impl, calls } = routeFetch({});
    const r = new RoutingDoiResolver(new OpenDoiResolver(undefined, { fetchImpl: impl }));
    assert.equal((await r.check('10.5555/demo.2019.042')).isRetracted, true);
    assert.equal(calls.length, 0);
  });

  it('checkDois sırayı korur ve eşzamanlılığı sınırlar', async () => {
    let active = 0;
    let peak = 0;
    const resolver = {
      check: async (doi: string) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { doi, status: 'found' as const, url: '', updates: [], isRetracted: false };
      },
    };
    const dois = Array.from({ length: 12 }, (_, i) => `10.1000/${i}`);
    const out = await checkDois(resolver, dois, 3);
    assert.deepEqual(out.map((c) => c.doi), dois);
    assert.ok(peak <= 3);
  });
});

describe('kaynakça ayıklama', () => {
  it('References bölümünü ve [1] gibi atıf işaretlerini iddia metninden çıkarır', async () => {
    const { stripDois } = await import('../src/core/input.js');
    const text = 'Özet. Isı adaları enerji tüketimini artırıyor [1, 2].\nReferences\n[1] doi:10.1000/a\n[2] 10.1000/b';
    assert.equal(stripDois(text), 'Özet. Isı adaları enerji tüketimini artırıyor.');
  });
});
