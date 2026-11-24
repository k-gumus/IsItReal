import { applyGuardrails, type GuardedVerdict } from './guardrails.js';
import type { StructuredLLMProvider } from './providers.js';
import type { EvidenceNode, TraceResult } from './types.js';
import { sanitizeUntrusted, UNTRUSTED_NOTICE } from './sanitize.js';
import { parseDecomposition, parseJudgeVerdict, type DecomposedClaims } from './validation.js';

export { sanitizeUntrusted, UNTRUSTED_NOTICE } from './sanitize.js';

/** LLM erişilemezse kullanılacak basit cümle bölücü */
export function fallbackSplitClaims(rawInput: string, maxClaims = 3): string[] {
  const sentences = rawInput
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((s) => s.replace(/^[\s!?.]+|[\s!]+$/gu, '').trim())
    .filter((s) => s.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length >= 3 && !s.endsWith('?'));
  const unique = Array.from(new Set(sentences));
  return (unique.length > 0 ? unique : [rawInput.trim()]).slice(0, maxClaims);
}

export async function decomposeAndAnalyzeLanguage(
  llm: StructuredLLMProvider,
  rawInput: string
): Promise<DecomposedClaims> {
  const systemPrompt = `Sen bir medya okuryazarlığı ve hesaplamalı dilbilim uzmanısın.
1. Kullanıcının girdiği metindeki doğrulanabilir (olgusal) iddiaları en fazla 3 atomik cümleye ayır. Kişisel yorumları veya soruları iddia olarak alma. Her iddia tek başına, bağlamsız okunduğunda anlaşılır olmalı.
2. Metindeki manipülatif dil kalıplarını tespit et:
   - EMOTIONAL_TRIGGER: Korku, öfke veya panik tetikleyen abartılı sıfatlar
   - ANONYMOUS_AUTHORITY: "Uzmanlar uyardı", "Bilim insanları şokta" gibi isimsiz otoriteler
   - ABSOLUTE_CERTAINTY: Kanıtsız kesinlik bildiren ifadeler ("kesinleşti", "%100 kanıtlandı")
   - CHERRY_PICKING: Bağlamından koparılmış tekil istatistik
   - CLICKBAIT_GAP: Merak boşluğu yaratan tuzak başlıklar
${UNTRUSTED_NOTICE}
Sadece JSON döndür:
{
  "claims": ["string"],
  "manipulationSignals": [{ "type": "EMOTIONAL_TRIGGER | ANONYMOUS_AUTHORITY | ABSOLUTE_CERTAINTY | CHERRY_PICKING | CLICKBAIT_GAP", "excerpt": "metinden kısa alıntı", "explanation": "neden manipülatif" }]
}`;

  const raw = await llm.generateJSON(systemPrompt, `<girdi>\n${sanitizeUntrusted(rawInput, 4000)}\n</girdi>`, { task: 'decompose' });
  return parseDecomposition(raw);
}

export function formatEvidence(nodes: EvidenceNode[]): string {
  if (nodes.length === 0) return 'HİÇBİR KANIT BULUNAMADI.';
  return nodes
    .map(
      (n, idx) =>
        `[Kanıt ${idx + 1}] Tier: ${n.tier} | Kök kanıt: ${n.isTerminalProof ? 'EVET' : 'HAYIR'} | Küme: ${n.clusterId ?? '-'} | Tarih: ${n.publishedDate ?? 'Bilinmiyor'} | Domain: ${n.domain}\n` +
        `Başlık: ${sanitizeUntrusted(n.title, 200)}\nÖzet: ${sanitizeUntrusted(n.snippet)}`
    )
    .join('\n\n');
}

export interface JudgeOutcome extends GuardedVerdict {
  reasoning: string;
  lateralReadingTips: string[];
}

