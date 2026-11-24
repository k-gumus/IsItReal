import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DemoLLMProvider, DemoPageExtractor, DemoSearchProvider } from '../src/adapters/demo.js';
import { DemoDoiResolver } from '../src/adapters/doi.js';
import { extractPdf } from '../src/adapters/pdf.js';
import { analyze, citationPenalty } from '../src/core/analyze.js';
import { InputError } from '../src/core/pipeline.js';
import { makePdf } from './helpers.js';

const deps = () => ({
  searchProvider: new DemoSearchProvider(0),
  llm: new DemoLLMProvider(0),
  pageExtractor: new DemoPageExtractor(0),
  doiResolver: new DemoDoiResolver(),
  mode: 'demo' as const,
  now: () => new Date('2026-11-24T12:00:00Z'),
});

describe('analyze', () => {
  it('yalnızca DOI girilince yayın kaydını ve geri çekme durumunu raporlar', async () => {
    const r = await analyze({ text: 'https://doi.org/10.5555/demo.2019.042' }, deps());
    assert.equal(r.source.kind, 'doi');
    assert.equal(r.claims.length, 0);
    assert.equal(r.overallVerdict, 'CONTRADICTED');
    assert.equal(r.citationSummary.retracted, 1);
    assert.ok(r.lateralReadingTips.some((t) => /yıllık/.test(t)) === false); // 2019 → 7 yıl, eski uyarısı yok
  });

  it('kayıtsız DOI için sıfır puan ve uydurma atıf uyarısı verir', async () => {
    const r = await analyze({ text: '10.5555/demo.uydurma' }, deps());
    assert.equal(r.citationSummary.notFound, 1);
    assert.equal(r.literacyScore, 0);
    assert.ok(r.lateralReadingTips.some((t) => /uydurulmuş/.test(t)));
  });

  it('metindeki DOI\'leri denetler ve sorunlu atıflar için puan düşer', async () => {
    const text = 'Ekim ayında yıllık enflasyon yüzde 31,2 olarak açıklandı. Kaynak: 10.5555/demo.2024.001 ve 10.5555/demo.yok';
    const r = await analyze({ text }, deps());
    assert.equal(r.source.kind, 'text');
    assert.equal(r.citationSummary.total, 2);
    assert.equal(r.citationSummary.notFound, 1);
    assert.equal(r.overallVerdict, 'SUPPORTED');
    assert.equal(citationPenalty(r.citationSummary), 8);
    assert.equal(r.literacyScore, 95 - 8);
  });

  it('bağlantının içeriğini çeker ve bağlantının kaynak katmanını ekler', async () => {
    const r = await analyze({ text: 'https://haber-sitesi.example/vergi' }, deps());
    assert.equal(r.source.kind, 'url');
    assert.equal(r.source.classification?.tier, 'TIER_3_SECONDARY_AGGREGATOR');
    assert.equal(r.overallVerdict, 'CIRCULAR_ECHO_CHAMBER');
  });

  it('içeriği alınamayan bağlantıda anlaşılır InputError fırlatır', async () => {
    const d = { ...deps(), pageExtractor: { extract: async () => { throw new Error('403'); } } };
    await assert.rejects(analyze({ text: 'https://kapali.example/x' }, d), (e: Error) => e instanceof InputError && /yapıştırmayı dene/.test(e.message));
  });

  it('PDF\'in özetini doğrular ve içindeki tüm DOI\'leri denetler', async () => {
    const bytes = await makePdf([
      'Abstract. Ekim ayinda yillik enflasyon yuzde 31,2 olarak aciklandi ve bulten yayimlandi.',
      'References',
      '[1] doi:10.5555/demo.2024.001',
      '[2] https://doi.org/10.5555/demo.2019.042',
      '[3] 10.5555/demo.olmayan',
    ]);
    const pdf = await extractPdf(bytes);
    const r = await analyze({ pdf: { name: 'makale.pdf', ...pdf } }, deps());
    assert.equal(r.source.kind, 'pdf');
    assert.equal(r.source.pages, 1);
    assert.deepEqual(
      { found: r.citationSummary.found, notFound: r.citationSummary.notFound, retracted: r.citationSummary.retracted },
      { found: 2, notFound: 1, retracted: 1 }
    );
    assert.ok(r.claims.length >= 1);
    assert.ok(r.claims.every((c) => !/references|\[\d\]/i.test(c.claimText)), 'kaynakça satırları iddia sayılmamalı');
  });

  it('yalnızca kaynakçadan oluşan metinde sadece atıf denetimi yapar', async () => {
    const r = await analyze({ text: 'Kaynaklar: 10.5555/demo.2024.001, 10.5555/demo.uydurma' }, deps());
    assert.equal(r.claims.length, 0);
    assert.equal(r.citationSummary.total, 2);
    assert.equal(r.overallVerdict, 'NOT_ENOUGH_EVIDENCE');
    assert.equal(r.literacyScore, 45);
  });

  it('metni olmayan PDF\'i reddeder', async () => {
    await assert.rejects(analyze({ pdf: { name: 'tarama.pdf', pages: 3, text: ' ', dois: [] } }, deps()), InputError);
  });
});
