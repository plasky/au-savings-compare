import { describe, expect, it } from 'vitest';
import { termFromText, termRangesMonths } from '../src/rates.js';
import {
  applyAnswers,
  buildCandidates,
  buildQueue,
  composedMax,
  emptyReviews,
  normalisedRate,
  renderBatch,
  reviewKeyFor,
  stableStringify,
  type ProductReview,
  type RowReview,
} from '../src/review/review.js';
import type { ProductDetail } from '../src/types.js';
import { boostSaver, introSaver, quirky, rawFile, tdNoTerm, termDeposit } from './fixtures/products.js';

const plainSaver: ProductDetail = {
  productId: 'plain',
  productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
  name: 'Plain Saver',
  brandName: 'Example Bank',
  depositRates: [{ depositRateType: 'VARIABLE', rate: '0.045' }],
};
const lowBonus: ProductDetail = {
  productId: 'low',
  productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
  name: 'Kids Saver',
  brandName: 'Example Bank',
  depositRates: [
    { depositRateType: 'VARIABLE', rate: '0.001' },
    { depositRateType: 'BONUS', rate: '0.01', additionalValue: 'Deposit $10 a month' },
  ],
};
const twelveMonthTd: ProductDetail = {
  productId: 'td-12',
  productCategory: 'TERM_DEPOSITS',
  name: '12 Month Term Deposit Special',
  brandName: 'Example Bank',
  depositRates: [{ depositRateType: 'FIXED', rate: '0.056', applicationType: 'MATURITY' }],
};

const raws = [rawFile('example', [boostSaver, introSaver, termDeposit, plainSaver, lowBonus, twelveMonthTd]), rawFile('odd', [quirky, tdNoTerm])];

describe('term from text', () => {
  it.each([
    ['12 Month Term Deposit', 12],
    ['Term Deposit CNY 12M', 12],
    ['1 year fixed', 12],
    ['90 days', 2.96],
    ['6-month special', 6],
  ])('%s', (text, months) => expect(termFromText(text)).toBe(months));
  it('rejects implausible or missing terms', () => {
    expect(termFromText('Term Deposit')).toBeNull();
    expect(termFromText('balances over 500m')).toBeNull();
  });
  it('falls back to the product name', () => {
    expect(termRangesMonths(twelveMonthTd.depositRates![0]!, twelveMonthTd.name)).toEqual([{ min: 12, max: 12 }]);
  });
});

describe('candidates and queue', () => {
  const candidates = buildCandidates(raws);

  it('selects only products needing judgement, highest headline first', () => {
    expect(candidates.map((c) => c.productId)).toEqual(['quirky', 'intro-saver', 'boost-saver', 'td-noterm', 'low']);
    expect(candidates.find((c) => c.productId === 'td-noterm')!.reasons).toEqual(['term unknown']);
    // Percent-formatted "5.33" is corrected to 5.33% for the headline, not 533%.
    expect(candidates[0]!.headline).toBeCloseTo(0.0533 + 0.02 + 0.01);
  });

  it('applies the threshold and skips products already reviewed with the same key', () => {
    const reviews = emptyReviews();
    const boost = candidates.find((c) => c.productId === 'boost-saver')!;
    reviews.entries[boost.key] = { reviewKey: boost.reviewKey, reviewedAt: 'x', review: {} as ProductReview };
    const intro = candidates.find((c) => c.productId === 'intro-saver')!;
    reviews.entries[intro.key] = { reviewKey: 'old', reviewedAt: 'x', review: {} as ProductReview };
    const { queue, stats } = buildQueue(raws, reviews, 0.03);
    expect(queue.map((c) => c.productId)).toEqual(['quirky', 'intro-saver', 'td-noterm']);
    expect(stats).toMatchObject({ candidates: 5, reviewed: 1, stale: 1, queued: 3, belowThreshold: 1 });
  });

  it('keys reviews on rate content, not key order', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const reordered = { ...boostSaver, depositRates: boostSaver.depositRates!.map((r) => Object.fromEntries(Object.entries(r).reverse())) };
    expect(reviewKeyFor(reordered as ProductDetail)).toBe(reviewKeyFor(boostSaver));
    expect(reviewKeyFor({ ...boostSaver, description: 'changed marketing text' })).toBe(reviewKeyFor(boostSaver));
  });

  it('renders a compact batch', () => {
    const md = renderBatch(candidates.slice(0, 2));
    expect(md).toContain('### 1. Odd Bank — Quirky Saver');
    expect(md).toContain('0: VARIABLE 5.33% | (published as "5.33")');
    expect(md).toContain(`reviewKey: ${candidates[0]!.reviewKey}`);
  });

  it('normalises percent-formatted rates', () => {
    expect(normalisedRate('5.33')).toBeCloseTo(0.0533);
    expect(normalisedRate('0.05')).toBe(0.05);
  });
});

