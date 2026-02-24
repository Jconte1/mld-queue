export class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current += 1;
      return;
    }

    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.current += 1;
  }

  release(): void {
    this.current = Math.max(0, this.current - 1);
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly capacityPerMinute: number) {
    this.tokens = capacityPerMinute;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;

    const refillRatePerMs = this.capacityPerMinute / 60_000;
    const refillAmount = elapsedMs * refillRatePerMs;

    this.tokens = Math.min(this.capacityPerMinute, this.tokens + refillAmount);
    this.lastRefill = now;
  }

  async take(count = 1): Promise<void> {
    while (true) {
      this.refill();

      if (this.tokens >= count) {
        this.tokens -= count;
        return;
      }

      const deficit = count - this.tokens;
      const waitMs = Math.ceil((deficit / this.capacityPerMinute) * 60_000);
      await new Promise((resolve) => setTimeout(resolve, Math.max(waitMs, 25)));
    }
  }
}