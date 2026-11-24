import {
  MANIPULATION_TYPES,
  VERDICT_LABELS,
  type ManipulationSignal,
  type ManipulationType,
  type VerdictLabel,
} from './types.js';

/**
 * LLM çıktısı güvenilmez veridir: alan eksik olabilir, tür yanlış olabilir, enum dışına çıkabilir.
 * Bu fonksiyonlar her zaman güvenli, tipe uygun bir değer döndürür ve asla fırlatmaz.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function asString(v: unknown, fallback = '', maxLength = 2000): string {
  if (typeof v !== 'string') return fallback;
  const trimmed = v.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

export function asStringArray(v: unknown, maxItems = 10, maxLength = 500): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item) => asString(item, '', maxLength))
    .filter((s) => s.length > 0)
    .slice(0, maxItems);
}

export function clampConfidence(v: unknown, fallback = 0.5): number {
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  // Bazı modeller 0-100 ölçeğinde döner
  const scaled = n > 1 && n <= 100 ? n / 100 : n;
  return Math.min(1, Math.max(0, Math.round(scaled * 100) / 100));
}

export function asVerdict(v: unknown): VerdictLabel {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return (VERDICT_LABELS as readonly string[]).includes(s) ? (s as VerdictLabel) : 'NOT_ENOUGH_EVIDENCE';
}

export interface DecomposedClaims {
  claims: string[];
  manipulationSignals: ManipulationSignal[];
}

export function parseDecomposition(raw: unknown, maxClaims = 3): DecomposedClaims {
  const obj = isRecord(raw) ? raw : {};
  const seen = new Set<string>();
  const claims = asStringArray(obj.claims, 10, 400).filter((c) => {
    const key = c.toLocaleLowerCase('tr-TR');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const signals: ManipulationSignal[] = [];
  if (Array.isArray(obj.manipulationSignals)) {
    for (const item of obj.manipulationSignals) {
      if (!isRecord(item)) continue;
      const type = asString(item.type).toUpperCase();
      if (!(MANIPULATION_TYPES as readonly string[]).includes(type)) continue;
      const excerpt = asString(item.excerpt, '', 300);
      const explanation = asString(item.explanation, '', 500);
      if (!excerpt && !explanation) continue;
      signals.push({ type: type as ManipulationType, excerpt, explanation });
    }
  }

  return { claims: claims.slice(0, maxClaims), manipulationSignals: signals.slice(0, 8) };
}

export interface PointerExtraction {
  hasPrimaryPointer: boolean;
  citedEntityOrDocument: string | null;
  targetedPrimaryQuery: string | null;
  /** İşaretçinin bulunduğu kaynağın 1 tabanlı sırası (soy ağacı kenarı için) */
  sourceIndex: number | null;
}

export function parsePointer(raw: unknown, sourceCount: number): PointerExtraction {
  const obj = isRecord(raw) ? raw : {};
  const query = asString(obj.targetedPrimaryQuery, '', 300);
  const entity = asString(obj.citedEntityOrDocument, '', 300);
  const has = obj.hasPrimaryPointer === true && query.length > 0;
  const idx = typeof obj.sourceIndex === 'number' && Number.isInteger(obj.sourceIndex) ? obj.sourceIndex : null;
  return {
    hasPrimaryPointer: has,
    citedEntityOrDocument: has ? entity || null : null,
    targetedPrimaryQuery: has ? query : null,
    sourceIndex: idx !== null && idx >= 1 && idx <= sourceCount ? idx : null,
  };
}

export interface JudgeVerdict {
  verdict: VerdictLabel;
  confidence: number;
  reasoning: string;
  lateralReadingTips: string[];
}

export function parseJudgeVerdict(raw: unknown): JudgeVerdict {
  const obj = isRecord(raw) ? raw : {};
  return {
    verdict: asVerdict(obj.verdict),
    confidence: clampConfidence(obj.confidence),
    reasoning: asString(obj.reasoning, 'Model gerekçe döndürmedi.', 1500),
    lateralReadingTips: asStringArray(obj.lateralReadingTips, 4, 300),
  };
}

/** Modelin ```json ... ``` çiti veya ön/arka metinle döndürdüğü JSON'u ayıklar. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // devam
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // devam
    }
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }
  throw new SyntaxError('Model yanıtında geçerli JSON bulunamadı.');
}
