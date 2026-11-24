import type { ExtractedPage, LLMCallOptions, PageExtractor, SearchHit, StructuredLLMProvider, WebSearchProvider } from '../core/providers.js';
import { fallbackSplitClaims } from '../core/nli-judge.js';

/**
 * API anahtarı olmadan arayüzü ve hattı denemek için çevrimdışı sağlayıcılar.
 * TÜM İÇERİK KURGUSALDIR: alan adları "demo-" önekli ya da ayrılmış .example uzantılıdır;
 * gerçek bir kurumun açıklaması değildir.
 */

const wait = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

type Scenario = 'tax' | 'inflation' | 'quake' | 'unknown';

function detectScenario(text: string): Scenario {
  const t = text.toLocaleLowerCase('tr-TR');
  if (/vergi|gümrük|harç/.test(t)) return 'tax';
  if (/enflasyon|tüfe|fiyat endeksi|istatistik/.test(t)) return 'inflation';
  if (/deprem|zelzele|sarsıntı/.test(t)) return 'quake';
  return 'unknown';
}

const TAX_COPY =
  'Uzmanlar uyardı: yeni düzenlemeyle tüm elektronik cihazlara yüzde 50 ek vergi getirilmesi kesinleşti, telefon ve bilgisayar fiyatları uçacak.';

const FIXTURES: Record<Scenario, { initial: SearchHit[]; verification: SearchHit[]; primary: SearchHit[] }> = {
  tax: {
    initial: [
      { url: 'https://gundem-portali.example/elektronik-vergi', title: 'Elektronik cihazlara yüzde 50 ek vergi kesinleşti', snippet: TAX_COPY, publishedDate: '2026-11-20' },
      { url: 'https://sondakika-haber.example/vergi-sok', title: 'Elektronik cihazlara yüzde 50 ek vergi kesinleşti!', snippet: TAX_COPY, publishedDate: '2026-11-20' },
      { url: 'https://manset-ajansi.example/teknoloji/ek-vergi', title: 'Elektronik cihazlara yüzde 50 ek vergi kesinleşti', snippet: `${TAX_COPY} Detaylar haberimizde.`, publishedDate: '2026-11-21' },
      { url: 'https://viral-bulten.example/elektronik', title: 'SON DAKİKA: Elektronik cihazlara yüzde 50 ek vergi kesinleşti', snippet: TAX_COPY, publishedDate: '2026-11-21' },
      { url: 'https://x.com/demo_hesap/status/1001', title: 'demo_hesap gönderisi', snippet: 'Telefon alacaklar acele etsin, yüzde 50 vergi geliyor!!! Herkese paylaşın.', publishedDate: '2026-11-19' },
    ],
    verification: [
      { url: 'https://haber-aktarim.example/vergi-kesinlesti', title: 'Elektronik cihazlara yüzde 50 ek vergi kesinleşti', snippet: TAX_COPY, publishedDate: '2026-11-22' },
    ],
    primary: [],
  },
  inflation: {
    initial: [
      { url: 'https://ekonomi-gazetesi.example/enflasyon-ekim', title: 'Ekim ayı enflasyonu açıklandı', snippet: 'Demo İstatistik Kurumu Ekim 2026 Tüketici Fiyat Endeksi bültenine göre yıllık enflasyon yüzde 31,2 oldu.', publishedDate: '2026-11-03' },
      { url: 'https://finans-haber.example/tufe', title: 'Yıllık enflasyon yüzde 31,2', snippet: 'Kurumun açıkladığı bültende aylık artışın gıda ve konut kalemlerinden kaynaklandığı belirtildi.', publishedDate: '2026-11-03' },
      { url: 'https://x.com/demo_ekonomist/status/2002', title: 'demo_ekonomist gönderisi', snippet: 'Açıklanan enflasyon rakamı hissedilenin çok altında.', publishedDate: '2026-11-03' },
    ],
    verification: [],
    primary: [
      { url: 'https://demo-istatistik.gov.tr/bulten/tufe-ekim-2026', title: 'Tüketici Fiyat Endeksi, Ekim 2026 (demo bülten)', snippet: 'TÜFE yıllık %31,2, aylık %2,1 arttı. Bülten no: DEMO-2026-10.', publishedDate: '2026-11-03' },
    ],
  },
  quake: {
    initial: [
      { url: 'https://x.com/demo_kahin/status/3003', title: 'demo_kahin gönderisi', snippet: 'Yarın İstanbul’da 8 büyüklüğünde deprem olacak, kaynaklara göre yetkililer biliyor!!!', publishedDate: '2026-11-23' },
      { url: 'https://forum-sohbet.example/konu/deprem-tahmini', title: 'Yarın büyük deprem mi olacak?', snippet: 'Bir kullanıcının paylaştığı deprem tahmini forumda tartışılıyor.', publishedDate: '2026-11-23' },
    ],
    verification: [
      { url: 'https://demo-afet.gov.tr/duyuru/deprem-tahmini-iddiasi', title: 'Sosyal medyadaki deprem tahmini iddialarına ilişkin açıklama (demo)', snippet: 'Depremlerin gün ve büyüklük vererek önceden tahmin edilmesi bilimsel olarak mümkün değildir. Paylaşılan iddia asılsızdır.', publishedDate: '2026-11-23' },
    ],
    primary: [],
  },
  unknown: {
    initial: [
      { url: 'https://blog-yazilari.example/yazi/123', title: 'Bir blog yazısı', snippet: 'Konuya dair kişisel değerlendirmeler ve doğrulanmamış aktarımlar.', publishedDate: '2026-10-01' },
      { url: 'https://tartisma-forumu.example/konu/456', title: 'Forum başlığı', snippet: 'Kullanıcılar iddiayı tartışıyor, kaynak gösteren yok.', publishedDate: '2026-10-02' },
    ],
    verification: [],
    primary: [],
  },
};

