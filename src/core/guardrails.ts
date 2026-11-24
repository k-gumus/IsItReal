import type { TraceResult, VerdictLabel } from './types.js';
import type { JudgeVerdict } from './validation.js';

export interface GuardedVerdict {
  verdict: VerdictLabel;
  confidence: number;
  note?: string;
}

export interface EvidenceStrength {
  tier1: number;
  tier2: number;
  /** Farklı kopya kümelerinden gelen Tier 2 kaynak sayısı (aynı ajans metninin kopyaları tek sayılır) */
  independentTier2: number;
  lowTierOnly: boolean;
}

export function measureEvidence(trace: Pick<TraceResult, 'nodes'>): EvidenceStrength {
  const tier1 = trace.nodes.filter((n) => n.tier === 'TIER_1_TERMINAL_PROOF').length;
  const tier2Nodes = trace.nodes.filter((n) => n.tier === 'TIER_2_WIRE_JOURNALISM');
  const independentTier2 = new Set(tier2Nodes.map((n) => n.clusterId ?? n.id)).size;
  return { tier1, tier2: tier2Nodes.length, independentTier2, lowTierOnly: trace.nodes.length > 0 && tier1 === 0 && tier2Nodes.length === 0 };
}

/**
 * Dil modelinin kararını deterministik kurallarla denetler.
 * Prompt'taki kurallar (ör. "SUPPORTED için Tier 1 ya da iki bağımsız Tier 2 şart") burada KODLA zorlanır;
 * böylece modelin halüsinasyonu veya kaynak metinlere gömülü bir prompt injection sonucu değiştiremez.
 */
export function applyGuardrails(judge: JudgeVerdict, trace: TraceResult): GuardedVerdict {
  const strength = measureEvidence(trace);
  const credible = strength.tier1 > 0 || strength.tier2 > 0;
  let { verdict, confidence } = judge;
  let note: string | undefined;

  const downgrade = (reason: string) => {
    note = `Model "${verdict}" dedi ancak ${reason}; karar "NOT_ENOUGH_EVIDENCE" olarak düzeltildi.`;
    verdict = 'NOT_ENOUGH_EVIDENCE';
    confidence = Math.min(confidence, 0.5);
  };

  if (trace.nodes.length === 0 && verdict !== 'NOT_ENOUGH_EVIDENCE') {
    downgrade('hiç kanıt düğümü toplanamadı');
  } else if (verdict === 'SUPPORTED' && strength.tier1 === 0 && strength.independentTier2 < 2) {
    downgrade('ne birincil (Tier 1) kaynak ne de birbirinden bağımsız iki köklü haber kaynağı var');
  } else if ((verdict === 'CONTRADICTED' || verdict === 'MISLEADING_CONTEXT' || verdict === 'OUTDATED') && !credible) {
    downgrade('bu kararı taşıyacak güvenilir (Tier 1/Tier 2) bir kaynak yok');
  } else if (verdict === 'CIRCULAR_ECHO_CHAMBER' && !trace.isEchoChamber) {
    downgrade('kaynakların birbirini kopyaladığına dair kümeleme kanıtı yok');
  }

  // Güven tavanları: kanıt zayıfsa model ne kadar emin olursa olsun güveni sınırla
  const cap = strength.tier1 > 0 ? 1 : strength.tier2 > 0 ? 0.75 : 0.6;
  if (verdict !== 'NOT_ENOUGH_EVIDENCE' && verdict !== 'CIRCULAR_ECHO_CHAMBER' && confidence > cap) {
    confidence = cap;
    note ??= `Güven skoru, kanıt düzeyine göre ${Math.round(cap * 100)}% ile sınırlandı.`;
  }

  return { verdict, confidence, note };
}
