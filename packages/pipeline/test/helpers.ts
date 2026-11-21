import type { FetchFn } from '../src/http.js';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export type Handler = (call: Call) => Response | Promise<Response>;

/** A fake fetch that records calls and delegates to a handler. */
export function fakeFetch(handler: Handler): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call = { url: String(input), method: init?.method ?? 'GET', headers };
    calls.push(call);
    return handler(call);
  };
  return { fetchFn, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export const noSleep = async () => undefined;
