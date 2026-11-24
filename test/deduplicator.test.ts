import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clusterEchoChambers, jaccardSimilarity, tokenizeShingles } from '../src/core/deduplicator.js';
import { node } from './helpers.js';

const COPY = 'Yeni düzenlemeyle tüm elektronik cihazlara yüzde elli ek vergi getirilmesi kesinleşti ve fiyatlar artacak';

describe('deduplicator', () => {
  it('Türkçe büyük harfleri doğru küçültür (İ → i)', () => {
    assert.deepEqual(tokenizeShingles('BİLİM İNSANLARI UYARDI', 3), tokenizeShingles('bilim insanları uyardı', 3));
  });

  it('jaccard benzerliği aynı kümeler için 1, ayrık kümeler için 0', () => {
    const a = new Set(['x y z']);
    assert.equal(jaccardSimilarity(a, a), 1);
    assert.equal(jaccardSimilarity(a, new Set(['q w e'])), 0);
    assert.equal(jaccardSimilarity(new Set(), a), 0);
  });

  it('kopya haberleri tek kümede toplar ve yankı odasını tespit eder', () => {
    const nodes = [
      node('TIER_3_SECONDARY_AGGREGATOR', { snippet: COPY }),
      node('TIER_3_SECONDARY_AGGREGATOR', { snippet: COPY }),
      node('TIER_3_SECONDARY_AGGREGATOR', { snippet: `${COPY} detaylar haberde` }),
      node('TIER_3_SECONDARY_AGGREGATOR', { snippet: COPY }),
      node('TIER_4_SOCIAL_UNVERIFIED', { snippet: 'tamamen farklı bir sosyal medya paylaşımı burada yer alıyor' }),
    ];
    // Başlıklar farklı olduğu için yalnızca özetler benzer; eşik biraz düşük tutulur
    const r = clusterEchoChambers(nodes.map((n) => ({ ...n, title: 'Haber' })));
    assert.equal(r.uniqueClusterCount, 2);
    assert.equal(r.isEchoChamber, true);
  });

  it('zincirleme kopyaları (A≈B, B≈C) aynı kümeye koyar', () => {
    const a = 'bir iki üçüncü dördüncü beşinci altıncı yedinci sekizinci';
    const b = 'bir iki üçüncü dördüncü beşinci altıncı yedinci sekizinci dokuzuncu onuncu';
    const c = 'üçüncü dördüncü beşinci altıncı yedinci sekizinci dokuzuncu onuncu';
    const r = clusterEchoChambers([a, b, c].map((s) => node('TIER_3_SECONDARY_AGGREGATOR', { title: '', snippet: s })));
    assert.equal(r.uniqueClusterCount, 1);
  });

  it('küme temsilcisi olarak en yüksek otoriteli düğümü seçer', () => {
    const nodes = [
      node('TIER_3_SECONDARY_AGGREGATOR', { title: 'Haber', snippet: COPY }),
      node('TIER_2_WIRE_JOURNALISM', { title: 'Haber', snippet: COPY }),
    ];
    const r = clusterEchoChambers(nodes);
    const rep = r.clusteredNodes.find((n) => n.isClusterRepresentative);
    assert.equal(rep?.tier, 'TIER_2_WIRE_JOURNALISM');
  });

  it('az sayıda sonuçta yankı odası demez', () => {
    const r = clusterEchoChambers([node('TIER_3_SECONDARY_AGGREGATOR', { snippet: COPY }), node('TIER_3_SECONDARY_AGGREGATOR', { snippet: COPY })]);
    assert.equal(r.isEchoChamber, false);
  });
});
