/**
 * Kullanıcı girdisinin türünü belirler: tek başına bir DOI, tek başına bir bağlantı ya da serbest metin.
 * PDF ayrı bir uçtan yüklenir.
 */

export type InputKind = 'text' | 'url' | 'doi' | 'pdf';

export type ClassifiedInput =
  | { kind: 'text'; text: string }
  | { kind: 'url'; url: string }
  | { kind: 'doi'; doi: string };

/** DOI sözdizimi: 10.<kayıt öneki>/<sonek>. Sonek neredeyse her karakteri içerebilir. */
const DOI_CORE = String.raw`10\.\d{4,9}/[^\s"'<>]+`;
const DOI_ONLY = new RegExp(String.raw`^(?:doi:\s*|https?://(?:dx\.)?doi\.org/)?(${DOI_CORE})$`, 'i');
const DOI_ANYWHERE = new RegExp(String.raw`(?:doi:\s*|https?://(?:dx\.)?doi\.org/)?(${DOI_CORE})`, 'gi');

/** Cümle sonundaki noktalama ve kapanan parantezler DOI'nin parçası değildir. */
export function cleanDoi(raw: string): string {
  let doi = raw.trim().replace(/[.,;:]+$/, '');
  // Dengesiz kapanış parantezi/köşeli parantezi at: "(bkz. 10.1000/xyz)" gibi
  while (/[)\]}]$/.test(doi)) {
    const close = doi.at(-1)!;
    const open = close === ')' ? '(' : close === ']' ? '[' : '{';
    if (doi.split(open).length >= doi.split(close).length) break;
    doi = doi.slice(0, -1);
  }
  try {
    doi = decodeURIComponent(doi);
  } catch {
    // olduğu gibi bırak
  }
  return doi.toLowerCase(); // DOI'ler büyük/küçük harf duyarsızdır
}

export function extractDois(text: string, max = 50): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(DOI_ANYWHERE)) {
    if (match[1]) found.add(cleanDoi(match[1]));
    if (found.size >= max) break;
  }
  return [...found];
}

/** Kaynakça satırları iddia değildir: DOI'leri ve kalan "Kaynak:" gibi etiketleri metinden çıkarır. */
export function stripDois(text: string): string {
  return cutReferences(text)
    .replace(DOI_ANYWHERE, ' ')
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, ' ')
    .replace(/(?<![\p{L}])(kaynak(ça|lar)?|references?|doi)\s*:?\s*(ve|and|,|;|\s)*(?=[.\n]|$)/giu, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
}

/** Belgedeki "Kaynakça / References" bölümünü ve sonrasını atar: kaynakça iddia değildir. */
export function cutReferences(text: string): string {
  const m = /(?:^|\n)\s*(?:\d+\.?\s*)?(references|reference list|bibliography|works cited|kaynakça|kaynaklar|yararlanılan kaynaklar)\s*:?\s*(?:\n|$)/iu.exec(text);
  return m && m.index > 0 ? text.slice(0, m.index) : text;
}

export function classifyInput(raw: string): ClassifiedInput {
  const text = raw.trim();
  const doi = DOI_ONLY.exec(text);
  if (doi?.[1]) return { kind: 'doi', doi: cleanDoi(doi[1]) };

  if (!/\s/.test(text)) {
    try {
      const url = new URL(text);
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.')) return { kind: 'url', url: url.href };
    } catch {
      // URL değil
    }
  }
  return { kind: 'text', text };
}

/**
 * Uzun belgelerden doğrulama için en bilgilendirici kısmı seçer:
 * "Özet/Abstract" bölümü varsa oradan, yoksa baştan başlar.
 */
export function pickAnalysisWindow(text: string, maxLength = 3500): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const marker = /(?<![\p{L}])(özet|abstract|öz)(?![\p{L}])/iu.exec(normalized);
  const start = marker && marker.index < normalized.length * 0.5 ? marker.index : 0;
  const slice = normalized.slice(start, start + maxLength);
  // Son yarım cümleyi at
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
  return lastStop > maxLength * 0.5 ? slice.slice(0, lastStop + 1) : slice;
}