describe('composedMax', () => {
  const base: Omit<RowReview, 'index' | 'role'> = {
    combine: 'ADD_TO_BASE',
    alternativeSet: null,
    option: null,
    conditions: [],
    introMonths: null,
    termMonths: null,
    excludeReason: null,
  };
  const review = (rows: ProductReview['rows']): ProductReview => ({
    key: 'k',
    reviewKey: 'r',
    rows,
    defaultRole: null,
    eligibility: { minAge: null, maxAge: null, newCustomersOnly: null, jointAllowed: null, restrictedTo: null, notes: '' },
    statedHeadline: null,
    confidence: 'high',
    notes: '',
  });

  it('adds stacking bonuses and intro', () => {
    const v = composedMax(
      review([
        { ...base, index: 0, role: 'BASE' },
        { ...base, index: 1, role: 'BONUS' },
        { ...base, index: 2, role: 'INTRO' },
      ]),
      introSaver.depositRates!,
    );
    expect(v).toBeCloseTo(0.065);
  });

  it('treats TOTAL_RATE intros as replacing, and alternative sets as choose-one', () => {
    const rates = [
      { depositRateType: 'VARIABLE', rate: '0.037' },
      { depositRateType: 'INTRODUCTORY', rate: '0.058' },
      { depositRateType: 'BONUS', rate: '0.01' },
      { depositRateType: 'BONUS', rate: '0.02' },
    ];
    const v = composedMax(
      review([
        { ...base, index: 0, role: 'BASE' },
        { ...base, index: 1, role: 'INTRO', combine: 'TOTAL_RATE' },
        { ...base, index: 2, role: 'BONUS', alternativeSet: 'age' },
        { ...base, index: 3, role: 'BONUS', alternativeSet: 'age' },
      ]),
      rates,
    );
    expect(v).toBeCloseTo(0.058); // max(0.037 + 0.02, intro total 0.058)
  });

  it('ignores excluded rows', () => {
    const rates = [
      { depositRateType: 'VARIABLE', rate: '0.055' },
      { depositRateType: 'FIXED', rate: '0.115' },
    ];
    expect(composedMax(review([{ ...base, index: 0, role: 'BASE' }, { ...base, index: 1, role: 'EXCLUDE', excludeReason: 'competition' }]), rates)).toBe(0.055);
  });
});

describe('applyAnswers', () => {
  const candidates = buildCandidates(raws);
  const boost = candidates.find((c) => c.productId === 'boost-saver')!;
  const td = candidates.find((c) => c.productId === 'td-noterm')!;

  it('validates, applies with defaults filled in, and warns on mismatches', () => {
    const reviews = emptyReviews();
    const res = applyAnswers(
      {
        reviews: [
          {
            key: boost.key,
            reviewKey: boost.reviewKey,
            rows: [
              { index: 0, role: 'BASE' },
              {
                index: 1,
                role: 'BONUS',
                conditions: [
                  { type: 'MIN_DEPOSIT_AMOUNT', amount: 1000, externalOnly: true },
                  { type: 'MIN_PURCHASES', count: 5 },
                  { type: 'BALANCE_CAP', amount: 250000, period: 'NONE' },
                ],
              },
            ],
            eligibility: { minAge: 18 },
            statedHeadline: 0.065,
          },
          { key: td.key, reviewKey: td.reviewKey, rows: [{ index: 0, role: 'BASE' }] },
        ],
      },
      candidates,
      reviews,
      new Date('2026-11-22T00:00:00Z'),
    );
    expect(res.errors).toEqual([]);
    expect(res.applied).toHaveLength(2);
    expect(res.warnings.some((w) => w.includes('composed 5.80% ≠ stated 6.50%'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('has no term'))).toBe(true);
    const saved = reviews.entries[boost.key]!.review;
    expect(saved.rows[1]!.conditions[1]).toMatchObject({ type: 'MIN_PURCHASES', count: 5, period: 'MONTH', amount: null });
    expect(saved.eligibility).toMatchObject({ minAge: 18, maxAge: null });
  });

  it('fills unlisted rows from defaultRole', () => {
    const tdc = candidates.find((c) => c.productId === 'td-noterm')!;
    const reviews = emptyReviews();
    const res = applyAnswers({ reviews: [{ key: tdc.key, reviewKey: tdc.reviewKey, defaultRole: 'BASE', rows: [] }] }, candidates, reviews);
    expect(res.errors).toEqual([]);
    expect(reviews.entries[tdc.key]!.review.rows).toMatchObject([{ index: 0, role: 'BASE', combine: 'ADD_TO_BASE' }]);
  });

  it('rejects stale keys, unknown products, bad row coverage and schema errors', () => {
    const reviews = emptyReviews();
    const res = applyAnswers(
      {
        reviews: [
          { key: boost.key, reviewKey: 'stale', rows: [] },
          { key: 'nope:1', reviewKey: 'x', rows: [] },
          { key: boost.key, reviewKey: boost.reviewKey, rows: [{ index: 0, role: 'BASE' }] },
        ],
      },
      candidates,
      reviews,
    );
    expect(res.applied).toEqual([]);
    expect(res.errors).toHaveLength(3);
    expect(res.errors[0]).toContain('stale');
    expect(res.errors[1]).toContain('not a current review candidate');
    expect(res.errors[2]).toContain('exactly once');

    const bad = applyAnswers({ reviews: [{ key: boost.key, rows: [{ index: 0, role: 'NOPE' }] }] }, candidates, emptyReviews());
    expect(bad.errors[0]).toContain('schema');
  });
});
