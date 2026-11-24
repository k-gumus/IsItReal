import {
  CitationLineageTracer,
  StructuredLLMProvider,
  TracerConfig,
  WebSearchProvider,
} from './lineage-tracer';
import { decomposeAndAnalyzeLanguage, judgeClaimWithEvidence } from './nli-judge';
import { AtomicClaimResult, VerdictLabel, VerificationReport } from './types';

function computeLiteracyScore(
  claims: AtomicClaimResult[],
  manipulationCount: number
): number {
  if (claims.length === 0) return 50;

  const verdictWeights: Record<VerdictLabel, number> = {
    SUPPORTED: 95,
    OUTDATED: 45,
    NOT_ENOUGH_EVIDENCE: 40,
    MISLEADING_CONTEXT: 25,
    CIRCULAR_ECHO_CHAMBER: 15,
    CONTRADICTED: 5,
  };

  const avgClaimScore =
    claims.reduce((acc, c) => acc + verdictWeights[c.verdict], 0) / claims.length;

  // Manipülatif dil sinyali başına ceza puanı (en fazla 25 puan)
  const manipulationPenalty = Math.min(25, manipulationCount * 7);
  return Math.max(0, Math.min(100, Math.round(avgClaimScore - manipulationPenalty)));
}

function aggregateOverallVerdict(claims: AtomicClaimResult[]): VerdictLabel {
  if (claims.length === 0) return 'NOT_ENOUGH_EVIDENCE';
  // En riskli / çürütülmüş bulgu önceliklidir ("bir çürük elma" prensibi)
  const priority: VerdictLabel[] = [
    'CONTRADICTED',
    'MISLEADING_CONTEXT',
    'CIRCULAR_ECHO_CHAMBER',
    'OUTDATED',
    'NOT_ENOUGH_EVIDENCE',
    'SUPPORTED',
  ];
  for (const label of priority) {
    if (claims.some((c) => c.verdict === label)) return label;
  }
  return 'NOT_ENOUGH_EVIDENCE';
}

export async function verifyContent(
  rawInput: string,
  deps: {
    searchProvider: WebSearchProvider;
    llm: StructuredLLMProvider;
    tracerConfig?: TracerConfig;
  }
): Promise<VerificationReport> {
  const checkedAt = new Date().toISOString().split('T')[0];
  const tracer = new CitationLineageTracer(
    deps.searchProvider,
    deps.llm,
    deps.tracerConfig
  );

  // 1. Metni atomik iddialara böl ve dil manipülasyonlarını tara
  const { claims: atomicTexts, manipulationSignals } =
    await decomposeAndAnalyzeLanguage(deps.llm, rawInput);

  const targetClaims = atomicTexts.length > 0 ? atomicTexts : [rawInput.trim()];

  // 2. Her atomik iddia için paralel döngü-korumalı iz sürme ve NLI yargısı
  const claimResults: AtomicClaimResult[] = await Promise.all(
    targetClaims.map(async (claimText, index) => {
      const trace = await tracer.traceClaim(claimText);
      const judgment = await judgeClaimWithEvidence(
        deps.llm,
        claimText,
        trace,
        checkedAt
      );

      return {
        claimId: `claim_${index + 1}`,
        claimText,
        verdict: judgment.verdict,
        confidence: judgment.confidence,
        reasoning: judgment.reasoning,
        stopReason: trace.stopReason,
        nodes: trace.nodes,
        edges: trace.edges,
        uniqueClusterCount: trace.uniqueClusterCount,
        rawResultCount: trace.rawResultCount,
      };
    })
  );

  const allTips = Array.from(
    new Set(
      claimResults.flatMap((c) =>
        c.verdict === 'SUPPORTED'
          ? ['Birincil kaynağa ulaşıldı; yine de verinin yayın tarihini kontrol et.']
          : [
              'Duygusal sıfatları çıkarıp sadece kurum ve sayı isimleriyle arama yap.',
              'Haberdeki veriyi doğrudan ilgili kurumun sitesinde (örn. site:tuik.gov.tr) sorgula.',
            ]
      )
    )
  );

  return {
    originalInput: rawInput,
    checkedAt,
    overallVerdict: aggregateOverallVerdict(claimResults),
    literacyScore: computeLiteracyScore(claimResults, manipulationSignals.length),
    claims: claimResults,
    manipulationSignals,
    lateralReadingTips: allTips,
  };
}
