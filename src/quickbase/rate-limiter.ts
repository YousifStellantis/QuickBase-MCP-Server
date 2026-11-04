/**
 * Sliding-window limiter shared by the JSON and XML clients for one user token.
 *
 * Quickbase allows about 100 requests per 10 seconds per user token on most
 * RESTful endpoints. Staying just under that client-side is cheaper than
 * collecting 429s and backing off.
 */

export interface RateLimiter {
  acquire(): Promise<void>;
}

export class SlidingWindowLimiter implements RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!Number.isFinite(limit) || limit < 1) throw new RangeError('limit must be >= 1');
  }

  async acquire(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.stamps.length > 0 && t - this.stamps[0] >= this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.limit) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(Math.max(1, this.windowMs - (t - this.stamps[0]) + 1));
    }
  }
}

export const unlimited: RateLimiter = { acquire: async () => {} };
