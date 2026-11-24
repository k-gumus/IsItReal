import { classifySource } from './authority';
import { clusterEchoChambers } from './deduplicator';
import { CitationEdge, EvidenceNode } from './types';

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
}

export interface WebSearchProvider {
  search(query: string, maxResults?: number): Promise<SearchHit[]>;
}

export interface StructuredLLMProvider {
  generateJSON<T>(systemPrompt: string, userPrompt: string): Promise<T>;
}

export interface TracerConfig {
  maxDepth: number; // Önerilen: 2 (Hop 0: Genel + Teyit araması, Hop 1: Birincil kaynak izi)
  googleFactCheckApiKey?: string;
  languageCode?: string;
}

interface PointerExtraction {
  hasPrimaryPointer: boolean;
  targetedPrimaryQuery: string | null;
  citedEntityOrDocument: string | null;
}

export class CitationLineageTracer {
  private readonly maxDepth: number;
  private readonly factCheckApiKey?: string;
  private readonly languageCode: string;

  constructor(
    private readonly searchProvider: WebSearchProvider,
    private readonly llm: StructuredLLMProvider,
    config: TracerConfig = { maxDepth: 2, languageCode: 'tr' }
  ) {
    this.maxDepth = config.maxDepth;
    this.factCheckApiKey = config.googleFactCheckApiKey;
    this.languageCode = config.languageCode ?? 'tr';
  }

  /**
   * 1. Aşama: Google Fact Check Tools API üzerinden IFCN teyit kontrolü
   */
  private async checkExistingFactChecks(claim: string): Promise<EvidenceNode[]> {
    if (!this.factCheckApiKey) return [];

    const endpoint = new URL('https://factchecktools.googleapis.com/v1alpha1/claims:search');
    endpoint.searchParams.set('query', claim);
    endpoint.searchParams.set('languageCode', this.languageCode);
    endpoint.searchParams.set('pageSize', '5');
    endpoint.searchParams.set('key', this.factCheckApiKey);

    try {
      const res = await fetch(endpoint.toString());
      if (!res.ok) return [];
      const data = (await res.json()) as {
        claims?: Array<{
          text?: string;
          claimReview?: Array<{
            publisher?: { name?: string; site?: string };
            url?: string;
            title?: string;
            reviewDate?: string;
            textualRating?: string;
          }>;
        }>;
      };

      const nodes: EvidenceNode[] = [];
      for (const item of data.claims ?? []) {
        for (const review of item.claimReview ?? []) {
          if (!review.url) continue;
          const classification = classifySource(review.url, review.textualRating ?? '');
          nodes.push({
            id: `fc_${nodes.length + 1}`,
            url: review.url,
            domain: classification.domain,
            title: review.title ?? 'Teyit İncelemesi',
            snippet: `Teyit Sonucu (${review.publisher?.name ?? classification.domain}): ${review.textualRating ?? 'İncelendi'} — İddia: "${item.text ?? claim}"`,
            publishedDate: review.reviewDate,
            tier: 'TIER_1_TERMINAL_PROOF',
            isTerminalProof: true,
            hopDepth: 0,
          });
        }
      }
      return nodes;
    } catch {
      return [];
    }
  }

  /**
   * 2. Aşama: İkincil haber metinlerinden "Kök Kanıt İşaretçisi" (Citation Pointer) çıkarımı
   */
  private async extractCitationPointer(
    claim: string,
    secondaryNodes: EvidenceNode[]
  ): Promise<PointerExtraction> {
    const context = secondaryNodes
      .slice(0, 5)
      .map((n, i) => `[${i + 1}] (${n.domain}) ${n.title}: ${n.snippet}`)
      .join('\n');

    const systemPrompt = `Sen bir araştırma gazetecisi ve bilgi doğrulama ajanısın.
Görevin: Verilen haber parçacıklarında iddianın dayandırıldığı BİRİNCİL BELGE, RESMİ KURUM, AKADEMİK MAKALE veya HAM VERİ işaretçisini bulmaktır.
Kurallar:
- Eğer haberlerde sadece "uzmanlar uyardı", "kulislerde konuşuluyor", "sosyal medyada gündem oldu" gibi belirsiz ifadeler varsa hasPrimaryPointer = false döndür.
- Eğer somut bir kurum/belge varsa (örn. "TÜİK Ekim 2026 enflasyon verisi", "Resmi Gazete 32712 sayılı karar", "Nature 2025 makalesi"), bunu doğrudan o birincil kaynağı bulacak hedef odaklı bir arama sorgusuna (mümkünse site: operatörüyle) dönüştür.
Sadece geçerli JSON döndür:
{
  "hasPrimaryPointer": boolean,
  "citedEntityOrDocument": string | null,
  "targetedPrimaryQuery": string | null
}`;

    return this.llm.generateJSON<PointerExtraction>(
      systemPrompt,
      `İddia: "${claim}"\n\nBulunan İkincil Kaynaklar:\n${context}`
    );
  }

