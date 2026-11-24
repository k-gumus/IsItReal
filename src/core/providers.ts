export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  publishedDate?: string;
}

export interface WebSearchProvider {
  search(query: string, maxResults?: number): Promise<SearchHit[]>;
}

export type LLMTask = 'decompose' | 'pointer' | 'judge';

export interface LLMCallOptions {
  /** Hangi aşama için çağrıldığı (demo sağlayıcı ve loglama için) */
  task?: LLMTask;
}

/**
 * Yapılandırılmış JSON üreten dil modeli. Dönüş değeri bilinçli olarak `unknown`:
 * çağıran taraf `validation.ts` ile doğrulamak zorundadır.
 */
export interface StructuredLLMProvider {
  generateJSON(systemPrompt: string, userPrompt: string, options?: LLMCallOptions): Promise<unknown>;
}

export interface FactCheckProvider {
  search(claim: string, languageCode: string): Promise<Array<{
    url: string;
    title: string;
    publisher: string;
    rating: string;
    claimText: string;
    reviewDate?: string;
  }>>;
}

export interface ExtractedPage {
  url: string;
  title?: string;
  text: string;
}

/** Bir web sayfasının okunabilir metnini çıkarır (canlı modda Tavily Extract). */
export interface PageExtractor {
  extract(url: string): Promise<ExtractedPage>;
}
