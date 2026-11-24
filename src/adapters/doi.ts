import type { DoiCheck, DoiResolver, DoiUpdate } from '../core/citations.js';
import { fetchWithRetry, ProviderError, type RetryOptions } from './http.js';

export type { DoiCheck, DoiResolver, DoiUpdate } from '../core/citations.js';

const base = (doi: string): DoiCheck => ({ doi, status: 'error', url: `https://doi.org/${doi}`, updates: [], isRetracted: false });

const dateOf = (d?: { 'date-time'?: string; 'date-parts'?: number[][] }) =>
  d?.['date-time']?.slice(0, 10) ?? (d?.['date-parts']?.[0]?.filter(Boolean).join('-') || undefined);

interface CrossrefWork {
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  'container-title'?: string[];
  publisher?: string;
  issued?: { 'date-parts'?: number[][] };
  published?: { 'date-parts'?: number[][] };
  type?: string;
  'is-referenced-by-count'?: number;
  'updated-by'?: Array<{ type?: string; label?: string; source?: string; DOI?: string; updated?: { 'date-time'?: string; 'date-parts'?: number[][] } }>;
  'update-to'?: Array<{ type?: string }>;
}

export function parseCrossrefWork(doi: string, work: CrossrefWork): DoiCheck {
  const updates: DoiUpdate[] = (work['updated-by'] ?? []).map((u) => ({
    type: (u.type ?? 'update').toLowerCase(),
    label: u.label ?? u.type ?? 'Güncelleme',
    source: u.source ?? 'publisher',
    date: dateOf(u.updated),
    noticeDoi: u.DOI?.toLowerCase(),
  }));
  const year = (work.issued ?? work.published)?.['date-parts']?.[0]?.[0];
  return {
    ...base(doi),
    status: 'found',
    agency: 'Crossref',
    title: work.title?.[0],
    authors: (work.author ?? []).slice(0, 8).map((a) => a.name ?? [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    container: work['container-title']?.[0],
    publisher: work.publisher,
    year: typeof year === 'number' ? year : undefined,
    type: work.type,
    citedBy: work['is-referenced-by-count'],
    updates,
    isRetracted: updates.some((u) => u.type === 'retraction' || u.type === 'withdrawal' || u.type === 'removal'),
    isNotice: (work['update-to'] ?? []).some((u) => u.type === 'retraction'),
  };
}

/**
 * Anahtar gerektirmeyen açık servislerle DOI denetimi:
 *  1. Crossref REST API: üst veri + geri çekme bilgisi (Retraction Watch verisi dahil, "updated-by")
 *  2. Crossref'te yoksa doi.org handle API: DOI hiç kayıtlı mı? (responseCode 1 = var, 100 = yok)
 *  3. Kayıtlıysa DataCite'tan üst veri (Zenodo, arXiv vb.)
 */
export class OpenDoiResolver implements DoiResolver {
  constructor(
    private readonly mailto?: string,
    private readonly options: RetryOptions = {}
  ) {}

  private headers(): Record<string, string> {
    return { Accept: 'application/json', 'User-Agent': `IsItReal/0.3 (https://github.com/k-gumus/IsItReal${this.mailto ? `; mailto:${this.mailto}` : ''})` };
  }

  private async getJson(provider: string, url: string): Promise<{ status: number; body?: unknown }> {
    try {
      const res = await fetchWithRetry(provider, url, { headers: this.headers() }, { timeoutMs: 10_000, retries: 1, ...this.options });
      return { status: res.status, body: await res.json() };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return { status: 404 };
      throw err;
    }
  }

  async check(rawDoi: string): Promise<DoiCheck> {
    const doi = rawDoi.toLowerCase();
    const path = doi.split('/').map(encodeURIComponent).join('/');
    try {
      const mail = this.mailto ? `?mailto=${encodeURIComponent(this.mailto)}` : '';
      const crossref = await this.getJson('Crossref', `https://api.crossref.org/works/${path}${mail}`);
      if (crossref.status === 200) {
        return parseCrossrefWork(doi, ((crossref.body as { message?: CrossrefWork })?.message ?? {}) as CrossrefWork);
      }

      const handle = await this.getJson('doi.org', `https://doi.org/api/handles/${path}`);
      const code = (handle.body as { responseCode?: number } | undefined)?.responseCode;
      if (handle.status === 404 || code === 100) return { ...base(doi), status: 'not_found' };
      if (code !== 1) return { ...base(doi), error: `doi.org beklenmeyen yanıt (${code ?? handle.status})` };

      const datacite = await this.getJson('DataCite', `https://api.datacite.org/dois/${path}`).catch(() => ({ status: 0 }));
      const attrs = (datacite as { body?: { data?: { attributes?: Record<string, unknown> } } }).body?.data?.attributes as
        | { titles?: Array<{ title?: string }>; creators?: Array<{ name?: string }>; publisher?: string | { name?: string }; publicationYear?: number; types?: { resourceTypeGeneral?: string } }
        | undefined;
      return {
        ...base(doi),
        status: 'found',
        agency: attrs ? 'DataCite' : 'Diğer kayıt kuruluşu',
        title: attrs?.titles?.[0]?.title,
        authors: attrs?.creators?.slice(0, 8).map((c) => c.name ?? '').filter(Boolean),
        publisher: typeof attrs?.publisher === 'string' ? attrs.publisher : attrs?.publisher?.name,
        year: attrs?.publicationYear,
        type: attrs?.types?.resourceTypeGeneral,
      };
    } catch (err) {
      return { ...base(doi), error: (err as Error).message };
    }
  }
}

/** Demo DOI'lerini (10.5555/demo.*) kurgusal çözücüye, diğerlerini gerçek çözücüye yönlendirir. */
export class RoutingDoiResolver implements DoiResolver {
  constructor(
    private readonly real: DoiResolver,
    private readonly demo: DoiResolver = new DemoDoiResolver()
  ) {}
  check(doi: string): Promise<DoiCheck> {
    return doi.toLowerCase().startsWith('10.5555/demo.') ? this.demo.check(doi) : this.real.check(doi);
  }
}

/** Demo modu: 10.5555 Crossref'in test önekidir; aşağıdaki kayıtlar kurgusaldır. */
export class DemoDoiResolver implements DoiResolver {
  async check(rawDoi: string): Promise<DoiCheck> {
    const doi = rawDoi.toLowerCase();
    if (doi === '10.5555/demo.2024.001') {
      return {
        ...base(doi),
        status: 'found',
        agency: 'Crossref',
        title: 'Kentsel ısı adalarının hane enerji tüketimine etkisi (demo kayıt)',
        authors: ['A. Örnek', 'B. Deneme'],
        container: 'Demo Çevre Bilimleri Dergisi',
        publisher: 'Demo Yayınevi',
        year: 2024,
        type: 'journal-article',
        citedBy: 37,
      };
    }
    if (doi === '10.5555/demo.2019.042') {
      return {
        ...base(doi),
        status: 'found',
        agency: 'Crossref',
        title: 'Bir gıda takviyesinin bilişsel performansa etkisi (demo kayıt)',
        authors: ['C. Kurgu'],
        container: 'Demo Beslenme Dergisi',
        publisher: 'Demo Yayınevi',
        year: 2019,
        type: 'journal-article',
        citedBy: 112,
        updates: [{ type: 'retraction', label: 'Retraction', source: 'retraction-watch', date: '2022-03-14', noticeDoi: '10.5555/demo.2022.900' }],
        isRetracted: true,
      };
    }
    return { ...base(doi), status: 'not_found' };
  }
}
