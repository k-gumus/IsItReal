export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

export interface RetryOptions {
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.min(5000, seconds * 1000) : undefined;
}

/**
 * Zaman aşımı + üstel geri çekilmeli yeniden deneme.
 * 429/5xx ve ağ hatalarında yeniden dener; 4xx istemci hatalarında hemen vazgeçer.
 * Hata mesajları URL içermez (API anahtarı sızmasın diye anahtarlar zaten başlıkta gönderilir).
 */
export async function fetchWithRetry(provider: string, url: string, init: RequestInit, options: RetryOptions = {}): Promise<Response> {
  const { retries = 2, timeoutMs = 20_000, baseDelayMs = 400, fetchImpl = fetch, sleep = defaultSleep } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;

      const body = (await res.text().catch(() => '')).slice(0, 300);
      lastError = new ProviderError(provider, `HTTP ${res.status}${body ? ` – ${body}` : ''}`, res.status);
      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) throw lastError;
      await sleep(retryAfterMs(res) ?? baseDelayMs * 2 ** attempt + Math.random() * 100);
    } catch (err) {
      if (err instanceof ProviderError && (!RETRYABLE_STATUS.has(err.status ?? 0) || attempt === retries)) throw err;
      const e = err as Error;
      const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      lastError = err instanceof ProviderError ? err : new ProviderError(provider, isTimeout ? `${timeoutMs} ms içinde yanıt vermedi` : `Ağ hatası: ${e.message}`);
      if (attempt === retries) throw lastError;
      if (!(err instanceof ProviderError)) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError ?? new ProviderError(provider, 'Bilinmeyen hata');
}
