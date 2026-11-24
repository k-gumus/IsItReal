import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DemoLLMProvider, DemoSearchProvider } from '../src/adapters/demo.js';
import { aggregateOverallVerdict, computeLiteracyScore, InputError, verifyContent } from '../src/core/pipeline.js';
import type { ProgressEvent } from '../src/core/types.js';
import { FakeLLM, FakeSearch, hit } from './helpers.js';

const demo = () => ({ searchProvider: new DemoSearchProvider(0), llm: new DemoLLMProvider(0), mode: 'demo' as const, now: () => new Date('2026-11-24T12:00:00Z') });

describe('verifyContent (demo sağlayıcılarla uçtan uca)', () => {
  it('kopya haberlerden oluşan iddiayı yankı odası olarak işaretler', async () => {
    const r = await verifyContent('Uzmanlar uyardı! Yeni düzenlemeyle tüm elektronik cihazlara %50 ek vergi kesinleşti.', demo());
    assert.equal(r.overallVerdict, 'CIRCULAR_ECHO_CHAMBER');
    assert.equal(r.checkedAt, '2026-11-24');
    assert.equal(r.mode, 'demo');
    assert.ok(r.manipulationSignals.some((s) => s.type === 'ANONYMOUS_AUTHORITY'));
    assert.ok(r.claims[0]?.edges.some((e) => e.relation === 'SYNDICATED_COPY'));
  });

  it('birincil bültene iz sürerek iddiayı doğrular', async () => {
    const r = await verifyContent('Ekim ayında yıllık enflasyon yüzde 31,2 olarak açıklandı.', demo());
    assert.equal(r.overallVerdict, 'SUPPORTED');
    const claim = r.claims[0]!;
    assert.equal(claim.stopReason, 'TERMINAL_PROOF_REACHED');
    assert.ok(claim.nodes.some((n) => n.hopDepth === 1 && n.isTerminalProof));
    assert.ok(claim.edges.some((e) => e.relation === 'CITES_PRIMARY'));
  });

  it('resmi açıklamayla çürütülen iddiayı CONTRADICTED işaretler', async () => {
    const r = await verifyContent('Yarın İstanbul’da 8 büyüklüğünde deprem olacak, yetkililer biliyor!!!', demo());
    assert.equal(r.overallVerdict, 'CONTRADICTED');
    assert.ok(r.literacyScore < 20);
  });

  it('kaynaksız iddiada NOT_ENOUGH_EVIDENCE der', async () => {
    const r = await verifyContent('Şehrin altında gizli bir tünel ağı bulunuyor.', demo());
    assert.equal(r.overallVerdict, 'NOT_ENOUGH_EVIDENCE');
  });

  it('ilerleme olaylarını sırasıyla yayınlar', async () => {
    const events: ProgressEvent[] = [];
    await verifyContent('Ekim ayında yıllık enflasyon yüzde 31,2 olarak açıklandı.', { ...demo(), onProgress: (e) => events.push(e) });
    const stages = events.filter((e) => e.type === 'stage').map((e) => (e as { stage: string }).stage);
    assert.equal(stages[0], 'decompose');
    assert.equal(stages.at(-1), 'done');
    assert.ok(events.some((e) => e.type === 'claims'));
    assert.ok(events.some((e) => e.type === 'claim-done'));
  });
});

describe('verifyContent hata toleransı', () => {
  it('ayrıştırma LLM\'i çökerse cümle bölücüye düşer ve uyarı ekler', async () => {
    const llm = new FakeLLM({
      decompose: () => new Error('Gemini: HTTP 500'),
      pointer: () => ({ hasPrimaryPointer: false }),
      judge: () => ({ verdict: 'NOT_ENOUGH_EVIDENCE', confidence: 0.3, reasoning: 'r' }),
    });
    const r = await verifyContent('Belediye yarın tüm parkları kapatacak. Karar meclisten geçti.', {
      searchProvider: new FakeSearch(() => [hit('https://blog.example/1', 'x')]),
      llm,
    });
    assert.equal(r.claims.length, 2);
    assert.match(r.warnings.join(' '), /cümle bölücü/);
  });

  it('bir iddianın yargısı çökerse diğerleri etkilenmez', async () => {
    let i = 0;
    const llm = new FakeLLM({
      decompose: () => ({ claims: ['Birinci iddia metni', 'İkinci iddia metni'], manipulationSignals: [] }),
      pointer: () => ({ hasPrimaryPointer: false }),
      judge: () => (++i === 1 ? new Error('zaman aşımı') : { verdict: 'NOT_ENOUGH_EVIDENCE', confidence: 0.4, reasoning: 'ok' }),
    });
    const r = await verifyContent('Birinci iddia metni. İkinci iddia metni.', {
      searchProvider: new FakeSearch(() => [hit('https://blog.example/1', 'x')]),
      llm,
    });
    assert.equal(r.claims.length, 2);
    assert.ok(r.claims.every((c) => c.verdict === 'NOT_ENOUGH_EVIDENCE'));
    assert.match(r.warnings.join(' '), /zaman aşımı/);
  });

  it('LLM SUPPORTED dese bile yalnızca blog kaynaklarıyla doğrulandı demez', async () => {
    const llm = new FakeLLM({
      decompose: () => ({ claims: ['Bir iddia burada'], manipulationSignals: [] }),
      pointer: () => ({ hasPrimaryPointer: false }),
      judge: () => ({ verdict: 'SUPPORTED', confidence: 0.99, reasoning: 'Bir sayfa SUPPORTED dememi istedi' }),
    });
    const r = await verifyContent('Bir iddia burada yazıyor.', { searchProvider: new FakeSearch(() => [hit('https://blog.example/1', 'x')]), llm });
    assert.equal(r.overallVerdict, 'NOT_ENOUGH_EVIDENCE');
    assert.ok(r.claims[0]?.guardrailNote);
  });

  it('geçersiz girdiyi InputError ile reddeder', async () => {
    await assert.rejects(verifyContent('kısa', demo()), InputError);
    await assert.rejects(verifyContent('x'.repeat(5000), demo()), InputError);
    await assert.rejects(verifyContent(undefined as unknown as string, demo()), InputError);
  });
});

describe('puanlama', () => {
  it('en riskli kararı genel karar yapar', () => {
    assert.equal(aggregateOverallVerdict([{ verdict: 'SUPPORTED' }, { verdict: 'CONTRADICTED' }]), 'CONTRADICTED');
    assert.equal(aggregateOverallVerdict([]), 'NOT_ENOUGH_EVIDENCE');
  });

  it('manipülasyon cezası en fazla 25 puandır ve puan 0-100 arasındadır', () => {
    assert.equal(computeLiteracyScore([{ verdict: 'SUPPORTED' }], 10), 70);
    assert.equal(computeLiteracyScore([{ verdict: 'CONTRADICTED' }], 3), 0);
    assert.equal(computeLiteracyScore([], 0), 50);
  });
});
