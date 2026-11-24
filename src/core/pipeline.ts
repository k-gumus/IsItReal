import { CitationLineageTracer, type TracerConfig } from './lineage-tracer.js';
import { detectManipulationHeuristics, mergeSignals } from './manipulation.js';
import { decomposeAndAnalyzeLanguage, fallbackSplitClaims, judgeClaimWithEvidence } from './nli-judge.js';
import type { FactCheckProvider, StructuredLLMProvider, WebSearchProvider } from './providers.js';
import type { AtomicClaimResult, ProgressListener, TraceResult, VerdictLabel, VerificationReport } from './types.js';

export const INPUT_LIMITS = { minLength: 10, maxLength: 4000 } as const;

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

export interface VerifyDeps {
  searchProvider: WebSearchProvider;
  llm: StructuredLLMProvider;
  factCheckProvider?: FactCheckProvider;
  tracerConfig?: TracerConfig;
  onProgress?: ProgressListener;
  mode?: 'live' | 'demo';
  /** Testlerde sabit tarih vermek için */
  now?: () => Date;
}

const VERDICT_WEIGHTS: Record<VerdictLabel, number> = {
  SUPPORTED: 95,
  OUTDATED: 45,
  NOT_ENOUGH_EVIDENCE: 40,
  MISLEADING_CONTEXT: 25,
  CIRCULAR_ECHO_CHAMBER: 15,
  CONTRADICTED: 5,
};

export function computeLiteracyScore(claims: Pick<AtomicClaimResult, 'verdict'>[], manipulationCount: number): number {
  if (claims.length === 0) return 50;
  const avgClaimScore = claims.reduce((acc, c) => acc + VERDICT_WEIGHTS[c.verdict], 0) / claims.length;
  // Manipülatif dil sinyali başına ceza puanı (en fazla 25 puan)
  const manipulationPenalty = Math.min(25, manipulationCount * 7);
  return Math.max(0, Math.min(100, Math.round(avgClaimScore - manipulationPenalty)));
}

/** En riskli / çürütülmüş bulgu önceliklidir ("bir çürük elma" prensibi) */
export function aggregateOverallVerdict(claims: Pick<AtomicClaimResult, 'verdict'>[]): VerdictLabel {
  const priority: VerdictLabel[] = ['CONTRADICTED', 'MISLEADING_CONTEXT', 'CIRCULAR_ECHO_CHAMBER', 'OUTDATED', 'NOT_ENOUGH_EVIDENCE', 'SUPPORTED'];
  return priority.find((label) => claims.some((c) => c.verdict === label)) ?? 'NOT_ENOUGH_EVIDENCE';
}

export function validateInput(rawInput: unknown): string {
  if (typeof rawInput !== 'string') throw new InputError('Metin girilmedi.');
  const text = rawInput.replace(/\u0000/g, '').trim();
  if (text.length < INPUT_LIMITS.minLength) throw new InputError(`Metin en az ${INPUT_LIMITS.minLength} karakter olmalı.`);
  if (text.length > INPUT_LIMITS.maxLength) throw new InputError(`Metin en fazla ${INPUT_LIMITS.maxLength} karakter olabilir.`);
  return text;
}

/** Uzun metni kelime sınırından kısaltır */
export function shorten(text: string, max = 60): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

const GENERIC_TIPS = {
  supported: 'Birincil kaynağa ulaşıldı; yine de verinin yayın tarihini ve kapsamını kontrol et.',
  other: [
    'Duygusal sıfatları çıkarıp sadece kurum ve sayı isimleriyle arama yap.',
    'Haberdeki veriyi doğrudan ilgili kurumun sitesinde (örn. site:tuik.gov.tr) sorgula.',
  ],
};

