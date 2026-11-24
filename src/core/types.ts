export type SourceTier =
  | 'TIER_1_TERMINAL_PROOF' // Resmi kurumlar (.gov, TÜİK, Resmi Gazete), hakemli yayınlar (DOI), IFCN teyit siteleri
  | 'TIER_2_WIRE_JOURNALISM' // Birincil muhabirlik yapan köklü haber ajansları ve editoryal medya
  | 'TIER_3_SECONDARY_AGGREGATOR' // Ajans kopyalayan portallar, bloglar, doğrulanmamış siteler
  | 'TIER_4_SOCIAL_UNVERIFIED'; // Sosyal medya gönderileri, forumlar, anonim sayfalar

export const SOURCE_TIERS: readonly SourceTier[] = [
  'TIER_1_TERMINAL_PROOF',
  'TIER_2_WIRE_JOURNALISM',
  'TIER_3_SECONDARY_AGGREGATOR',
  'TIER_4_SOCIAL_UNVERIFIED',
];

export type VerdictLabel =
  | 'SUPPORTED' // Birincil/kök kanıtlarla doğrulandı
  | 'CONTRADICTED' // Güvenilir kanıtlar iddiayı doğrudan çürütüyor
  | 'MISLEADING_CONTEXT' // Veri veya görsel gerçek ama bağlamından koparılmış/çarpıtılmış
  | 'NOT_ENOUGH_EVIDENCE' // Kök kanıta ulaşılamadı (çıkmaz sokak)
  | 'CIRCULAR_ECHO_CHAMBER' // Kaynaklar birbirini kopyalıyor, birincil dayanak yok
  | 'OUTDATED'; // Geçmişte doğruydu ancak güncel verilere göre geçerliliğini yitirdi

export const VERDICT_LABELS: readonly VerdictLabel[] = [
  'SUPPORTED',
  'CONTRADICTED',
  'MISLEADING_CONTEXT',
  'NOT_ENOUGH_EVIDENCE',
  'CIRCULAR_ECHO_CHAMBER',
  'OUTDATED',
];

export type ManipulationType =
  | 'EMOTIONAL_TRIGGER'
  | 'ANONYMOUS_AUTHORITY'
  | 'ABSOLUTE_CERTAINTY'
  | 'CHERRY_PICKING'
  | 'CLICKBAIT_GAP';

export const MANIPULATION_TYPES: readonly ManipulationType[] = [
  'EMOTIONAL_TRIGGER',
  'ANONYMOUS_AUTHORITY',
  'ABSOLUTE_CERTAINTY',
  'CHERRY_PICKING',
  'CLICKBAIT_GAP',
];

export interface ManipulationSignal {
  type: ManipulationType;
  excerpt: string;
  explanation: string;
  /** Sinyali kim üretti: deterministik kural motoru mu, dil modeli mi? */
  source?: 'heuristic' | 'llm';
}

export interface EvidenceNode {
  id: string;
  url: string;
  domain: string;
  title: string;
  snippet: string;
  publishedDate?: string;
  tier: SourceTier;
  isTerminalProof: boolean;
  hopDepth: number;
  clusterId?: string; // Aynı kopya metin kümesine ait kaynakları gruplar
  isClusterRepresentative?: boolean; // Kümedeki en yüksek otoriteli düğüm
  citationPointer?: string | null; // Metnin içinde atıf yapılan birincil belge/kurum ipucu
  origin?: 'factcheck' | 'search';
}

export interface CitationEdge {
  fromNodeId: string;
  toNodeId: string;
  relation: 'CITES_PRIMARY' | 'SYNDICATED_COPY' | 'REFUTES' | 'SUPPORTS';
}

export type StopReason =
  | 'TERMINAL_PROOF_REACHED'
  | 'IFCN_FACTCHECK_MATCH'
  | 'MAX_DEPTH_EXCEEDED'
  | 'CYCLE_DETECTED'
  | 'NO_CITATION_POINTER'
  | 'NO_RESULTS';

export interface TraceResult {
  nodes: EvidenceNode[];
  edges: CitationEdge[];
  stopReason: StopReason;
  uniqueClusterCount: number;
  rawResultCount: number;
  isEchoChamber: boolean;
  warnings: string[];
}

export interface AtomicClaimResult {
  claimId: string;
  claimText: string;
  verdict: VerdictLabel;
  confidence: number; // 0.0 - 1.0 arası kalibre edilmiş güven skoru
  reasoning: string;
  stopReason: StopReason;
  nodes: EvidenceNode[];
  edges: CitationEdge[];
  uniqueClusterCount: number; // Kopyalar elendikten sonra kalan bağımsız kaynak sayısı
  rawResultCount: number;
  isEchoChamber: boolean;
  /** Deterministik korkuluklar LLM kararını değiştirdiyse nedeni */
  guardrailNote?: string;
  lateralReadingTips: string[];
  warnings: string[];
}

export interface VerificationReport {
  originalInput: string;
  checkedAt: string;
  overallVerdict: VerdictLabel;
  literacyScore: number; // 0 - 100 arası içerik güvenilirlik / şeffaflık puanı
  claims: AtomicClaimResult[];
  manipulationSignals: ManipulationSignal[];
  lateralReadingTips: string[]; // Kullanıcıya "bunu kendin nasıl doğrularsın?" rehberi
  warnings: string[];
  durationMs: number;
  mode: 'live' | 'demo';
}

/** Arayüze canlı ilerleme aktarmak için olaylar */
export type ProgressEvent =
  | { type: 'stage'; stage: 'decompose' | 'trace' | 'judge' | 'done'; message: string }
  | { type: 'claims'; claims: { claimId: string; claimText: string }[] }
  | { type: 'search'; claimId: string; hop: number; query: string }
  | { type: 'evidence'; claimId: string; node: EvidenceNode }
  | { type: 'pointer'; claimId: string; hop: number; pointer: string }
  | { type: 'claim-done'; claimId: string; verdict: VerdictLabel; confidence: number };

export type ProgressListener = (event: ProgressEvent) => void;
