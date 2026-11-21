import { simulate, type Product } from '@asc/engine';
import { describe, expect, it } from 'vitest';
import { normaliseProduct } from '../src/normalise.js';
import { applyAnswers, buildCandidates, emptyReviews } from '../src/review/review.js';
import type { ProductDetail } from '../src/types.js';
import { boostSaver, rawFile } from './fixtures/products.js';

const people = [{ id: 'p1', age: 40, taxableIncome: 100_000 }];
const oneMonthInterest = (p: Product, balance = 10_000) =>
  simulate({ startDate: '2026-12-01', months: 1, people, accounts: [{ kind: 'savings', id: 'a', product: p, owners: { p1: 1 }, openingBalance: balance }] })
    .months[0]!.accounts.a!.interest;
const at = (rate: number, balance = 10_000) => Math.round(((balance * rate * 31) / 365) * 100) / 100;

function norm(d: ProductDetail, reviews = emptyReviews(), brands: Record<string, string> = {}, slug = 'bank') {
  const f = rawFile(slug, [d]);
  return normaliseProduct(f, f.products[0]!, reviews, brands)!;
}

describe('normaliseProduct (unreviewed)', () => {
  it('maps CDR rows, tiers and structured conditions', () => {
    const p = norm(boostSaver);
    expect(p.kind).toBe('savings');
    expect(p.reviewed).toBe(false);
    const bonus = p.rows.find((r) => r.role === 'BONUS')!;
    expect(bonus.rate).toBe(0.0575);
    expect(bonus.tiers).toEqual([{ min: 0, max: 250_000 }]);
    expect(bonus.conditions.map((c) => [c.type, c.amount ?? c.count])).toEqual([
      ['MIN_DEPOSIT_AMOUNT', 1000],
      ['MIN_PURCHASES', 5],
    ]);
  });

  it('turns free-text-only bonus conditions into an OTHER condition', () => {
    const p = norm({ ...boostSaver, depositRates: [{ depositRateType: 'BONUS', rate: '0.05', additionalValue: 'Grow your balance each month' }] });
    expect(p.rows[0]!.conditions[0]).toMatchObject({ type: 'OTHER' });
    expect(p.rows[0]!.conditions[0]!.description).toContain('Grow your balance');
  });

  it('treats duplicated base bands as alternatives instead of summing them (Macquarie pattern)', () => {
    const band = (rate: string, info: string, min: string, max?: string) => ({
      depositRateType: 'VARIABLE',
      rate,
      additionalInfo: info,
      tiers: [{ name: 't', unitOfMeasure: 'DOLLAR', minimumValue: min, ...(max ? { maximumValue: max } : {}), rateApplicationMethod: 'PER_TIER' }],
    });
    const p = norm({
      ...boostSaver,
      depositRates: [
        band('0.0515', 'CMA advised accounts', '0.00', '1999999.99'),
        band('0.0465', 'CMA advised accounts', '2000000.00'),
        band('0.0515', 'CMA non-advised accounts', '0.00', '1999999.99'),
        band('0.0465', 'CMA non-advised accounts', '2000000.00'),
      ],
    });
    expect(p.notes).toContain('Overlapping base rates treated as alternatives');
    expect(new Set(p.rows.map((r) => r.option))).toEqual(new Set(['CMA advised accounts', 'CMA non-advised accounts']));
    expect(oneMonthInterest(p)).toBe(at(0.0515));
  });

  it('drops fixed-term sub-options from an at-call product (AMB Capital Guaranteed pattern)', () => {
    const p = norm({
      ...boostSaver,
      name: 'Capital Guaranteed Saver',
      depositRates: [
        { depositRateType: 'VARIABLE', rate: '0.0025' },
        { depositRateType: 'FIXED', rate: '0.054', additionalValue: 'P12M' },
        { depositRateType: 'FIXED', rate: '0.0355', additionalValue: 'P24M' },
      ],
    });
    expect(p.kind).toBe('savings');
    expect(p.rows).toHaveLength(1);
    expect(p.notes).toContain('Fixed-term options inside this account ignored');
  });

  it('excludes superannuation products and flags restricted audiences by name or brand', () => {
    const f = rawFile('bank', [{ ...boostSaver, name: 'Capital Guaranteed Super' }]);
    expect(normaliseProduct(f, f.products[0]!, emptyReviews())).toBeNull();
    expect(norm({ ...boostSaver, name: 'Kids Saver' }).eligibility.restrictedTo).toContain('Kids');
    expect(norm(boostSaver, emptyReviews(), { qbank: 'Police and emergency services' }, 'qbank').eligibility.restrictedTo).toBe('Police and emergency services');
  });

  it('reads TD terms from product names only for term deposits', () => {
    const td = norm({ productId: 'td', productCategory: 'TERM_DEPOSITS', name: '12 Month Term Deposit', brandName: 'X', depositRates: [{ depositRateType: 'FIXED', rate: '0.056', applicationType: 'MATURITY' }] });
    expect(td.kind).toBe('term_deposit');
    expect(td.rows[0]!.term).toEqual({ min: 12, max: 12 });
    expect(td.rows[0]!.payment).toEqual({ type: 'MATURITY', everyMonths: null });
    const saver = norm({ ...boostSaver, name: 'Notice Saver 90 days', depositRates: [{ depositRateType: 'VARIABLE', rate: '0.05' }] });
    expect(saver.rows[0]!.term).toBeNull();
    expect(saver.kind).toBe('savings');
  });
});

