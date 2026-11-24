import type { SourceTier } from './types.js';

/** Resmi kurum uzantıları: bu son eklerle biten her alan adı birincil kaynak sayılır. */
const TERMINAL_DOMAIN_SUFFIXES = ['.gov.tr', '.edu.tr', '.bel.tr', '.tsk.tr', '.gov', '.edu', '.mil', '.int'];

/** Tam eşleşme veya alt alan adı (ör. data.tuik.gov.tr) olarak Tier 1 sayılan kaynaklar. */
const TERMINAL_DOMAINS = [
  // Türkiye birincil resmi ve veri kaynakları
  'resmigazete.gov.tr',
  'tuik.gov.tr',
  'tcmb.gov.tr',
  'tbmm.gov.tr',
  'anayasa.gov.tr',
  'yargitay.gov.tr',
  'kap.org.tr',
  'iletisim.gov.tr',
  // Akademik ve hakemli yayın indeksleri
  'doi.org',
  'pubmed.ncbi.nlm.nih.gov',
  'arxiv.org',
  'nature.com',
  'science.org',
  'thelancet.com',
  'nejm.org',
  'bmj.com',
  'who.int',
  'worldbank.org',
  'oecd.org',
  'imf.org',
  'europa.eu',
  // IFCN imzacısı teyit kuruluşları (metodolojik kök kanıt kestirmesi)
  'teyit.org',
  'dogrulukpayi.com',
  'malumatfurus.org',
  'fullfact.org',
  'snopes.com',
  'politifact.com',
  'factcheck.org',
];

/** Köklü haber ajansları: genel haberleri Tier 2, teyit bölümleri Tier 1. */
const WIRE_AND_ESTABLISHED_MEDIA = [
  'reuters.com',
  'apnews.com',
  'afp.com',
  'aa.com.tr',
  'bbc.com',
  'bbc.co.uk',
  'dw.com',
  'euronews.com',
  'bloomberg.com',
  'bloomberght.com',
  'ft.com',
  'economist.com',
  'nytimes.com',
  'theguardian.com',
  'washingtonpost.com',
];

const SOCIAL_DOMAINS = [
  'x.com',
  'twitter.com',
  'instagram.com',
  'tiktok.com',
  'facebook.com',
  'fb.watch',
  'reddit.com',
  'youtube.com',
  'youtu.be',
  'threads.net',
  'bsky.app',
  't.me',
  'telegram.me',
  'whatsapp.com',
  'eksisozluk.com',
  'quora.com',
  'pinterest.com',
];

/** Haber ajanslarının teyit (fact-check) bölümleri: alan adı + yol öneki. */
const FACT_CHECK_SECTIONS: Array<{ domain: string; test: (host: string, path: string) => boolean }> = [
  { domain: 'reuters.com', test: (_h, p) => p.startsWith('/fact-check') },
  { domain: 'apnews.com', test: (_h, p) => p.includes('fact-check') },
  { domain: 'afp.com', test: (h) => /^(factcheck|factuel|faktencheck|periodismo|checamos|teyit)\./.test(h) },
];

const DOI_PATTERN = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;
const ACADEMIC_PUBLISHERS = ['wiley.com', 'springer.com', 'sciencedirect.com', 'ieee.org', 'tandfonline.com', 'mdpi.com', 'acm.org'];

export interface SourceClassification {
  domain: string;
  tier: SourceTier;
  isTerminalProof: boolean;
  /** Arayüzde gösterilen kısa gerekçe */
  reason: string;
}

/** `domain` listedeki bir alan adının kendisi ya da alt alan adı mı? (sahte "tuik.gov.tr.evil.com" eşleşmez) */
export function matchesDomain(domain: string, list: readonly string[]): string | undefined {
  return list.find((d) => domain === d || domain.endsWith(`.${d}`));
}

export function extractDomain(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

function extractPath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return '';
  }
}

