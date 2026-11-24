export type SourceTier =
  | 'TIER_1_TERMINAL_PROOF' // Resmi kurumlar (.gov, TÜİK, Resmi Gazete), hakemli yayınlar (DOI), IFCN teyit siteleri
  | 'TIER_2_WIRE_JOURNALISM' // Birincil muhabirlik yapan köklü haber ajansları ve editoryal medya
  | 'TIER_3_SECONDARY_AGGREGATOR' // Ajans kopyalayan portallar, bloglar, doğrulanmamış siteler
  | 'TIER_4_SOCIAL_UNVERIFIED'; // Sosyal medya gönderileri, forumlar, anonim sayfalar

export type VerdictLabel =
  | 'SUPPORTED' // Birincil/kök kanıtlarla doğrulandı
  | 'CONTRADICTED' // Güvenilir kanıtlar iddiayı doğrudan çürütüyor
  | 'MISLEADING_CONTEXT' // Veri veya görsel gerçek ama bağlamından koparılmış/çarpıtılmış
  | 'NOT_ENOUGH_EVIDENCE' // Kök kanıta ulaşılamadı (çıkmaz sokak)
  | 'CIRCULAR_ECHO_CHAMBER' // Kaynaklar birbirini kopyalıyor, birincil dayanak yok
  | 'OUTDATED'; // Geçmişte doğruydu ancak güncel verilere göre geçerliliğini yitirdi

export interface ManipulationSignal {
  type:
    | 'EMOTIONAL_TRIGGER'
    | 'ANONYMOUS_AUTHORITY'
    | 'ABSOLUTE_CERTAINTY'
    | 'CHERRY_PICKING'
    | 'CLICKBAIT_GAP';
  excerpt: string;
  explanation: string;
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
  citationPointer?: string | null; // Metnin içinde atıf yapılan birincil belge/kurum ipucu
}

export interface CitationEdge {
  fromNodeId: string;
  toNodeId: string;
  relation: 'CITES_PRIMARY' | 'SYNDICATED_COPY' | 'REFUTES' | 'SUPPORTS';
}

export interface AtomicClaimResult {
  claimId: string;
  claimText: string;
  verdict: VerdictLabel;
  confidence: number; // 0.0 - 1.0 arası kalibre edilmiş güven skoru
  reasoning: string;
  stopReason:
    | 'TERMINAL_PROOF_REACHED'
    | 'IFCN_FACTCHECK_MATCH'
    | 'MAX_DEPTH_EXCEEDED'
    | 'CYCLE_DETECTED'
    | 'NO_CITATION_POINTER';
  nodes: EvidenceNode[];
  edges: CitationEdge[];
  uniqueClusterCount: number; // Kopyalar elendikten sonra kalan bağımsız kaynak sayısı
  rawResultCount: number;
}

export interface VerificationReport {
  originalInput: string;
  checkedAt: string;
  overallVerdict: VerdictLabel;
  literacyScore: number; // 0 - 100 arası içerik güvenilirlik / şeffaflık puanı
  claims: AtomicClaimResult[];
  manipulationSignals: ManipulationSignal[];
  lateralReadingTips: string[]; // Kullanıcıya "bunu kendin nasıl doğrularsın?" rehberi
}
