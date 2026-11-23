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

// Bendigo Reward Saver, 23 Nov 2026: one 5.15% bonus published twice, split by age only in words.
const ageSplit: ProductDetail = {
  productId: 'reward',
  name: 'Reward Saver',
  brandName: 'Bendigo Bank',
  productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
  lastUpdated: '2026-11-22T13:33:22Z',
  depositRates: [
    { depositRateType: 'VARIABLE', rate: '0.001' },
    {
      depositRateType: 'BONUS',
      rate: '0.0515',
      additionalValue: 'For customers 31 years old or older Subject to eligibility criteria being met',
      applicabilityConditions: [{ rateApplicabilityType: 'DEPOSIT_BALANCE_INCREASED', additionalValue: '0.01' }],
    },
    {
      depositRateType: 'BONUS',
      rate: '0.0515',
      additionalValue: 'For customers 30 years old or younger, subject to eligibility criteria being met',
      applicabilityConditions: [{ rateApplicabilityType: 'DEPOSIT_BALANCE_INCREASED', additionalValue: '0.01' }],
    },
  ],
};
const grows = (p: Product, age: number) =>
  simulate({
    startDate: '2026-12-01',
    months: 1,
    people: [{ id: 'p1', age, taxableIncome: 100_000 }],
    accounts: [{ kind: 'savings', id: 'a', product: p, owners: { p1: 1 }, openingBalance: 10_000, behaviour: { monthlyDeposit: 100 } }],
  }).months[0]!.accounts.a!;

describe('bonus rows split by something only the words say', () => {
  it('reads an age band from the row text, so only one bonus applies (not 10.40%)', () => {
    const p = norm(ageSplit);
    const ages = p.rows.filter((r) => r.role === 'BONUS').map((r) => r.conditions.find((c) => c.type === 'AGE_RANGE'));
    expect(ages.map((a) => [a?.minAge, a?.maxAge])).toEqual([
      [31, null],
      [null, 30],
    ]);
    expect(grows(p, 40).bonus).toBeCloseTo(grows(p, 25).bonus, 2);
    const rate = (grows(p, 40).interest / 10_000) * (365 / 31);
    expect(rate).toBeGreaterThan(0.05);
    expect(rate).toBeLessThan(0.056);
  });

  it('treats exact duplicate bonus rows as one bonus', () => {
    const strip = (r: NonNullable<ProductDetail['depositRates']>[number]) => ({ ...r, additionalValue: 'Subject to eligibility criteria being met' });
    const p = norm({ ...ageSplit, depositRates: ageSplit.depositRates!.map(strip) });
    const bonuses = p.rows.filter((r) => r.role === 'BONUS');
    expect(new Set(bonuses.map((r) => r.alternativeSet))).toEqual(new Set(['bonus (auto 1)']));
    expect(p.notes.join(' ')).toContain('Identical bonus rows');
    const rate = (grows(p, 40).interest / 10_000) * (365 / 31);
    expect(rate).toBeLessThan(0.056);
  });
});

describe('hand reviews after a rate change', () => {
  const answers = {
    reviews: [
      {
        key: 'bank:reward',
        reviewKey: '',
        defaultRole: null,
        rows: [
          { index: 0, role: 'BASE', combine: 'ADD_TO_BASE', alternativeSet: null, option: null, conditions: [], introMonths: null, termMonths: null, excludeReason: null },
          ...[1, 2].map((index) => ({
            index,
            role: 'BONUS',
            combine: 'ADD_TO_BASE',
            alternativeSet: 'age',
            option: index === 1 ? '31 and over' : '30 and under',
            conditions: [{ type: 'DEPOSIT_BALANCE_INCREASED', amount: null, count: null, period: 'MONTH', externalOnly: false, minAge: null, maxAge: null, description: '' }],
            introMonths: null,
            termMonths: null,
            excludeReason: null,
          })),
        ],
        eligibility: { minAge: null, maxAge: null, newCustomersOnly: null, jointAllowed: null, restrictedTo: null, notes: '' },
        statedHeadline: null,
        confidence: 'high',
        notes: 'The two bonus rows are the same rate split by age, not stacking.',
      },
    ],
  };
  const reviewed = () => {
    const reviews = emptyReviews();
    const candidates = buildCandidates([rawFile('bank', [ageSplit])]);
    answers.reviews[0]!.reviewKey = candidates[0]!.reviewKey;
    const res = applyAnswers(answers, candidates, reviews);
    if (res.errors.length) throw new Error(res.errors.join('; '));
    return reviews;
  };

  it('keeps the review when only rates change', () => {
    const newRates = { ...ageSplit, depositRates: ageSplit.depositRates!.map((r) => (r.depositRateType === 'BONUS' ? { ...r, rate: '0.0525' } : r)) };
    const p = norm(newRates, reviewed());
    expect(p.reviewed).toBe(true);
    expect(p.rows.filter((r) => r.role === 'BONUS').every((r) => r.alternativeSet === 'age' && r.rate === 0.0525)).toBe(true);
    expect(p.notes[0]).toContain('Rates changed since the hand check');
  });

  it('drops the review (and its notes) when the rows change in another way', () => {
    const rewritten = { ...ageSplit, depositRates: [...ageSplit.depositRates!, { depositRateType: 'BONUS', rate: '0.01', additionalInfo: 'New loyalty bonus' }] };
    const p = norm(rewritten, reviewed());
    expect(p.reviewed).toBe(false);
    expect(p.notes.join(' ')).not.toContain('split by age');
    expect(p.notes[0]).toContain('changed this account since it was checked by hand');
  });
});