export function classifySource(rawUrl: string, snippet = ''): SourceClassification {
  const domain = extractDomain(rawUrl);

  if (!domain) {
    return { domain: 'unknown', tier: 'TIER_4_SOCIAL_UNVERIFIED', isTerminalProof: false, reason: 'Geçersiz veya http(s) olmayan adres' };
  }

  // 1. Haber ajanslarının teyit bölümleri (ör. reuters.com/fact-check)
  const path = extractPath(rawUrl);
  for (const section of FACT_CHECK_SECTIONS) {
    if (matchesDomain(domain, [section.domain]) && section.test(domain, path)) {
      return { domain, tier: 'TIER_1_TERMINAL_PROOF', isTerminalProof: true, reason: `${section.domain} teyit bölümü (IFCN)` };
    }
  }

  // 2. Listedeki resmi, akademik veya IFCN teyit alan adları (alt alan adları dahil)
  const terminal = matchesDomain(domain, TERMINAL_DOMAINS);
  if (terminal) {
    return { domain, tier: 'TIER_1_TERMINAL_PROOF', isTerminalProof: true, reason: `Birincil kaynak listesinde: ${terminal}` };
  }

  // 3. Resmi kurum uzantıları (.gov.tr, .edu.tr vb.)
  const suffix = TERMINAL_DOMAIN_SUFFIXES.find((s) => domain.endsWith(s));
  if (suffix) {
    return { domain, tier: 'TIER_1_TERMINAL_PROOF', isTerminalProof: true, reason: `Resmi kurum uzantısı (${suffix})` };
  }

  // 4. DOI numarası içeren akademik yayıncı sayfaları
  const publisher = matchesDomain(domain, ACADEMIC_PUBLISHERS);
  if (publisher && DOI_PATTERN.test(snippet)) {
    return { domain, tier: 'TIER_1_TERMINAL_PROOF', isTerminalProof: true, reason: `Akademik yayıncı + DOI (${publisher})` };
  }

  // 5. Köklü haber ajansları ve editoryal medya
  const wire = matchesDomain(domain, WIRE_AND_ESTABLISHED_MEDIA);
  if (wire) {
    return { domain, tier: 'TIER_2_WIRE_JOURNALISM', isTerminalProof: false, reason: `Köklü haber kuruluşu (${wire})` };
  }

  // 6. Sosyal medya ve kullanıcı tabanlı platformlar
  const social = matchesDomain(domain, SOCIAL_DOMAINS);
  if (social) {
    return { domain, tier: 'TIER_4_SOCIAL_UNVERIFIED', isTerminalProof: false, reason: `Sosyal medya / kullanıcı içeriği (${social})` };
  }

  return { domain, tier: 'TIER_3_SECONDARY_AGGREGATOR', isTerminalProof: false, reason: 'Listede olmayan ikincil kaynak' };
}

/** Küme temsilcisi seçerken kullanılan otorite sırası (küçük = daha güvenilir) */
export function tierRank(tier: SourceTier): number {
  switch (tier) {
    case 'TIER_1_TERMINAL_PROOF':
      return 1;
    case 'TIER_2_WIRE_JOURNALISM':
      return 2;
    case 'TIER_3_SECONDARY_AGGREGATOR':
      return 3;
    default:
      return 4;
  }
}

/** Arayüzdeki "Kaynak katmanları" sekmesi için listelerin özeti */
export function tierReference() {
  return {
    TIER_1_TERMINAL_PROOF: {
      suffixes: TERMINAL_DOMAIN_SUFFIXES,
      domains: TERMINAL_DOMAINS,
      sections: FACT_CHECK_SECTIONS.map((s) => s.domain + ' (teyit bölümü)'),
      academicWithDoi: ACADEMIC_PUBLISHERS,
    },
    TIER_2_WIRE_JOURNALISM: { domains: WIRE_AND_ESTABLISHED_MEDIA },
    TIER_3_SECONDARY_AGGREGATOR: { domains: [] as string[] },
    TIER_4_SOCIAL_UNVERIFIED: { domains: SOCIAL_DOMAINS },
  };
}