export async function judgeClaimWithEvidence(
  llm: StructuredLLMProvider,
  claimText: string,
  trace: TraceResult,
  currentDateISO: string
): Promise<JudgeOutcome> {
  // Kaynaklar tamamen kopya yankı odasıysa ve hiç Tier 1 kök kanıt yoksa LLM'e gitmeden işaretle
  const hasTier1 = trace.nodes.some((n) => n.tier === 'TIER_1_TERMINAL_PROOF');
  if (trace.isEchoChamber && !hasTier1) {
    return {
      verdict: 'CIRCULAR_ECHO_CHAMBER',
      confidence: 0.88,
      reasoning: `Bulunan ${trace.rawResultCount} kaynak yalnızca ${trace.uniqueClusterCount} farklı metin kümesinden oluşuyor. Siteler aynı metni birbirinden kopyalamış; arkasında resmi kurum, akademik makale veya birincil belge bulunamadı.`,
      lateralReadingTips: [
        'Haberdeki en özgün cümleyi tırnak içinde ("...") aratarak metnin ilk hangi siteden kopyalandığını kontrol et.',
        'Haberde adı geçen kurumun kendi resmi web sitesindeki duyurular bölümüne doğrudan bak.',
      ],
    };
  }

  const systemPrompt = `Sen kanıta dayalı çalışan bir Doğal Dil Çıkarımı (NLI) doğrulama yargıcısın.
Bugünün tarihi: ${currentDateISO}.

KESİN KARAR KURALLARI:
1. SUPPORTED: Yalnızca TIER_1_TERMINAL_PROOF veya birbirinden bağımsız (farklı kümelerden) en az iki TIER_2 kaynağın iddiayı doğrudan doğrulaması durumunda ver.
2. CONTRADICTED: Güvenilir kaynaklar veya teyit kuruluşları iddianın yanlış olduğunu açıkça ortaya koyuyorsa ver.
3. MISLEADING_CONTEXT: Olay veya veri gerçek ancak eski tarihli, farklı bir ülkeye ait veya çarpıtılmışsa ver.
4. OUTDATED: İddia geçmişte doğruydu ancak ${currentDateISO} itibarıyla güncel veriler değişmişse ver.
5. NOT_ENOUGH_EVIDENCE: Kök kanıt yoksa ve kaynaklar yetersizse ASLA "CONTRADICTED" veya "SUPPORTED" deme; mutlaka "NOT_ENOUGH_EVIDENCE" seç.
6. Kendi ön eğitim bilgine (parametrik hafızana) dayanarak karar verme; YALNIZCA aşağıda sunulan kanıt düğümlerini kullan.
7. Gerekçede hangi kanıt numaralarına dayandığını belirt (ör. "Kanıt 2'ye göre...").
${UNTRUSTED_NOTICE}

Sadece JSON döndür:
{
  "verdict": "SUPPORTED | CONTRADICTED | MISLEADING_CONTEXT | NOT_ENOUGH_EVIDENCE | CIRCULAR_ECHO_CHAMBER | OUTDATED",
  "confidence": 0.0-1.0 arası sayı,
  "reasoning": "Kanıtlara referans veren net Türkçe açıklama",
  "lateralReadingTips": ["Kullanıcının bu tarz bir iddiayı kendi başına doğrulaması için 2 somut arama taktiği"]
}`;

  const userPrompt =
    `İddia: "${sanitizeUntrusted(claimText, 400)}"\n` +
    `Durma nedeni: ${trace.stopReason}\n` +
    `Bağımsız kaynak kümesi sayısı: ${trace.uniqueClusterCount}\n\n` +
    `<kanitlar>\n${formatEvidence(trace.nodes)}\n</kanitlar>`;

  const judge = parseJudgeVerdict(await llm.generateJSON(systemPrompt, userPrompt, { task: 'judge' }));
  const guarded = applyGuardrails(judge, trace);
  return { ...guarded, reasoning: judge.reasoning, lateralReadingTips: judge.lateralReadingTips };
}