// Bankwest Easy Saver, 23 Nov 2026: an 11.5% competition-prize rate and "selected customers" bonuses,
// with their conditions on the balance tiers rather than the row.
const prizeRow = {
  depositRateType: 'FIXED',
  rate: '0.115',
  tiers: [
    {
      name: 'Amount',
      unitOfMeasure: 'DOLLAR',
      minimumValue: '0.00',
      maximumValue: '250000.99',
      rateApplicationMethod: 'PER_TIER',
      applicabilityConditions: [{ rateApplicabilityType: 'NEW_ACCOUNTS' }, { rateApplicabilityType: 'OTHER', additionalInfo: 'Available only to eligible winners of the Interesting Rates competition' }],
    },
  ],
  additionalInfo: 'Available only to eligible winners of the Interesting Rates Competition.',
};
const easySaver: ProductDetail = {
  productId: 'easy',
  name: 'Easy Saver',
  brandName: 'Bankwest',
  productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
  depositRates: [
    { depositRateType: 'VARIABLE', rate: '0.055', tiers: [{ name: 'Amount', unitOfMeasure: 'DOLLAR', minimumValue: '0.00', maximumValue: '250000.99', rateApplicationMethod: 'PER_TIER' }] },
    prizeRow,
    {
      depositRateType: 'BONUS',
      rate: '0.001',
      additionalInfo: 'Bonus rates available from time to time for selected customers, bonus rates applied may vary.',
      tiers: [{ name: 'Amount', unitOfMeasure: 'DOLLAR', minimumValue: '0.00', maximumValue: '250000.99', rateApplicationMethod: 'PER_TIER', applicabilityConditions: [{ rateApplicabilityType: 'EXISTING_CUST' }] }],
    },
    {
      depositRateType: 'INTRODUCTORY',
      rate: '0.0075',
      additionalInfo: '4 month variable introductory rate',
      tiers: [{ name: 'Amount', unitOfMeasure: 'DOLLAR', minimumValue: '0.00', maximumValue: '250000.99', rateApplicationMethod: 'PER_TIER', applicabilityConditions: [{ rateApplicabilityType: 'NEW_ACCOUNTS', additionalInfo: 'Only applies to new accounts.' }] }],
    },
  ],
};

describe('unreviewed prize rates and tier-level conditions', () => {
  it('leaves out competition and selected-customer rates, and reads conditions on tiers', () => {
    const p = norm(easySaver);
    expect(p.rows.map((r) => [r.role, r.rate])).toEqual([
      ['BASE', 0.055],
      ['INTRO', 0.0075],
    ]);
    expect(p.rows[1]!.conditions.map((c) => c.type)).toEqual(['NEW_CUSTOMER']);
    expect(p.notes.join(' ')).toContain('competition winners or selected customers');
  });

  it('leaves out any unreviewed rate above 10%', () => {
    const p = norm({ ...easySaver, depositRates: [easySaver.depositRates![0]!, { ...prizeRow, additionalInfo: 'Promotional rate', tiers: [{ ...prizeRow.tiers[0]!, applicabilityConditions: [] }] }] });
    expect(p.rows.map((r) => r.rate)).toEqual([0.055]);
    expect(p.notes.join(' ')).toContain('above 10%');
  });

  it('keeps a hand review when the bank only rewords rows or adds a label', () => {
    const reviews = emptyReviews();
    const candidates = buildCandidates([rawFile('bank', [easySaver])]);
    const res = applyAnswers(
      {
        reviews: [
          {
            key: 'bank:easy',
            reviewKey: candidates[0]!.reviewKey,
            defaultRole: null,
            rows: [
              { index: 0, role: 'BASE', combine: 'ADD_TO_BASE', alternativeSet: null, option: null, conditions: [], introMonths: null, termMonths: null, excludeReason: null },
              { index: 1, role: 'EXCLUDE', combine: 'ADD_TO_BASE', alternativeSet: null, option: null, conditions: [], introMonths: null, termMonths: null, excludeReason: 'competition prize' },
              { index: 2, role: 'EXCLUDE', combine: 'ADD_TO_BASE', alternativeSet: null, option: null, conditions: [], introMonths: null, termMonths: null, excludeReason: 'discretionary' },
              { index: 3, role: 'INTRO', combine: 'ADD_TO_BASE', alternativeSet: null, option: null, conditions: [], introMonths: 4, termMonths: null, excludeReason: null },
            ],
            eligibility: { minAge: null, maxAge: null, newCustomersOnly: null, jointAllowed: null, restrictedTo: null, notes: '' },
            statedHeadline: null,
            confidence: 'high',
            notes: 'Prize and discretionary rows excluded.',
          },
        ],
      },
      candidates,
      reviews,
    );
    expect(res.errors).toEqual([]);
    const reworded: ProductDetail = {
      ...easySaver,
      depositRates: easySaver.depositRates!.map((r) =>
        r.depositRateType === 'INTRODUCTORY' ? { ...r, additionalValue: 'P4M', additionalInfo: '4-month variable introductory rate' } : r,
      ),
    };
    const p = norm(reworded, reviews);
    expect(p.reviewed).toBe(true);
    expect(p.rows.map((r) => [r.role, r.rate])).toEqual([
      ['BASE', 0.055],
      ['INTRO', 0.0075],
    ]);
    expect(p.notes[0]).toContain('reworded');
  });
});
