/** Limitador de janela deslizante em memória (por processo). */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  private sweeper: NodeJS.Timeout;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.sweeper.unref();
  }

  private recent(key: string, now: number): number[] {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }

  /** Registra uma tentativa; retorna false se o limite já foi atingido. */
  take(key: string, now = Date.now()): boolean {
    const arr = this.recent(key, now);
    if (arr.length >= this.limit) return false;
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }

  /** Apenas consulta se está bloqueado (sem registrar). */
  blocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.limit;
  }

  /** Registra um evento sem checar (ex.: falha de login). */
  hit(key: string, now = Date.now()): void {
    const arr = this.recent(key, now);
    arr.push(now);
    this.hits.set(key, arr);
  }

  /** Segundos até a janela liberar uma vaga. */
  retryAfterSec(key: string, now = Date.now()): number {
    const arr = this.recent(key, now);
    if (!arr.length) return 0;
    return Math.max(1, Math.ceil((arr[0]! + this.windowMs - now) / 1000));
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  close(): void {
    clearInterval(this.sweeper);
  }

  private sweep(): void {
    const now = Date.now();
    for (const k of [...this.hits.keys()]) this.recent(k, now);
  }
}
