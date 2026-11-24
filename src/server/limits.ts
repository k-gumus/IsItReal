/** IP başına sabit pencereli hız sınırlayıcı (bellek içi, tek süreç için yeterli). */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {}

  take(key: string): { allowed: boolean; retryAfterMs: number } {
    const t = this.now();
    if (this.hits.size > 10_000) this.sweep(t);
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return { allowed: true, retryAfterMs: 0 };
    }
    if (entry.count >= this.limit) return { allowed: false, retryAfterMs: entry.resetAt - t };
    entry.count++;
    return { allowed: true, retryAfterMs: 0 };
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/** Süreli ve boyut sınırlı önbellek: aynı metin kısa sürede tekrar sorulursa API kotası harcanmaz. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    // LRU: erişileni sona taşı
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V) {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

/**
 * Sunucu genelinde günlük doğrulama sınırı: site herkese açıkken API kredilerini korur.
 * Gün, verilen saat dilimine göre (varsayılan İstanbul) gece yarısında sıfırlanır. limit <= 0 ise sınırsız.
 */
export class DailyCounter {
  private day = '';
  private count = 0;

  constructor(
    private readonly limit: number,
    private readonly timeZone = 'Europe/Istanbul',
    private readonly now: () => Date = () => new Date()
  ) {}

  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone }).format(this.now());
  }

  /** Bir hak kullanır; sınır dolduysa false döner. */
  take(): boolean {
    if (this.limit <= 0) return true;
    const day = this.today();
    if (day !== this.day) {
      this.day = day;
      this.count = 0;
    }
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }

  remaining(): number | null {
    if (this.limit <= 0) return null;
    return this.today() === this.day ? Math.max(0, this.limit - this.count) : this.limit;
  }
}
