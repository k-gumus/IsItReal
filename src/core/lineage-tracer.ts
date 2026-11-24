import { classifySource, tierRank } from './authority.js';
import { clusterEchoChambers } from './deduplicator.js';
import { sanitizeUntrusted, UNTRUSTED_NOTICE } from './sanitize.js';
import type { FactCheckProvider, SearchHit, StructuredLLMProvider, WebSearchProvider } from './providers.js';
import type { CitationEdge, EvidenceNode, ProgressListener, StopReason, TraceResult } from './types.js';
import { parsePointer, type PointerExtraction } from './validation.js';

// Geriye dönük uyumluluk: eski kod bu tipleri lineage-tracer'dan import ediyordu
export type { SearchHit, StructuredLLMProvider, WebSearchProvider } from './providers.js';

export interface TracerConfig {
  /** Birincil kaynak izi için en fazla kaç atlama yapılacak. Önerilen: 2 */
  maxDepth: number;
  languageCode?: string;
}

export interface TraceOptions {
  claimId?: string;
  onProgress?: ProgressListener;
}

const MAX_QUERY_LENGTH = 300;

/** Takip parametrelerini, #parçayı ve sondaki "/" işaretini atarak aynı sayfanın farklı URL'lerini birleştirir. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_src)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function normalizeQuery(q: string): string {
  return q
    .toLocaleLowerCase('tr-TR')
    .replace(/["'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNeutralQuery(claim: string): string {
  const q = claim.replace(/[!?."“”]/g, ' ').replace(/\s+/g, ' ').trim();
  return q.length > MAX_QUERY_LENGTH ? q.slice(0, MAX_QUERY_LENGTH) : q;
}

export class CitationLineageTracer {
  private readonly maxDepth: number;
  private readonly languageCode: string;

  constructor(
    private readonly searchProvider: WebSearchProvider,
    private readonly llm: StructuredLLMProvider,
    config: TracerConfig = { maxDepth: 2, languageCode: 'tr' },
    private readonly factCheckProvider?: FactCheckProvider
  ) {
    this.maxDepth = Math.max(0, Math.min(4, Math.floor(config.maxDepth)));
    this.languageCode = config.languageCode ?? 'tr';
  }

  private verificationSuffix(): string {
    return this.languageCode === 'tr' ? 'teyit OR yalanlandı OR resmi açıklama' : 'fact check OR debunked OR official statement';
  }

  /** Arama hatası tüm doğrulamayı düşürmesin: hatayı uyarıya çevir, boş sonuç dön. */
  private async safeSearch(query: string, max: number, warnings: string[]): Promise<SearchHit[]> {
    try {
      const hits = await this.searchProvider.search(query, max);
      return Array.isArray(hits) ? hits.filter((h) => h && typeof h.url === 'string') : [];
    } catch (err) {
      warnings.push(`Arama başarısız ("${query.slice(0, 60)}"): ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchFactChecks(claim: string, warnings: string[]): Promise<EvidenceNode[]> {
    if (!this.factCheckProvider) return [];
    try {
      const reviews = await this.factCheckProvider.search(claim, this.languageCode);
      return reviews.slice(0, 5).map((review, i) => {
        const { domain } = classifySource(review.url);
        return {
          id: `fc_${i + 1}`,
          url: review.url,
          domain,
          title: review.title || 'Teyit incelemesi',
          snippet: `Teyit sonucu (${review.publisher || domain}): ${review.rating || 'İncelendi'}. İncelenen iddia: "${review.claimText || claim}"`,
          publishedDate: review.reviewDate,
          // Google Fact Check Tools yalnızca ClaimReview yayınlayan teyit kuruluşlarını listeler
          tier: 'TIER_1_TERMINAL_PROOF',
          isTerminalProof: true,
          hopDepth: 0,
          origin: 'factcheck',
        } satisfies EvidenceNode;
      });
    } catch (err) {
      warnings.push(`Teyit veritabanı sorgulanamadı: ${(err as Error).message}`);
      return [];
    }
  }

  /** İkincil haber metinlerinden "kök kanıt işaretçisi" (citation pointer) çıkarımı */
  private async extractCitationPointer(claim: string, sources: EvidenceNode[]): Promise<PointerExtraction> {
    const context = sources
      .map((n, i) => `[${i + 1}] (${n.domain}) ${sanitizeUntrusted(n.title, 200)}: ${sanitizeUntrusted(n.snippet, 500)}`)
      .join('\n');

    const systemPrompt = `Sen bir araştırma gazetecisi ve bilgi doğrulama ajanısın.
Görevin: Verilen haber parçacıklarında iddianın dayandırıldığı BİRİNCİL BELGE, RESMİ KURUM, AKADEMİK MAKALE veya HAM VERİ işaretçisini bulmaktır.
Kurallar:
- Haberlerde sadece "uzmanlar uyardı", "kulislerde konuşuluyor", "sosyal medyada gündem oldu" gibi belirsiz ifadeler varsa hasPrimaryPointer = false döndür.
- Somut bir kurum/belge varsa (örn. "TÜİK Ekim enflasyon verisi", "Resmi Gazete 32712 sayılı karar", "Nature 2025 makalesi"), bunu doğrudan o birincil kaynağı bulacak hedef odaklı bir arama sorgusuna (mümkünse site: operatörüyle) dönüştür.
- sourceIndex: işaretçiyi hangi numaralı kaynakta bulduğun (1 tabanlı).
${UNTRUSTED_NOTICE}
Sadece geçerli JSON döndür:
{
  "hasPrimaryPointer": boolean,
  "citedEntityOrDocument": string | null,
  "targetedPrimaryQuery": string | null,
  "sourceIndex": number | null
}`;

    const raw = await this.llm.generateJSON(
      systemPrompt,
      `İddia: "${sanitizeUntrusted(claim, 400)}"\n\n<kanitlar>\n${context}\n</kanitlar>`,
      { task: 'pointer' }
    );
    return parsePointer(raw, sources.length);
  }

  /** Döngü korumalı (cycle-safe) kaynak soy ağacı iz sürücü */
  public async traceClaim(claim: string, options: TraceOptions = {}): Promise<TraceResult> {
    const claimId = options.claimId ?? 'claim';
    const emit = options.onProgress ?? (() => {});
    const warnings: string[] = [];
    const visitedUrls = new Set<string>();
    const visitedQueries = new Set<string>();
    let nodes: EvidenceNode[] = [];
    const edges: CitationEdge[] = [];

    const addHits = (hits: SearchHit[], hop: number, pointer: string | null): EvidenceNode[] => {
      const added: EvidenceNode[] = [];
      for (const hit of hits) {
        const key = normalizeUrl(hit.url);
        if (visitedUrls.has(key)) continue;
        visitedUrls.add(key);
        const { domain, tier, isTerminalProof } = classifySource(hit.url, hit.snippet ?? '');
        if (domain === 'unknown') continue; // http(s) olmayan veya bozuk adresleri kanıt sayma
        const node: EvidenceNode = {
          id: `node_${hop}_${nodes.length + added.length + 1}`,
          url: hit.url,
          domain,
          title: (hit.title ?? '').trim() || domain,
          snippet: (hit.snippet ?? '').trim(),
          publishedDate: hit.publishedDate,
          tier,
          isTerminalProof,
          hopDepth: hop,
          citationPointer: pointer,
          origin: 'search',
        };
        added.push(node);
        emit({ type: 'evidence', claimId, node });
      }
      nodes.push(...added);
      return added;
    };

    const finish = (stopReason: StopReason, isEchoChamber: boolean): TraceResult => {
      // Son kümeleme: tüm atlamalardaki düğümleri kapsar; kopya haberleri SYNDICATED_COPY kenarlarıyla bağla
      const final = clusterEchoChambers(nodes);
      nodes = final.clusteredNodes;
      const reps = new Map(nodes.filter((n) => n.isClusterRepresentative).map((n) => [n.clusterId, n.id]));
      for (const n of nodes) {
        const repId = reps.get(n.clusterId);
        if (repId && repId !== n.id) edges.push({ fromNodeId: repId, toNodeId: n.id, relation: 'SYNDICATED_COPY' });
      }
      return {
        nodes,
        edges,
        stopReason,
        uniqueClusterCount: final.uniqueClusterCount,
        rawResultCount: nodes.length,
        isEchoChamber,
        warnings,
      };
    };

    // Adım 0: Teyit veritabanı + çok yönlü ilk web taraması (paralel)
    const neutralQuery = toNeutralQuery(claim);
    const verificationQuery = `${neutralQuery} ${this.verificationSuffix()}`;
    visitedQueries.add(normalizeQuery(neutralQuery));
    visitedQueries.add(normalizeQuery(verificationQuery));
    emit({ type: 'search', claimId, hop: 0, query: neutralQuery });

    const [factChecks, hitsA, hitsB] = await Promise.all([
      this.fetchFactChecks(claim, warnings),
      this.safeSearch(neutralQuery, 6, warnings),
      this.safeSearch(verificationQuery, 4, warnings),
    ]);

    for (const fc of factChecks) {
      visitedUrls.add(normalizeUrl(fc.url));
      nodes.push(fc);
      emit({ type: 'evidence', claimId, node: fc });
    }
    addHits([...hitsA, ...hitsB], 0, null);

    if (nodes.length === 0) return finish('NO_RESULTS', false);

    const hop0 = clusterEchoChambers(nodes.filter((n) => n.origin !== 'factcheck'));
    const isEchoChamber = hop0.isEchoChamber;

    if (factChecks.length > 0) return finish('IFCN_FACTCHECK_MATCH', isEchoChamber);
    if (nodes.some((n) => n.isTerminalProof)) return finish('TERMINAL_PROOF_REACHED', isEchoChamber);
    if (this.maxDepth < 1) return finish('MAX_DEPTH_EXCEEDED', isEchoChamber);

    // Adım 1..maxDepth: ikincil haberlerden birincil kaynak izi sürme
    let frontier = hop0.clusteredNodes.filter((n) => n.isClusterRepresentative);
    for (let depth = 1; depth <= this.maxDepth; depth++) {
      const sources = [...frontier].sort((a, b) => tierRank(a.tier) - tierRank(b.tier)).slice(0, 5);
      if (sources.length === 0) break;

      let pointer: PointerExtraction;
      try {
        pointer = await this.extractCitationPointer(claim, sources);
      } catch (err) {
        warnings.push(`Kök kanıt işaretçisi çıkarılamadı: ${(err as Error).message}`);
        return finish('NO_CITATION_POINTER', isEchoChamber);
      }

      if (!pointer.hasPrimaryPointer || !pointer.targetedPrimaryQuery) return finish('NO_CITATION_POINTER', isEchoChamber);

      const nextQuery = pointer.targetedPrimaryQuery.slice(0, MAX_QUERY_LENGTH);
      const normalized = normalizeQuery(nextQuery);
      if (visitedQueries.has(normalized)) return finish('CYCLE_DETECTED', isEchoChamber);
      visitedQueries.add(normalized);

      emit({ type: 'pointer', claimId, hop: depth, pointer: pointer.citedEntityOrDocument ?? nextQuery });
      emit({ type: 'search', claimId, hop: depth, query: nextQuery });

      const hits = await this.safeSearch(nextQuery, 5, warnings);
      const added = addHits(hits, depth, pointer.citedEntityOrDocument);

      if (hits.length > 0 && added.length === 0) {
        // Arama yalnızca daha önce görülen sayfaları döndürdü: kaynaklar kendi içinde dönüyor
        return finish('CYCLE_DETECTED', isEchoChamber);
      }
      if (added.length === 0) {
        warnings.push(`"${nextQuery.slice(0, 60)}" sorgusu sonuç döndürmedi.`);
        return finish('NO_CITATION_POINTER', isEchoChamber);
      }

      // Soy ağacı kenarı: işaretçinin bulunduğu kaynaktan yeni bulunan düğümlere
      const parent = (pointer.sourceIndex ? sources[pointer.sourceIndex - 1] : undefined) ?? sources[0]!;
      for (const node of added) {
        edges.push({ fromNodeId: parent.id, toNodeId: node.id, relation: node.isTerminalProof ? 'CITES_PRIMARY' : 'SUPPORTS' });
      }

      if (added.some((n) => n.isTerminalProof)) return finish('TERMINAL_PROOF_REACHED', isEchoChamber);
      frontier = added;
    }

    return finish('MAX_DEPTH_EXCEEDED', isEchoChamber);
  }
}
