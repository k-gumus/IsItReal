import type { ExtractedPage, PageExtractor, SearchHit, WebSearchProvider } from '../core/providers.js';
import { fetchWithRetry, ProviderError, type RetryOptions } from './http.js';

export interface TavilyOptions extends RetryOptions {
  /** 'advanced' daha iyi sonuç verir ama istek başına 2 kredi harcar */
  searchDepth?: 'basic' | 'advanced';
}

export class TavilySearchProvider implements WebSearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly options: TavilyOptions = {}
  ) {
    if (!apiKey) throw new ProviderError('Tavily', 'API anahtarı eksik');
  }

  async search(query: string, maxResults = 6): Promise<SearchHit[]> {
    const response = await fetchWithRetry(
      'Tavily',
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query,
          search_depth: this.options.searchDepth ?? 'advanced',
          max_results: Math.max(1, Math.min(10, maxResults)),
          include_raw_content: false,
          include_answer: false,
        }),
      },
      this.options
    );

    const data = (await response.json()) as {
      results?: Array<{ url?: string; title?: string; content?: string; published_date?: string }>;
    };

    return (data.results ?? [])
      .filter((item): item is { url: string; title?: string; content?: string; published_date?: string } => typeof item.url === 'string')
      .map((item) => ({
        url: item.url,
        title: item.title ?? '',
        snippet: item.content ?? '',
        publishedDate: item.published_date,
      }));
  }
}

/** Tavily Extract: bağlantının okunabilir metnini çeker. Sayfayı biz indirmediğimiz için sunucu SSRF riskine açılmaz. */
export class TavilyExtractor implements PageExtractor {
  constructor(
    private readonly apiKey: string,
    private readonly options: RetryOptions = {}
  ) {
    if (!apiKey) throw new ProviderError('Tavily', 'API anahtarı eksik');
  }

  async extract(url: string): Promise<ExtractedPage> {
    const response = await fetchWithRetry(
      'Tavily Extract',
      'https://api.tavily.com/extract',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ urls: [url], extract_depth: 'basic', format: 'text' }),
      },
      { timeoutMs: 30_000, ...this.options }
    );
    const data = (await response.json()) as {
      results?: Array<{ url?: string; title?: string; raw_content?: string }>;
      failed_results?: Array<{ url?: string; error?: string } | string>;
    };
    const page = data.results?.[0];
    if (!page?.raw_content?.trim()) {
      const failure = data.failed_results?.[0];
      const reason = typeof failure === 'string' ? '' : failure?.error;
      throw new ProviderError('Tavily Extract', `Sayfa içeriği alınamadı${reason ? `: ${reason}` : ''}`);
    }
    return { url: page.url ?? url, title: page.title, text: page.raw_content };
  }
}
