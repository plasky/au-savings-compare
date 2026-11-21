import { describe, expect, it } from 'vitest';
import { durationToMonths, parseAmount, parseRate, pLimit, slugify } from '../src/util.js';

describe('parseRate', () => {
  it('parses RateStrings as fractions', () => {
    expect(parseRate('0.0525')).toBe(0.0525);
    expect(parseRate(' 0.05 ')).toBe(0.05);
    expect(parseRate(0.03)).toBe(0.03);
  });
  it('does not silently fix percent-formatted values', () => {
    expect(parseRate('5.33')).toBe(5.33);
  });
  it('rejects junk', () => {
    expect(parseRate('')).toBeNull();
    expect(parseRate('five')).toBeNull();
    expect(parseRate(null)).toBeNull();
    expect(parseRate(Number.NaN)).toBeNull();
  });
});

describe('parseAmount', () => {
  it('handles strings with $ and commas, and numbers', () => {
    expect(parseAmount('$250,000')).toBe(250000);
    expect(parseAmount(1000)).toBe(1000);
    expect(parseAmount('')).toBeNull();
  });
});

describe('durationToMonths', () => {
  it.each([
    ['P12M', 12],
    ['P1Y', 12],
    ['P1Y6M', 18],
    ['P6M', 6],
    ['P90D', 2.96],
    ['P26W', 5.98],
  ])('%s → %d months', (iso, months) => {
    expect(durationToMonths(iso)).toBe(months);
  });
  it('rejects non-durations', () => {
    expect(durationToMonths('four months')).toBeNull();
    expect(durationToMonths('P')).toBeNull();
    expect(durationToMonths(12)).toBeNull();
  });
});

describe('pLimit', () => {
  it('never exceeds the concurrency limit', async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe('slugify', () => {
  it('makes filesystem-safe slugs', () => {
    expect(slugify('St.George Bank & Co')).toBe('st-george-bank-co');
  });
});