export class DemoSearchProvider implements WebSearchProvider {
  constructor(private readonly latencyMs = 350) {}

  async search(query: string, maxResults = 6): Promise<SearchHit[]> {
    await wait(this.latencyMs);
    const fixture = FIXTURES[detectScenario(query)];
    const hits = query.includes('site:') ? fixture.primary : /teyit|fact check/i.test(query) ? fixture.verification : fixture.initial;
    return hits.slice(0, maxResults);
  }
}

const between = (text: string, open: string, close: string) => {
  const s = text.indexOf(open);
  const e = text.indexOf(close, s + open.length);
  return s === -1 || e === -1 ? text : text.slice(s + open.length, e);
};

export class DemoLLMProvider implements StructuredLLMProvider {
  constructor(private readonly latencyMs = 500) {}

  async generateJSON(_systemPrompt: string, userPrompt: string, options?: LLMCallOptions): Promise<unknown> {
    await wait(this.latencyMs);

    if (options?.task === 'decompose') {
      // Sezgisel modül manipülasyon sinyallerini zaten buluyor; demo burada yalnızca cümle böler
      return { claims: fallbackSplitClaims(between(userPrompt, '<girdi>', '</girdi>')), manipulationSignals: [] };
    }

    if (options?.task === 'pointer') {
      const lines = between(userPrompt, '<kanitlar>', '</kanitlar>').split('\n');
      const idx = lines.findIndex((l) => /bülten/i.test(l));
      if (idx === -1) return { hasPrimaryPointer: false, citedEntityOrDocument: null, targetedPrimaryQuery: null, sourceIndex: null };
      return {
        hasPrimaryPointer: true,
        citedEntityOrDocument: 'Demo İstatistik Kurumu Ekim 2026 TÜFE bülteni',
        targetedPrimaryQuery: 'site:demo-istatistik.gov.tr enflasyon tüketici fiyat endeksi ekim 2026 bülten',
        sourceIndex: idx + 1,
      };
    }

    // judge
    const evidence = between(userPrompt, '<kanitlar>', '</kanitlar>');
    const blocks = evidence.split(/\n\n(?=\[Kanıt )/);
    const tier1Index = blocks.findIndex((b) => b.includes('TIER_1_TERMINAL_PROOF'));
    if (tier1Index === -1) {
      return {
        verdict: 'NOT_ENOUGH_EVIDENCE',
        confidence: 0.35,
        reasoning: 'Toplanan kaynakların hiçbiri birincil bir belgeye, resmi kuruma ya da teyit kuruluşuna dayanmıyor (demo yargı).',
        lateralReadingTips: ['İddiada adı geçen kurumun resmi sitesinde aynı bilgiyi ara.', 'Haberin ilk yayımlandığı tarihi ve ilk kaynağı bul.'],
      };
    }
    const block = blocks[tier1Index] ?? '';
    const refutes = /asılsız|yalanla|mümkün değildir|doğru değildir/i.test(block);
    return {
      verdict: refutes ? 'CONTRADICTED' : 'SUPPORTED',
      confidence: refutes ? 0.9 : 0.86,
      reasoning: refutes
        ? `Kanıt ${tier1Index + 1} resmi bir kurumun açıklaması ve iddiayı açıkça çürütüyor; diğer kaynaklar yalnızca sosyal medya paylaşımı (demo yargı).`
        : `Kanıt ${tier1Index + 1} iddianın dayandığı birincil bülten ve haberlerdeki rakamla birebir örtüşüyor (demo yargı).`,
      lateralReadingTips: refutes
        ? ['Afet ve acil durum kurumlarının resmi hesaplarını takip et.', 'Tarih ve büyüklük veren deprem "tahminleri"ne karşı temkinli ol.']
        : ['Bültenin yayın tarihini ve kapsadığı dönemi kontrol et.', 'Yıllık ve aylık oranları karıştırmadığından emin ol.'],
    };
  }
}

/** Demo: her bağlantı için aynı kurgusal haber metnini döndürür. */
export class DemoPageExtractor implements PageExtractor {
  constructor(private readonly latencyMs = 350) {}
  async extract(url: string): Promise<ExtractedPage> {
    await wait(this.latencyMs);
    return {
      url,
      title: 'Elektronik cihazlara yüzde 50 ek vergi kesinleşti (demo sayfa)',
      text: 'SON DAKİKA! Uzmanlar uyardı: yeni düzenlemeyle tüm elektronik cihazlara yüzde 50 ek vergi getirilmesi kesinleşti. Telefon ve bilgisayar fiyatları uçacak, silinmeden okuyun ve herkese paylaşın.',
    };
  }
}
