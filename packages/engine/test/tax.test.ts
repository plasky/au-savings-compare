import { describe, expect, it } from 'vitest';
import { fyOf, incomeTax, incrementalTax, marginalRate, rulesFor } from '../src/tax.js';

const fy27 = rulesFor('2026-27');
const fy28 = rulesFor('2027-28');

describe('financial years', () => {
  it('labels July–June years', () => {
    expect(fyOf(new Date('2026-06-30T00:00:00Z'))).toBe('2025-26');
    expect(fyOf(new Date('2026-07-01T00:00:00Z'))).toBe('2026-27');
    expect(fyOf(new Date('2027-01-31T00:00:00Z'))).toBe('2026-27');
  });
  it('reuses the latest known rules for later years and the earliest for earlier ones', () => {
    expect(rulesFor('2031-32').fy).toBe('2027-28');
    expect(rulesFor('2024-25').fy).toBe('2026-27');
  });
});

describe('incomeTax 2026-27 (hand-calculated)', () => {
  it('$100,000: 4,020 + 30% × 55,000 = 20,520 tax, no LITO, 2,000 Medicare', () => {
    expect(incomeTax(100_000, fy27)).toMatchObject({ incomeTax: 20_520, lito: 0, medicare: 2_000, total: 22_520 });
  });
  it('$40,000: 15% × 21,800 = 3,270 tax, LITO 700 − 5% × 2,500 = 575, Medicare 800', () => {
    const t = incomeTax(40_000, fy27);
    expect(t.incomeTax).toBeCloseTo(3_270, 6);
    expect(t.lito).toBeCloseTo(575, 6);
    expect(t.medicare).toBeCloseTo(800, 6);
    expect(t.total).toBeCloseTo(3_495, 6);
  });
  it('$30,000: LITO wipes most tax and the Medicare levy phases in at 10% above $28,011', () => {
    const t = incomeTax(30_000, fy27);
    expect(t.incomeTax).toBeCloseTo(1_770, 6);
    expect(t.lito).toBeCloseTo(700, 6);
    expect(t.medicare).toBeCloseTo(198.9, 6);
  });
  it('$15,000: below the tax-free threshold', () => {
    expect(incomeTax(15_000, fy27).total).toBe(0);
  });
  it('$250,000: top bracket', () => {
    expect(incomeTax(250_000, fy27).incomeTax).toBeCloseTo(51_370 + 0.45 * 60_000, 6);
  });
});

describe('2027-28 rate cut to 14%', () => {
  it('$100,000: 3,752 + 30% × 55,000 = 20,252', () => {
    expect(incomeTax(100_000, fy28).incomeTax).toBeCloseTo(20_252, 6);
  });
});

describe('incremental tax on interest', () => {
  it('32% at $100k (30% + 2% Medicare)', () => {
    expect(incrementalTax(100_000, 1_000, fy27)).toBeCloseTo(320, 6);
    expect(marginalRate(100_000, fy27)).toBeCloseTo(0.32, 6);
  });
  it('22% at $40k (15% + 5% LITO taper + 2%)', () => {
    expect(incrementalTax(40_000, 1_000, fy27)).toBeCloseTo(220, 6);
  });
  it('47% at $200k', () => {
    expect(marginalRate(200_000, fy27)).toBeCloseTo(0.47, 6);
  });
});
