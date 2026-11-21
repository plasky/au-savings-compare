import { PROBE_ORIGIN, USER_AGENT } from './config.js';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface VersionSpec {
  preferred: number;
  min: number;
}

export interface Strategy {
  xv: number;
  /** null = send x-v only (some holders reject x-min-v). */
  xminv: number | null;
}

export interface CdrResult<T = unknown> {
  ok: boolean;
  /** 0 = network error or timeout. */
  status: number;
  url: string;
  body: T | null;
  /** Payload version the holder reported in its x-v response header. */
  version: string | null;
  requested: Strategy;
  attempts: number;
  error?: string;
  /** First CDR error title/detail, if the holder returned one. */
  errorDetail?: string;
  headers: { acao: string | null; exposeHeaders: string | null; contentType: string | null };
}

export interface CorsProbe {
  status: number;
  error?: string;
  allowOrigin: string | null;
  allowHeaders: string | null;
  allowMethods: string | null;
}

export interface ClientOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
  origin?: string;
}

const VERSION_ERROR_STATUSES = new Set([400, 406, 422]);

/**
 * HTTP client for CDR public (unauthenticated) endpoints.
 *
 * - Version negotiation: tries x-v=preferred + x-min-v=min, then exact
 *   versions descending without x-min-v. The strategy that worked is
 *   remembered per memo key (e.g. "<endpoint>:detail") and tried first.
 * - Retries network errors, timeouts, 429 (honouring Retry-After) and 5xx.
 */
export class CdrClient {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly userAgent: string;
  private readonly origin: string;
  private readonly memo = new Map<string, Strategy>();
  private readonly negotiationFailures = new Map<string, number>();

  constructor(opts: ClientOptions = {}) {
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.origin = opts.origin ?? PROBE_ORIGIN;
  }