describe('normaliseProduct (reviewed)', () => {
  const detail: ProductDetail = {
    productId: 'netbank',
    productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
    name: 'NetBank Saver',
    brandName: 'CommBank',
    depositRates: [
      { depositRateType: 'VARIABLE', rate: '0.025' },
      { depositRateType: 'INTRODUCTORY', rate: '0.0325', additionalValue: 'P5M' },
      { depositRateType: 'VARIABLE', rate: '0.025', additionalInfo: 'tiered', tiers: [{ name: 'a', unitOfMeasure: 'DOLLAR', minimumValue: '0', maximumValue: '49999.99', rateApplicationMethod: 'PER_TIER' }] },
      { depositRateType: 'VARIABLE', rate: '0.025', additionalInfo: 'tiered', tiers: [{ name: 'b', unitOfMeasure: 'DOLLAR', minimumValue: '50000', rateApplicationMethod: 'PER_TIER' }] },
      { depositRateType: 'FIXED', rate: '0.115', additionalInfo: 'competition winners' },
    ],
  };

  function reviewed() {
    const f = rawFile('cba', [detail]);
    const c = buildCandidates([f]).find((x) => x.productId === 'netbank')!;
    const reviews = emptyReviews();
    const res = applyAnswers(
      {
        reviews: [
          {
            key: c.key,
            reviewKey: c.reviewKey,
            confidence: 'high',
            eligibility: { jointAllowed: true },
            rows: [
              { index: 0, role: 'BASE' },
              { index: 1, role: 'INTRO', introMonths: 5, conditions: [{ type: 'NEW_CUSTOMER', period: 'ONCE' }] },
              { index: 2, role: 'BASE' },
              { index: 3, role: 'BASE' },
              { index: 4, role: 'EXCLUDE', excludeReason: 'competition' },
            ],
          },
        ],
      },
      [c],
      reviews,
    );
    return { f, reviews, res };
  }

  it('applies roles, drops excluded rows, and the validator warns about the overlapping base rows', () => {
    const { f, reviews, res } = reviewed();
    expect(res.warnings.some((w) => w.includes('overlap'))).toBe(true);
    const p = normaliseProduct(f, f.products[0]!, reviews)!;
    expect(p.reviewed).toBe(true);
    expect(p.confidence).toBe('high');
    expect(p.eligibility.jointAllowed).toBe(true);
    expect(p.rows.map((r) => r.role)).toEqual(['BASE', 'INTRO', 'BASE', 'BASE']);
    expect(p.rows.find((r) => r.role === 'INTRO')!.introMonths).toBe(5);
  });

  it('does not double-count the base rate published twice (CommBank NetBank Saver)', () => {
    const { f, reviews } = reviewed();
    const p = normaliseProduct(f, f.products[0]!, reviews)!;
    expect(oneMonthInterest(p, 60_000)).toBe(at(0.0575, 60_000));
  });
});