export async function verifyContent(rawInput: string, deps: VerifyDeps): Promise<VerificationReport> {
  const started = Date.now();
  const input = validateInput(rawInput);
  const now = deps.now?.() ?? new Date();
  const checkedAt = now.toISOString().split('T')[0]!;
  const emit = deps.onProgress ?? (() => {});
  const warnings: string[] = [];
  const tracer = new CitationLineageTracer(deps.searchProvider, deps.llm, deps.tracerConfig, deps.factCheckProvider);

  // 1. Metni atomik iddialara böl ve dil manipülasyonlarını tara
  emit({ type: 'stage', stage: 'decompose', message: 'Metin doğrulanabilir iddialara ayrılıyor' });
  const heuristicSignals = detectManipulationHeuristics(input);
  let claimTexts: string[];
  let llmSignals: VerificationReport['manipulationSignals'] = [];
  try {
    const decomposition = await decomposeAndAnalyzeLanguage(deps.llm, input);
    claimTexts = decomposition.claims;
    llmSignals = decomposition.manipulationSignals;
  } catch (err) {
    warnings.push(`İddia ayrıştırma modeli yanıt vermedi, basit cümle bölücü kullanıldı: ${(err as Error).message}`);
    claimTexts = [];
  }
  if (claimTexts.length === 0) claimTexts = fallbackSplitClaims(input);
  const manipulationSignals = mergeSignals(llmSignals, heuristicSignals);

  const claimRefs = claimTexts.map((claimText, i) => ({ claimId: `claim_${i + 1}`, claimText }));
  emit({ type: 'claims', claims: claimRefs });

  // 2. Her atomik iddia için paralel, döngü korumalı iz sürme ve NLI yargısı.
  //    Bir iddiadaki hata diğerlerini düşürmez.
  emit({ type: 'stage', stage: 'trace', message: 'Kaynaklar taranıyor ve kök kanıt izi sürülüyor' });
  const claims = await Promise.all(
    claimRefs.map(async ({ claimId, claimText }): Promise<AtomicClaimResult> => {
      let trace: TraceResult;
      try {
        trace = await tracer.traceClaim(claimText, { claimId, onProgress: emit });
      } catch (err) {
        trace = { nodes: [], edges: [], stopReason: 'NO_RESULTS', uniqueClusterCount: 0, rawResultCount: 0, isEchoChamber: false, warnings: [`İz sürme başarısız: ${(err as Error).message}`] };
      }

      emit({ type: 'stage', stage: 'judge', message: `Kanıtlar tartılıyor: “${shorten(claimText)}”` });
      let verdict: VerdictLabel = 'NOT_ENOUGH_EVIDENCE';
      let confidence = 0.3;
      let reasoning = 'Yargı modeli yanıt veremedi; toplanan kanıtları aşağıdan kendin inceleyebilirsin.';
      let tips: string[] = [];
      let guardrailNote: string | undefined;
      try {
        const outcome = await judgeClaimWithEvidence(deps.llm, claimText, trace, checkedAt);
        ({ verdict, confidence, reasoning } = outcome);
        tips = outcome.lateralReadingTips;
        guardrailNote = outcome.note;
      } catch (err) {
        trace.warnings.push(`Yargı adımı başarısız: ${(err as Error).message}`);
      }

      emit({ type: 'claim-done', claimId, verdict, confidence });
      return {
        claimId,
        claimText,
        verdict,
        confidence,
        reasoning,
        stopReason: trace.stopReason,
        nodes: trace.nodes,
        edges: trace.edges,
        uniqueClusterCount: trace.uniqueClusterCount,
        rawResultCount: trace.rawResultCount,
        isEchoChamber: trace.isEchoChamber,
        guardrailNote,
        lateralReadingTips: tips,
        warnings: trace.warnings,
      };
    })
  );

  const tips = new Set<string>();
  for (const c of claims) {
    c.lateralReadingTips.forEach((t) => tips.add(t));
    if (c.verdict === 'SUPPORTED') tips.add(GENERIC_TIPS.supported);
    else GENERIC_TIPS.other.forEach((t) => tips.add(t));
  }
  claims.forEach((c) => warnings.push(...c.warnings));

  emit({ type: 'stage', stage: 'done', message: 'Rapor hazır' });
  return {
    originalInput: input,
    checkedAt,
    overallVerdict: aggregateOverallVerdict(claims),
    literacyScore: computeLiteracyScore(claims, manipulationSignals.length),
    claims,
    manipulationSignals,
    lateralReadingTips: [...tips].slice(0, 8),
    warnings: [...new Set(warnings)],
    durationMs: Date.now() - started,
    mode: deps.mode ?? 'live',
  };
}
