import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Minimal promise concurrency limiter (avoids a dependency). */
export function pLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function shortHash(text: string, length = 6): string {
  return sha256(text).slice(0, length);
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'brand'
  );
}

export function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

/**
 * Parse a CDR RateString (decimal fraction, "0.0525" = 5.25%).
 * Returns null when unparseable. Does NOT correct percent-formatted values;
 * callers flag those separately.
 */
export function parseRate(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/%$/, '');
  if (cleaned === '' || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const DURATION_RE =
  /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?$/;

/** Convert an ISO 8601 date duration (P1Y, P12M, P90D, P1Y6M, P26W) to months. */
export function durationToMonths(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = DURATION_RE.exec(value.trim().toUpperCase());
  if (!m || value.trim().toUpperCase() === 'P') return null;
  const [, y, mo, w, d] = m;
  if (!y && !mo && !w && !d) return null;
  const months =
    Number(y ?? 0) * 12 + Number(mo ?? 0) + (Number(w ?? 0) * 7) / 30.4375 + Number(d ?? 0) / 30.4375;
  return Math.round(months * 100) / 100;
}

export function isIsoDuration(value: unknown): boolean {
  return durationToMonths(value) !== null;
}

export async function writeJson(path: string, data: unknown, pretty = true): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, pretty ? 2 : 0) + '\n', 'utf8');
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export function pct(rate: number | null | undefined, digits = 2): string {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(digits)}%`;
}

export function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
