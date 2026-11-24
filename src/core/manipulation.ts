import type { ManipulationSignal, ManipulationType } from './types.js';

/**
 * Dil modelinden bağımsız, deterministik manipülasyon dili tespiti.
 * LLM çökse ya da yanlış yanıt verse bile kullanıcı bu sinyalleri görür;
 * LLM'in bulduklarıyla birleştirilir.
 *
 * Not: JavaScript'te `\b` yalnızca ASCII harfleri tanır ("şok" gibi kelimelerde çalışmaz),
 * bu yüzden Unicode harf sınırları için lookaround kullanılır ve metin tr-TR küçük harfe çevrilir
 * ("BİLİM" → "bilim", "IŞIK" → "ışık").
 */
interface Rule {
  type: ManipulationType;
  pattern: RegExp;
  explanation: string;
  /** true ise orijinal (büyük/küçük harf korunmuş) metin üzerinde aranır */
  caseSensitive?: boolean;
  /** Eşleşmenin geçtiği cümle bu kalıba uyuyorsa sinyal üretme (ör. "TÜİK verisine göre %31") */
  unlessSentenceMatches?: RegExp;
}

function sentenceAt(text: string, index: number): string {
  const before = text.slice(0, index).search(/[^.!?\n]*$/u);
  const afterRel = text.slice(index).search(/[.!?\n]/u);
  return text.slice(before, afterRel === -1 ? text.length : index + afterRel);
}

const word = (source: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`, 'u');

const RULES: Rule[] = [
  // İsimsiz otorite
  {
    type: 'ANONYMOUS_AUTHORITY',
    pattern: word('(uzmanlar|bilim insanları|bilim adamları|doktorlar|akademisyenler|yetkililer|araştırmacılar) (uyardı|uyarıyor|açıkladı|şokta|şaşkın|isyan etti|endişeli|doğruladı|biliyor|saklıyor|gizliyor)'),
    explanation: 'Kim olduğu belirtilmeyen bir otoriteye dayanıyor; isim, kurum veya belge yok.',
  },
  {
    type: 'ANONYMOUS_AUTHORITY',
    pattern: word('kulis(lere|te|lerde)?|kaynaklara göre|iddialara göre|duyumlara göre|edinilen bilgiye göre|konuşuluyor'),
    explanation: 'Kaynağı belirsiz duyum dili; doğrulanabilir bir dayanak göstermiyor.',
  },
  {
    type: 'ANONYMOUS_AUTHORITY',
    pattern: word('experts (warn|say)|scientists (are )?(shocked|warn)|sources say'),
    explanation: 'Unnamed authority: no person, institution or document cited.',
  },
  // Mutlak kesinlik
  {
    type: 'ABSOLUTE_CERTAINTY',
    pattern: word('kesinleşti|kesin olarak|kesinlikle|yüzde yüz|tartışmasız|kanıtlandı|garantili|herkes biliyor|%\\s?100'),
    explanation: 'Kanıt göstermeden mutlak kesinlik iddia ediyor.',
  },
  // Duygusal tetikleyici
  {
    type: 'EMOTIONAL_TRIGGER',
    pattern: word('şok(e| edici)?|dehşet|korkunç|felaket|skandal|panik|kan donduran|tüyler ürperten|vahim|kıyamet|alarm'),
    explanation: 'Korku veya öfke uyandıran yüklü sözcükler eleştirel düşünmeyi zayıflatır.',
  },
  {
    type: 'EMOTIONAL_TRIGGER',
    pattern: /!{2,}|(?<![\p{L}])\p{Lu}{4,}(?:\s+\p{Lu}{3,})+(?![\p{L}])/u,
    explanation: 'Art arda ünlem veya büyük harfli "bağırma" dili aciliyet hissi yaratır.',
    caseSensitive: true,
  },
  // Merak boşluğu / tık tuzağı
  {
    type: 'CLICKBAIT_GAP',
    pattern: word('bakın ne (oldu|çıktı)|kimse bilmiyor|öğrenince şok|inanamayacaksınız|işte o (an|isim|detay)|silinmeden (izle|oku|paylaş)|herkese paylaş|yasaklanmadan|kaldırılmadan (izle|oku)'),
    explanation: 'Merak boşluğu veya paylaşma baskısı yaratan tık tuzağı kalıbı.',
  },
  // Seçici veri: kaynaksız, tabanı belirsiz bir değişim yüzdesi ("fiyatlar %40 arttı")
  {
    type: 'CHERRY_PICKING',
    pattern: /(?:%\s?\d+(?:[.,]\d+)?|yüzde \d+(?:[.,]\d+)?)[^.!?]{0,40}?(?<![\p{L}])(arttı|azaldı|düştü|yükseldi|patladı|çakıldı|eridi|katlandı|zamlandı)(?![\p{L}])/u,
    explanation: 'Kaynağı veya karşılaştırma tabanı belirtilmeyen bir değişim yüzdesi; neye göre ve hangi dönemde olduğunu kontrol edin.',
    unlessSentenceMatches: /göre|kaynak|verisi|verilerine|raporu|bülteni|açıkladı|açıklandı|açıklamasına|araştırması/u,
  },
];

/** Eşleşmenin çevresinden, kelime ortasından kesmeden kısa bir alıntı üretir. */
export function excerptAround(text: string, index: number, length: number, pad = 28): string {
  let start = Math.max(0, index - pad);
  let end = Math.min(text.length, index + length + pad);
  if (start > 0) {
    const space = text.indexOf(' ', start);
    start = space !== -1 && space < index ? space + 1 : index;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(' ', end);
    end = space > index + length ? space : index + length;
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

export function detectManipulationHeuristics(text: string): ManipulationSignal[] {
  const lowered = text.toLocaleLowerCase('tr-TR');
  // tr-TR küçük harf dönüşümü Türkçe için uzunluğu korur; korunmazsa indeksler yerine orijinali kullanırız
  const sameLength = lowered.length === text.length;
  const signals: ManipulationSignal[] = [];
  const seenTypes = new Set<ManipulationType>();

  for (const rule of RULES) {
    if (seenTypes.has(rule.type)) continue; // Aynı türden en fazla bir sezgisel sinyal
    const haystack = rule.caseSensitive || !sameLength ? text : lowered;
    const match = rule.pattern.exec(haystack);
    if (!match) continue;
    if (rule.unlessSentenceMatches?.test(sentenceAt(haystack, match.index))) continue;
    seenTypes.add(rule.type);
    signals.push({
      type: rule.type,
      // Tam eşleşen ifade: arayüz bunu metin içinde birebir işaretler
      excerpt: text.slice(match.index, match.index + match[0].length).trim(),
      explanation: rule.explanation,
      source: 'heuristic',
    });
  }
  return signals;
}

/** LLM ve sezgisel sinyalleri birleştirir; aynı türde LLM'in daha bağlamsal açıklaması önceliklidir. */
export function mergeSignals(llm: ManipulationSignal[], heuristic: ManipulationSignal[]): ManipulationSignal[] {
  const llmTypes = new Set(llm.map((s) => s.type));
  return [...llm.map((s) => ({ ...s, source: 'llm' as const })), ...heuristic.filter((s) => !llmTypes.has(s.type))];
}
