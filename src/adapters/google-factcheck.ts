import type { FactCheckProvider } from '../core/providers.js';
import { fetchWithRetry, ProviderError, type RetryOptions } from './http.js';

/** Google Fact Check Tools API: IFCN imzacısı teyit kuruluşlarının ClaimReview kayıtları */
export class GoogleFactCheckProvider implements FactCheckProvider {
  constructor(
    private readonly apiKey: string,
    private readonly options: RetryOptions = {}
  ) {
    if (!apiKey) throw new ProviderError('Google Fact Check', 'API anahtarı eksik');
  }

  async search(claim: string, languageCode: string) {
    const endpoint = new URL('https://factchecktools.googleapis.com/v1alpha1/claims:search');
    endpoint.searchParams.set('query', claim.slice(0, 300));
    endpoint.searchParams.set('languageCode', languageCode);
    endpoint.searchParams.set('pageSize', '5');

    const res = await fetchWithRetry(
      'Google Fact Check',
      endpoint.toString(),
      { headers: { 'x-goog-api-key': this.apiKey } },
      { timeoutMs: 10_000, ...this.options }
    );

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

    const out: Awaited<ReturnType<FactCheckProvider['search']>> = [];
    for (const item of data.claims ?? []) {
      for (const review of item.claimReview ?? []) {
        if (!review.url) continue;
        out.push({
          url: review.url,
          title: review.title ?? '',
          publisher: review.publisher?.name ?? review.publisher?.site ?? '',
          rating: review.textualRating ?? '',
          claimText: item.text ?? '',
          reviewDate: review.reviewDate,
        });
      }
    }
    return out;
  }
}