  strategiesFor(versions: VersionSpec, memoKey?: string): Strategy[] {
    const list: Strategy[] = [];
    const remembered = memoKey ? this.memo.get(memoKey) : undefined;
    if (remembered) list.push(remembered);
    list.push({ xv: versions.preferred, xminv: versions.min });
    // After repeated full negotiation failures for this key, stop trying every version.
    const failures = memoKey ? (this.negotiationFailures.get(memoKey) ?? 0) : 0;
    if (failures < 2) {
      for (let v = versions.preferred; v >= versions.min; v--) list.push({ xv: v, xminv: null });
    }
    const seen = new Set<string>();
    return list.filter((s) => {
      const k = `${s.xv}:${s.xminv}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  async get<T = unknown>(url: string, versions: VersionSpec, memoKey?: string): Promise<CdrResult<T>> {
    let last: CdrResult<T> | undefined;
    for (const strategy of this.strategiesFor(versions, memoKey)) {
      const res = await this.request<T>(url, strategy);
      if (res.ok) {
        if (memoKey) {
          this.memo.set(memoKey, strategy);
          this.negotiationFailures.delete(memoKey);
        }
        return res;
      }
      last = res;
      if (!VERSION_ERROR_STATUSES.has(res.status)) return res;
    }
    if (memoKey) this.negotiationFailures.set(memoKey, (this.negotiationFailures.get(memoKey) ?? 0) + 1);
    return last!;
  }

  private async request<T>(url: string, strategy: Strategy): Promise<CdrResult<T>> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
      Origin: this.origin,
      'x-v': String(strategy.xv),
    };
    if (strategy.xminv !== null) headers['x-min-v'] = String(strategy.xminv);

    for (let attempt = 1; ; attempt++) {
      try {
        const resp = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
        if ((resp.status === 429 || resp.status >= 500) && attempt <= this.maxRetries) {
          await resp.body?.cancel().catch(() => undefined);
          await this.sleep(retryDelayMs(resp.headers.get('retry-after'), attempt));
          continue;
        }
        const text = await resp.text();
        let body: unknown = null;
        let parseError: string | undefined;
        if (text.trim()) {
          try {
            body = JSON.parse(text);
          } catch {
            parseError = 'invalid-json';
          }
        }
        const ok = resp.ok && !parseError && body !== null;
        const result: CdrResult<T> = {
          ok,
          status: resp.status,
          url,
          body: (body as T) ?? null,
          version: resp.headers.get('x-v'),
          requested: strategy,
          attempts: attempt,
          headers: {
            acao: resp.headers.get('access-control-allow-origin'),
            exposeHeaders: resp.headers.get('access-control-expose-headers'),
            contentType: resp.headers.get('content-type'),
          },
        };
        if (!ok) {
          result.error = !resp.ok ? `http-${resp.status}` : (parseError ?? 'empty-body');
          const detail = cdrErrorDetail(body);
          if (detail) result.errorDetail = detail;
        }
        return result;
      } catch (e) {
        if (attempt <= this.maxRetries) {
          await this.sleep(retryDelayMs(null, attempt));
          continue;
        }
        return {
          ok: false,
          status: 0,
          url,
          body: null,
          version: null,
          requested: strategy,
          attempts: attempt,
          error: networkErrorName(e),
          headers: { acao: null, exposeHeaders: null, contentType: null },
        };
      }
    }
  }

  /** Send a CORS preflight as a browser would before calling with x-v / x-min-v. */
  async probeCors(url: string): Promise<CorsProbe> {
    try {
      const resp = await this.fetchFn(url, {
        method: 'OPTIONS',
        headers: {
          Origin: this.origin,
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-v,x-min-v',
          'User-Agent': this.userAgent,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await resp.body?.cancel().catch(() => undefined);
      return {
        status: resp.status,
        allowOrigin: resp.headers.get('access-control-allow-origin'),
        allowHeaders: resp.headers.get('access-control-allow-headers'),
        allowMethods: resp.headers.get('access-control-allow-methods'),
      };
    } catch (e) {
      return { status: 0, error: networkErrorName(e), allowOrigin: null, allowHeaders: null, allowMethods: null };
    }
  }
}

export interface CorsAssessment {
  preflightOk: boolean;
  allowsXv: boolean;
  allowsXminv: boolean;
  getAllowsOrigin: boolean;
  exposesXv: boolean;
  /** A browser page on another origin could call this endpoint with x-v. */
  browserReady: boolean;
}

function headerListIncludes(list: string | null, name: string): boolean {
  if (!list) return false;
  const items = list.split(',').map((s) => s.trim().toLowerCase());
  return items.includes('*') || items.includes(name.toLowerCase());
}

function originAllowed(value: string | null, origin: string): boolean {
  return value === '*' || value === origin;
}

export function assessCors(
  probe: CorsProbe,
  getHeaders: { acao: string | null; exposeHeaders: string | null } | null,
  origin = PROBE_ORIGIN,
): CorsAssessment {
  const preflightOk = probe.status >= 200 && probe.status < 300 && originAllowed(probe.allowOrigin, origin);
  const allowsXv = preflightOk && headerListIncludes(probe.allowHeaders, 'x-v');
  const allowsXminv = preflightOk && headerListIncludes(probe.allowHeaders, 'x-min-v');
  const getAllowsOrigin = !!getHeaders && originAllowed(getHeaders.acao, origin);
  const exposesXv = !!getHeaders && headerListIncludes(getHeaders.exposeHeaders, 'x-v');
  return {
    preflightOk,
    allowsXv,
    allowsXminv,
    getAllowsOrigin,
    exposesXv,
    browserReady: allowsXv && getAllowsOrigin,
  };
}

export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  }
  return Math.min(1000 * 2 ** (attempt - 1), 15_000) + Math.floor(Math.random() * 250);
}

function cdrErrorDetail(body: unknown): string | undefined {
  const errors = (body as { errors?: Array<{ code?: string; title?: string; detail?: string }> } | null)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const e = errors[0]!;
  return [e.code, e.title, e.detail].filter(Boolean).join(' | ').slice(0, 300);
}

export function networkErrorName(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'timeout';
  return err?.cause?.code ?? err?.message?.slice(0, 120) ?? 'network-error';
}
