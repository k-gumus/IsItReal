import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectManipulationHeuristics, excerptAround, mergeSignals } from '../src/core/manipulation.js';

const types = (text: string) => detectManipulationHeuristics(text).map((s) => s.type).sort();

describe('detectManipulationHeuristics', () => {
  it('isimsiz otorite ve mutlak kesinliği yakalar', () => {
    const t = types('Uzmanlar uyardı! Yeni düzenleme kesinleşti.');
    assert.ok(t.includes('ANONYMOUS_AUTHORITY'));
    assert.ok(t.includes('ABSOLUTE_CERTAINTY'));
  });

  it('"yetkililer biliyor ama saklıyor" kalıbını isimsiz otorite sayar', () => {
    assert.ok(types('Yetkililer biliyor ama saklıyor.').includes('ANONYMOUS_AUTHORITY'));
  });

  it('Türkçe harfli kelimeleri büyük harfle yazılsa da yakalar (ŞOK, BİLİM İNSANLARI)', () => {
    assert.ok(types('ŞOK GELİŞME').includes('EMOTIONAL_TRIGGER'));
    assert.ok(types('BİLİM İNSANLARI UYARDI').includes('ANONYMOUS_AUTHORITY'));
  });

  it('kelime içindeki eşleşmelere takılmaz ("şoklama" değil "şok")', () => {
    assert.ok(!types('Ürünler şoklama yöntemiyle donduruldu.').includes('EMOTIONAL_TRIGGER'));
  });

  it('tık tuzağı ve ünlem yağmurunu yakalar', () => {
    const t = types('Bakın ne oldu!!! Silinmeden izle');
    assert.ok(t.includes('CLICKBAIT_GAP'));
    assert.ok(t.includes('EMOTIONAL_TRIGGER'));
  });

  it('kaynaksız değişim yüzdesini işaretler, kaynaklı veya tarafsız rakamı işaretlemez', () => {
    assert.ok(types('Fiyatlar bir haftada %40 arttı.').includes('CHERRY_PICKING'));
    assert.ok(!types('TÜİK verisine göre fiyatlar %31 arttı.').includes('CHERRY_PICKING'));
    assert.ok(!types('Ekim ayında yıllık enflasyon yüzde 31,2 olarak açıklandı.').includes('CHERRY_PICKING'));
  });

  it('alıntı olarak yalnızca eşleşen ifadeyi döndürür', () => {
    const s = detectManipulationHeuristics('Uzmanlar uyardı! Yeni düzenleme geliyor.');
    assert.equal(s.find((x) => x.type === 'ANONYMOUS_AUTHORITY')?.excerpt, 'Uzmanlar uyardı');
  });

  it('tarafsız bir cümlede sinyal üretmez', () => {
    assert.deepEqual(types('Meclis bugün bütçe görüşmelerine devam etti.'), []);
  });
});

describe('excerptAround', () => {
  it('kelime ortasından kesmez', () => {
    const text = 'Bu çok uzun bir giriş cümlesi ve ardından gelen kesinleşti ifadesi ile devam eden metin';
    const ex = excerptAround(text, text.indexOf('kesinleşti'), 'kesinleşti'.length, 12);
    assert.match(ex, /^…\S/);
    assert.ok(!/…[a-zçğıöşü]{1,2}\s/.test(ex.slice(0, 4)));
    assert.ok(ex.includes('kesinleşti'));
  });
});

describe('mergeSignals', () => {
  it('aynı türde LLM sinyalini tercih eder, diğerlerini sezgiselden ekler', () => {
    const merged = mergeSignals(
      [{ type: 'ANONYMOUS_AUTHORITY', excerpt: 'a', explanation: 'llm' }],
      [
        { type: 'ANONYMOUS_AUTHORITY', excerpt: 'b', explanation: 'h', source: 'heuristic' },
        { type: 'CLICKBAIT_GAP', excerpt: 'c', explanation: 'h', source: 'heuristic' },
      ]
    );
    assert.equal(merged.length, 2);
    assert.equal(merged[0]?.source, 'llm');
    assert.equal(merged[1]?.type, 'CLICKBAIT_GAP');
  });
});
