import { SearchHit, WebSearchProvider } from '../core/lineage-tracer.js';

export class TavilySearchProvider implements WebSearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string, maxResults = 6): Promise<SearchHit[]> {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        search_depth: 'advanced',
        max_results: maxResults,
        include_raw_content: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily search failed (${response.status}): ${await response.text()}`);
    }

    const data = (await response.json()) as {
      results?: Array<{
        url: string;
        title: string;
        content: string;
        published_date?: string;
      }>;
    };

    return (data.results ?? []).map((item) => ({
      url: item.url,
      title: item.title,
      snippet: item.content,
      publishedDate: item.published_date,
    }));
  }
}
