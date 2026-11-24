export interface DoiUpdate {
  type: string; // retraction, correction, expression_of_concern ...
  label: string;
  source: string; // publisher | retraction-watch
  date?: string;
  noticeDoi?: string;
}

export interface DoiCheck {
  doi: string;
  status: 'found' | 'not_found' | 'error';
  url: string;
  agency?: string;
  title?: string;
  authors?: string[];
  container?: string;
  publisher?: string;
  year?: number;
  type?: string;
  citedBy?: number;
  /** Bu yayını etkileyen geri çekme / düzeltme / endişe bildirimleri */
  updates: DoiUpdate[];
  isRetracted: boolean;
  /** Yayının kendisi bir geri çekme bildirimi mi? */
  isNotice?: boolean;
  error?: string;
}

export interface DoiResolver {
  check(doi: string): Promise<DoiCheck>;
}

/** Birden çok DOI'yi sınırlı eşzamanlılıkla denetler. */
export async function checkDois(resolver: DoiResolver, dois: string[], concurrency = 5): Promise<DoiCheck[]> {
  const results: DoiCheck[] = new Array(dois.length);
  let next = 0;
  const worker = async () => {
    while (next < dois.length) {
      const i = next++;
      results[i] = await resolver.check(dois[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, dois.length) }, worker));
  return results;
}
