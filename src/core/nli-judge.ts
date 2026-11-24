import { StructuredLLMProvider } from './lineage-tracer';
import {
  AtomicClaimResult,
  EvidenceNode,
  ManipulationSignal,
  VerdictLabel,
} from './types';

interface DecomposedClaimsResponse {
  claims: string[];
  manipulationSignals: ManipulationSignal[];
}

interface JudgeVerdictResponse {
  verdict: VerdictLabel;
  confidence: number;
  reasoning: string;
  lateralReadingTips: string[];
}

export async function decomposeAndAnalyzeLanguage(
  llm: StructuredLLMProvider,
  rawInput: string
): Promise<DecomposedClaimsResponse> {
  const systemPrompt = `Sen bir medya okuryazarlığı ve hesaplamalı dilbilim uzmanısın.
1. Kullanıcının girdiği metindeki doğrulanabilir (olgusal) iddiaları en fazla 3 atomik cümleye ayır. Kişisel yorumları veya soruları iddia olarak alma.
2. Metindeki manipülatif dil kalıplarını tespit et:
   - EMOTIONAL_TRIGGER: Korku, öfke veya panik tetikleyen abartılı sıfatlar
   - ANONYMOUS_AUTHORITY: "Uzmanlar uyardı", "Bilim insanları şokta" gibi isimsiz otoriteler
   - ABSOLUTE_CERTAINTY: Kanıtsız kesinlik bildiren ifadeler ("kesinleşti", "%100 kanıtlandı")
   - CHERRY_PICKING: Bağlamından koparılmış tekil istatistik
   - CLICKBAIT_GAP: Merak boşluğu yaratan tuzak başlıklar
Sadece JSON döndür:
{
  "claims": ["string"],
  "manipulationSignals": [{ "type": "...", "excerpt": "...", "explanation": "..." }]
}`;

  return llm.generateJSON<DecomposedClaimsResponse>(systemPrompt, rawInput);
}

export async function judgeClaimWithEvidence(
  llm: StructuredLLMProvider,
  claimText: string,
  traceResult: {
    nodes: EvidenceNode[];
    stopReason: AtomicClaimResult['stopReason'];
    uniqueClusterCount: number;
    rawResultCount: number;
    isEchoChamber: boolean;
  },
  currentDateISO: string
): Promise<JudgeVerdictResponse> {
  // Eğer kaynaklar tamamen kopya yankı odasıysa ve hiç TIER_1 kök kanıt yoksa doğrudan işaretle
  const hasTier1 = traceResult.nodes.some((n) => n.tier === 'TIER_1_TERMINAL_PROOF');
  if (traceResult.isEchoChamber && !hasTier1) {
    return {
      verdict: 'CIRCULAR_ECHO_CHAMBER',
      confidence: 0.88,
      reasoning: `Bulunan ${traceResult.rawResultCount} kaynağın tamamı yalnızca ${traceResult.uniqueClusterCount} farklı metin kümesinden oluşuyor. Siteler aynı metni birbirinden kopyalamış; arkasında resmi kurum, akademik makale veya birincil belge bulunamadı.`,
      lateralReadingTips: [
        'Haberdeki en özgün cümleyi tırnak içinde ("...") aratarak metnin ilk hangi siteden kopyalandığını kontrol et.',
        'Haberde adı geçen kurumun kendi resmi web sitesindeki duyurular bölümüne doğrudan bak.',
      ],
    };
  }

  const evidenceBlock =
    traceResult.nodes.length === 0
      ? 'HİÇBİR KANIT BULUNAMADI.'
      : traceResult.nodes
          .map(
            (n, idx) =>
              `[Kanıt ${idx + 1}] Tier: ${n.tier} | Kök Kanıt mı: ${n.isTerminalProof ? 'EVET' : 'HAYIR'} | Tarih: ${n.publishedDate ?? 'Bilinmiyor'} | Domain: ${n.domain}\nBaşlık: ${n.title}\nÖzet: ${n.snippet}`
          )
          .join('\n\n');

  const systemPrompt = `Sen kanıta dayalı çalışan bir Doğal Dil Çıkarımı (NLI) doğrulama yargıcısın.
Bugünün tarihi: ${currentDateISO}.

KESİN KARAR KURALLARI:
1. SUPPORTED: Yalnızca TIER_1_TERMINAL_PROOF veya birbirinden bağımsız en az iki TIER_2 kaynağın iddiayı doğrudan doğrulaması durumunda ver.
2. CONTRADICTED: Güvenilir kaynaklar veya teyit kuruluşları iddianın yanlış olduğunu açıkça ortaya koyuyorsa ver.
3. MISLEADING_CONTEXT: Olay veya veri gerçek ancak eski tarihli, farklı bir ülkeye ait veya çarpıtılmışsa ver.
4. OUTDATED: İddia geçmişte doğruydu ancak ${currentDateISO} itibarıyla güncel veriler değişmişse ver.
5. NOT_ENOUGH_EVIDENCE: Kök kanıt yoksa ve kaynaklar yetersizse ASLA "CONTRADICTED" veya "SUPPORTED" deme; mutlaka "NOT_ENOUGH_EVIDENCE" seç.
6. Kendi ön eğitim bilgine (parametrik hafızana) dayanarak karar verme; YALNIZCA aşağıda sunulan kanıt düğümlerini kullan.

Sadece JSON döndür:
{
  "verdict": "SUPPORTED | CONTRADICTED | MISLEADING_CONTEXT | NOT_ENOUGH_EVIDENCE | CIRCULAR_ECHO_CHAMBER | OUTDATED",
  "confidence": number,
  "reasoning": "Kanıtlara referans veren net Türkçe açıklama",
  "lateralReadingTips": ["Kullanıcının bu tarz bir iddiayı kendi başına doğrulaması için 2 somut arama taktiği"]
}`;

  return llm.generateJSON<JudgeVerdictResponse>(
    systemPrompt,
    `İddia: "${claimText}"\nDurma Nedeni: ${traceResult.stopReason}\nBağımsız Kaynak Kümesi Sayısı: ${traceResult.uniqueClusterCount}\n\nToplanan Kanıt Düğümleri:\n${evidenceBlock}`
  );
}
