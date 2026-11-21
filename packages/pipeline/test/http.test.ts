import { describe, expect, it } from 'vitest';
import { assessCors, CdrClient, retryDelayMs } from '../src/http.js';
import { fakeFetch, json, noSleep } from './helpers.js';

const V = { preferred: 7, min: 1 };

describe('CdrClient.get', () => {
  it('sends x-v and x-min-v and returns the parsed body', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ data: { ok: 1 } }, 200, { 'x-v': '7' }));
    const client = new CdrClient({ fetchFn, sleep: noSleep });
    const res = await client.get<{ data: { ok: number } }>('https://h/p', V);
    expect(res.ok).toBe(true);
    expect(res.version).toBe('7');
    expect(res.body?.data.ok).toBe(1);
    expect(calls[0]!.headers['x-v']).toBe('7');
    expect(calls[0]!.headers['x-min-v']).toBe('1');
  });

  it('falls back to exact versions when a holder rejects x-min-v', async () => {
    const { fetchFn, calls } = fakeFetch((c) =>
      c.headers['x-min-v'] || c.headers['x-v'] !== '6'
        ? json({ errors: [{ code: 'urn:au-cds:error:cds-all:Header/UnsupportedVersion', title: 'Unsupported Version' }] }, 406)
        : json({ data: {} }, 200, { 'x-v': '6' }),
    );
    const client = new CdrClient({ fetchFn, sleep: noSleep });
    const res = await client.get('https://h/p', V, 'ep:detail');
    expect(res.ok).toBe(true);
    expect(res.requested).toEqual({ xv: 6, xminv: null });
    // 1 (x-v 7 + x-min-v) + exact 7 + exact 6
    expect(calls).toHaveLength(3);

    // The working strategy is remembered for the next call with the same memo key.
    calls.length = 0;
    await client.get('https://h/p2', V, 'ep:detail');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-v']).toBe('6');
  });

  it('does not walk versions on a 404', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({ errors: [{ title: 'Not Found' }] }, 404));
    const res = await new CdrClient({ fetchFn, sleep: noSleep }).get('https://h/p', V);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('http-404');
    expect(res.errorDetail).toContain('Not Found');
    expect(calls).toHaveLength(1);
  });

  it('retries 5xx and 429, then succeeds', async () => {
    let n = 0;
    const { fetchFn } = fakeFetch(() => {
      n++;
      if (n === 1) return new Response('busy', { status: 503 });
      if (n === 2) return new Response('slow down', { status: 429, headers: { 'retry-after': '2' } });
      return json({ data: [] });
    });
    const delays: number[] = [];
    const client = new CdrClient({ fetchFn, sleep: async (ms) => void delays.push(ms) });
    const res = await client.get('https://h/p', V);
    expect(res.ok).toBe(true);
    expect(res.attempts).toBe(3);
    expect(delays[1]).toBe(2000);
  });

  it('reports network errors after retries', async () => {
    const { fetchFn, calls } = fakeFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    });
    const res = await new CdrClient({ fetchFn, sleep: noSleep, maxRetries: 2 }).get('https://h/p', V);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toBe('ENOTFOUND');
    expect(calls).toHaveLength(3);
  });

  it('flags invalid JSON', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }));
    const res = await new CdrClient({ fetchFn, sleep: noSleep }).get('https://h/p', V);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid-json');
  });

  it('stops walking all versions after repeated negotiation failures', async () => {
    const { fetchFn, calls } = fakeFetch(() => json({}, 400));
    const client = new CdrClient({ fetchFn, sleep: noSleep });
    await client.get('https://h/a', V, 'k');
    await client.get('https://h/b', V, 'k');
    calls.length = 0;
    await client.get('https://h/c', V, 'k');
    expect(calls).toHaveLength(1);
  });
});

describe('CORS', () => {
  it('assesses a compliant holder as browser-ready', async () => {
    const { fetchFn } = fakeFetch((c) =>
      c.method === 'OPTIONS'
        ? new Response(null, {
            status: 204,
            headers: {
              'access-control-allow-origin': '*',
              'access-control-allow-headers': 'x-min-v, x-v, Cache-Control, x-fapi-interaction-id',
              'access-control-allow-methods': 'GET',
            },
          })
        : json({}),
    );
    const client = new CdrClient({ fetchFn, sleep: noSleep });
    const probe = await client.probeCors('https://h/p');
    const a = assessCors(probe, { acao: '*', exposeHeaders: 'x-v, Retry-After' });
    expect(a).toMatchObject({ preflightOk: true, allowsXv: true, allowsXminv: true, exposesXv: true, browserReady: true });
  });

  it('is not browser-ready when the preflight omits x-v', () => {
    const a = assessCors(
      { status: 200, allowOrigin: '*', allowHeaders: 'Content-Type', allowMethods: 'GET' },
      { acao: '*', exposeHeaders: null },
    );
    expect(a.browserReady).toBe(false);
    expect(a.exposesXv).toBe(false);
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After seconds, capped at 30s', () => {
    expect(retryDelayMs('5', 1)).toBe(5000);
    expect(retryDelayMs('600', 1)).toBe(30000);
  });
  it('backs off exponentially without Retry-After', () => {
    expect(retryDelayMs(null, 1)).toBeGreaterThanOrEqual(1000);
    expect(retryDelayMs(null, 3)).toBeGreaterThanOrEqual(4000);
  });
});