  /**
   * 3. Aşama: Döngü Korumalı (Cycle-Safe) Kaynak Soy Ağacı İz Sürücü
   */
  public async traceClaim(claim: string): Promise<{
    nodes: EvidenceNode[];
    edges: CitationEdge[];
    stopReason:
      | 'TERMINAL_PROOF_REACHED'
      | 'IFCN_FACTCHECK_MATCH'
      | 'MAX_DEPTH_EXCEEDED'
      | 'CYCLE_DETECTED'
      | 'NO_CITATION_POINTER';
    uniqueClusterCount: number;
    rawResultCount: number;
    isEchoChamber: boolean;
  }> {
    const visitedUrls = new Set<string>();
    const visitedQueries = new Set<string>();
    const allNodes: EvidenceNode[] = [];
    const edges: CitationEdge[] = [];

    // Adım 0A: Önce IFCN Teyit Veritabanını sorgula (Fast-Path)
    const factCheckNodes = await this.checkExistingFactChecks(claim);
    if (factCheckNodes.length > 0) {
      for (const fc of factCheckNodes) {
        visitedUrls.add(fc.url);
        allNodes.push(fc);
      }
      return {
        nodes: allNodes,
        edges,
        stopReason: 'IFCN_FACTCHECK_MATCH',
        uniqueClusterCount: allNodes.length,
        rawResultCount: allNodes.length,
        isEchoChamber: false,
      };
    }

    // Adım 0B: Çok yönlü ilk web taraması (Tarafsız iddia + teyit sorgusu)
    const neutralQuery = claim.replace(/[!?."“”]/g, '').trim();
    const verificationQuery = `${neutralQuery} teyit OR yalanlandı OR resmi açıklama`;

    visitedQueries.add(neutralQuery.toLowerCase());
    visitedQueries.add(verificationQuery.toLowerCase());

    const [rawHitsA, rawHitsB] = await Promise.all([
      this.searchProvider.search(neutralQuery, 6),
      this.searchProvider.search(verificationQuery, 4),
    ]);

    const initialHits = [...rawHitsA, ...rawHitsB];
    for (const hit of initialHits) {
      if (visitedUrls.has(hit.url)) continue;
      visitedUrls.add(hit.url);

      const { domain, tier, isTerminalProof } = classifySource(hit.url, hit.snippet);
      allNodes.push({
        id: `node_0_${allNodes.length + 1}`,
        url: hit.url,
        domain,
        title: hit.title,
        snippet: hit.snippet,
        publishedDate: hit.publishedDate,
        tier,
        isTerminalProof,
        hopDepth: 0,
      });
    }

    // Yankı odası / kopya metin kümelemesi
    const { clusteredNodes, uniqueClusterCount, isEchoChamber } = clusterEchoChambers(allNodes);
    allNodes.splice(0, allNodes.length, ...clusteredNodes);

    // Hop 0'da doğrudan Kök Kanıt Düğümü (resmi site, DOI, teyit.org vb.) bulunduysa dur!
    if (allNodes.some((n) => n.isTerminalProof)) {
      return {
        nodes: allNodes,
        edges,
        stopReason: 'TERMINAL_PROOF_REACHED',
        uniqueClusterCount,
        rawResultCount: allNodes.length,
        isEchoChamber,
      };
    }

    // Döngü Kesici: Tüm sonuçlar tek bir kopya kümesine sıkışmışsa ve derinlik 1'den büyükse dur
    if (isEchoChamber && this.maxDepth < 1) {
      return {
        nodes: allNodes,
        edges,
        stopReason: 'CYCLE_DETECTED',
        uniqueClusterCount,
        rawResultCount: allNodes.length,
        isEchoChamber,
      };
    }

    // Adım 1..MAX_DEPTH: İkincil haberlerden birincil kaynak izi sürme
    let currentDepth = 1;
    while (currentDepth <= this.maxDepth) {
      const secondaryCandidates = allNodes.filter((n) => n.hopDepth === currentDepth - 1);
      if (secondaryCandidates.length === 0) break;

      const pointer = await this.extractCitationPointer(claim, secondaryCandidates);

      if (!pointer.hasPrimaryPointer || !pointer.targetedPrimaryQuery) {
        return {
          nodes: allNodes,
          edges,
          stopReason: 'NO_CITATION_POINTER',
          uniqueClusterCount,
          rawResultCount: allNodes.length,
          isEchoChamber,
        };
      }

      const normalizedNextQuery = pointer.targetedPrimaryQuery.toLowerCase().trim();
      // Aynı sorguya tekrar düşülüyorsa döngü kesici devreye girer
      if (visitedQueries.has(normalizedNextQuery)) {
        return {
          nodes: allNodes,
          edges,
          stopReason: 'CYCLE_DETECTED',
          uniqueClusterCount,
          rawResultCount: allNodes.length,
          isEchoChamber,
        };
      }
      visitedQueries.add(normalizedNextQuery);

      const primaryHits = await this.searchProvider.search(pointer.targetedPrimaryQuery, 5);
      let foundTerminalInThisHop = false;

      for (const hit of primaryHits) {
        if (visitedUrls.has(hit.url)) continue;
        visitedUrls.add(hit.url);

        const { domain, tier, isTerminalProof } = classifySource(hit.url, hit.snippet);
        const newNode: EvidenceNode = {
          id: `node_${currentDepth}_${allNodes.length + 1}`,
          url: hit.url,
          domain,
          title: hit.title,
          snippet: hit.snippet,
          publishedDate: hit.publishedDate,
          tier,
          isTerminalProof,
          hopDepth: currentDepth,
          citationPointer: pointer.citedEntityOrDocument,
        };
        allNodes.push(newNode);

        // Soy ağacı kenarını (edge) bağla
        edges.push({
          fromNodeId: secondaryCandidates[0].id,
          toNodeId: newNode.id,
          relation: isTerminalProof ? 'CITES_PRIMARY' : 'SUPPORTS',
        });

        if (isTerminalProof) {
          foundTerminalInThisHop = true;
        }
      }

      if (foundTerminalInThisHop) {
        return {
          nodes: allNodes,
          edges,
          stopReason: 'TERMINAL_PROOF_REACHED',
          uniqueClusterCount,
          rawResultCount: allNodes.length,
          isEchoChamber,
        };
      }

      currentDepth++;
    }

    return {
      nodes: allNodes,
      edges,
      stopReason: 'MAX_DEPTH_EXCEEDED',
      uniqueClusterCount,
      rawResultCount: allNodes.length,
      isEchoChamber,
    };
  }
}
