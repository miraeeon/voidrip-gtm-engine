export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(`${service} API ${status}: ${message}`);
    this.name = 'ApiError';
  }
}

/** Sliding-window limiter: at most `perMinute` requests in any 60s window. */
export class RateLimiter {
  private stamps: number[] = [];
  constructor(private readonly perMinute: number, private readonly now = () => Date.now()) {}

  async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.stamps = this.stamps.filter((s) => t - s < 60_000);
      if (this.stamps.length < this.perMinute) {
        this.stamps.push(t);
        return;
      }
      const wait = 60_000 - (t - this.stamps[0]!) + 25;
      await sleep(wait);
    }
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HttpClientOptions {
  service: string;
  baseUrl: string;
  headers: Record<string, string>;
  perMinute: number;
  fetchImpl?: FetchLike;
  maxRetries?: number;
}

export class HttpClient {
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = new RateLimiter(opts.perMinute);
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  }

  async request<T = any>(method: string, endpoint: string, body?: unknown, query?: Record<string, unknown>): Promise<T> {
    const url = this.opts.baseUrl.replace(/\/$/, '') + endpoint + buildQuery(query);
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      await this.limiter.take();
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...this.opts.headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(45_000),
        });
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ApiError(this.opts.service, 0, `network error: ${(err as Error).message}`);
      }
      if (res.status === 204) return null as T;
      const text = await res.text();
      if (res.ok) return (text ? JSON.parse(text) : null) as T;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1500 * 2 ** attempt);
        continue;
      }
      let parsed: any = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
      const message =
        parsed?.error?.message ??
        (typeof parsed?.error === 'string' ? parsed.error : undefined) ??
        (Array.isArray(parsed?.errors)
          ? parsed.errors.map((e: any) => (typeof e === 'string' ? e : [e.field, e.message].filter(Boolean).join(': '))).join(', ')
          : undefined) ??
        String(text).slice(0, 300);
      throw new ApiError(this.opts.service, res.status, message, parsed);
    }
  }

  get<T = any>(endpoint: string, query?: Record<string, unknown>) {
    return this.request<T>('GET', endpoint, undefined, query);
  }
  post<T = any>(endpoint: string, body?: unknown) {
    return this.request<T>('POST', endpoint, body);
  }
  patch<T = any>(endpoint: string, body?: unknown) {
    return this.request<T>('PATCH', endpoint, body);
  }
  delete<T = any>(endpoint: string) {
    return this.request<T>('DELETE', endpoint);
  }
}

export function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (k === 'filter' && typeof v === 'object') {
      for (const [fk, fv] of Object.entries(v as Record<string, unknown>)) q.set(`filter[${fk}]`, String(fv));
    } else q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
