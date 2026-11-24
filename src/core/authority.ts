import { SourceTier } from './types';

const TERMINAL_DOMAIN_SUFFIXES = [
  '.gov.tr',
  '.edu.tr',
  '.bel.tr',
  '.gov',
  '.edu',
  '.mil',
  '.int',
];

const TERMINAL_EXACT_DOMAINS = new Set([
  // Türkiye Birincil Resmi & Veri Kaynakları
  'resmigazete.gov.tr',
  'tuik.gov.tr',
  'tcmb.gov.tr',
  'tbmm.gov.tr',
  'anayasa.gov.tr',
  'yargitay.gov.tr',
  'kap.org.tr',
  'iletisim.gov.tr',
  // Akademik & Hakemli Yayın İndeksleri
  'doi.org',
  'pubmed.ncbi.nlm.nih.gov',
  'arxiv.org',
  'scholar.google.com',
  'nature.com',
  'science.org',
  'thelancet.com',
  'who.int',
  'worldbank.org',
  'oecd.org',
  // IFCN İmzacısı Teyit Kuruluşları (Metodolojik kök kanıt kestirmesi)
  'teyit.org',
  'dogrulukpayi.com',
  'malumatfurus.org',
  'reuters.com',
  'apnews.com',
  'afp.com',
  'fullfact.org',
  'snopes.com',
  'politifact.com',
]);

const WIRE_AND_ESTABLISHED_MEDIA = new Set([
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
]);

const SOCIAL_DOMAINS = new Set([
  'x.com',
  'twitter.com',
  'instagram.com',
  'tiktok.com',
  'facebook.com',
  'reddit.com',
  'youtube.com',
  't.me',
  'eksisozluk.com',
]);

export function extractDomain(rawUrl: string): string {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function classifySource(rawUrl: string, snippet = ''): {
  domain: string;
  tier: SourceTier;
  isTerminalProof: boolean;
} {
  const domain = extractDomain(rawUrl);

  if (!domain) {
    return { domain: 'unknown', tier: 'TIER_4_SOCIAL_UNVERIFIED', isTerminalProof: false };
  }

  // 1. Tam eşleşen resmi, akademik veya IFCN teyit domainleri
  if (TERMINAL_EXACT_DOMAINS.has(domain)) {
    return { domain, tier: 'TIER_1_TERMINAL_PROOF', isTerminalProof: true };
  }

  // 2. Resmi kurum uzantıları (.gov.tr, .edu.tr vb.)
  if (TERMINAL_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix))) {
    return { domain, tier: 'TIER_1_TERMINAL_PROOF', isTerminalProof: true };
  }

  // 3. Metin içinde doğrudan DOI veya Resmi Gazete karar numarası barındıran akademik sayfalar
  const hasDoiReference = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i.test(snippet);
  if (hasDoiReference && (domain.includes('wiley') || domain.includes('springer') || domain.includes('sciencedirect') || domain.includes('ieee'))) {
    return { domain, tier: 'TIER_1_TERMINAL_PROOF', isTerminalProof: true };
  }

  // 4. Köklü haber ajansları ve editoryal medya
  if (WIRE_AND_ESTABLISHED_MEDIA.has(domain)) {
    return { domain, tier: 'TIER_2_WIRE_JOURNALISM', isTerminalProof: false };
  }

  // 5. Sosyal medya ve kullanıcı tabanlı platformlar
  if (SOCIAL_DOMAINS.has(domain)) {
    return { domain, tier: 'TIER_4_SOCIAL_UNVERIFIED', isTerminalProof: false };
  }

  return { domain, tier: 'TIER_3_SECONDARY_AGGREGATOR', isTerminalProof: false };
}
