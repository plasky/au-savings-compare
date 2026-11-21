import { describe, expect, it, vi } from 'vitest';
import {
  collectItems,
  emptyCache,
  ExtractionSchema,
  guardCaller,
  runExtraction,
  type Extraction,
} from '../src/extract/conditions.js';
import { appliesToTerm, isForeignCurrency, isNonPersonal, savingsHeadline, termRangesMonths } from '../src/rates.js';
import { analyse, renderMarkdown } from '../src/report.js';
import { boostSaver, introSaver, quirky, rawFile, tdNoTerm, termDeposit } from './fixtures/products.js';

const flag = (r: ReturnType<typeof analyse>, code: string) => r.flags.find((f) => f.code === code)!;

describe('savingsHeadline at a balance', () => {
  const tier = (min: string, max?: string) => [{ name: 't', unitOfMeasure: 'DOLLAR', minimumValue: min, ...(max ? { maximumValue: max } : {}) }];

  it('stacks distinct bonus rows (Virgin Money Boost Saver pattern)', () => {
    const h = savingsHeadline([
      { depositRateType: 'VARIABLE', rate: '0.0005' },
      { depositRateType: 'BONUS', rate: '0.0050', additionalValue: 'Additional rate when you…', tiers: tier('0.00', '250000.00') },
      { depositRateType: 'BONUS', rate: '0.0575', additionalValue: 'Deposit $1000 and make 5 purchases', tiers: tier('0.00', '250000.00') },
    ]);
    expect(h.bonusRows).toBe(2);
    expect(h.ongoing).toBeCloseTo(0.063);
  });

  it('treats disjoint-tier bonus rows as alternatives (UBank pattern)', () => {
    const text = 'Grow your balance by $1 each month';
    const h = savingsHeadline(
      [
        { depositRateType: 'BONUS', rate: '0.056', additionalValue: text, tiers: tier('0.00', '100000.00') },
        { depositRateType: 'BONUS', rate: '0.056', additionalValue: text, tiers: tier('100000.01', '250000.00') },
        { depositRateType: 'BONUS', rate: '0.0', additionalValue: text, tiers: tier('1000000.01') },
      ],
      50_000,
    );
    expect(h.bonus).toBeCloseTo(0.056);
    expect(h.base).toBeNull();
  });

  it('prefers variable base rows over FIXED promo rows (Bankwest competition pattern)', () => {
    const h = savingsHeadline([
      { depositRateType: 'VARIABLE', rate: '0.055', tiers: tier('0.00', '250000.99') },
      { depositRateType: 'VARIABLE', rate: '0.026', tiers: tier('250001.00', '1000000.99') },
      { depositRateType: 'FIXED', rate: '0.115', additionalInfo: 'Competition winners only', tiers: tier('0.00', '250000.99') },
    ]);
    expect(h.base).toBe(0.055);
    expect(h.baseAlternatives).toBe(1);
  });

  it('counts overlapping base alternatives (Revolut plans pattern)', () => {
    const h = savingsHeadline([
      { depositRateType: 'VARIABLE', rate: '0.03', additionalInfo: 'Standard plan', tiers: tier('0.0', '1000000.0') },
      { depositRateType: 'VARIABLE', rate: '0.0555', additionalInfo: 'Ultra plan', tiers: tier('0.0', '250000.0') },
    ]);
    expect(h.baseAlternatives).toBe(2);
    expect(h.base).toBe(0.0555);
  });
});

describe('product filters', () => {
  it('detects foreign-currency and non-personal products', () => {
    expect(isForeignCurrency('Term Deposit CNY 12M')).toBe(true);
    expect(isForeignCurrency('USD Foreign Currency Account')).toBe(true);
    expect(isForeignCurrency('Bonus Saver')).toBe(false);
    expect(isNonPersonal('High Interest Savings Account (SMSF)')).toBe(true);
    expect(isNonPersonal('Business WebSavings Account')).toBe(true);
    expect(isNonPersonal('Easy Saver', [{ eligibilityType: 'BUSINESS' }])).toBe(true);
    expect(isNonPersonal('Easy Saver', [{ eligibilityType: 'MIN_AGE' }])).toBe(false);
  });
});

describe('guardCaller', () => {
  const ok: Extraction = { noConditions: true, conditions: [], rateSemantics: 'ADDITIVE_TO_BASE', introPeriodMonths: null, confidence: 'high', notes: '' };

  it('stops after a no-credit error', async () => {
    const real = vi.fn(async () => {
      throw Object.assign(new Error('400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'), { status: 400 });
    });
    const g = guardCaller(real);
    await expect(g.callModel('a')).rejects.toThrow(/credit balance/);
    await expect(g.callModel('b')).rejects.toThrow(/no credit/);
    expect(real).toHaveBeenCalledTimes(1);
    expect(g.status()).toBe('no_credit');
  });

  it('stops after a 401', async () => {
    const g = guardCaller(async () => {
      throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
    });
    await expect(g.callModel('a')).rejects.toThrow();
    await expect(g.callModel('b')).rejects.toThrow(/rejected/);
    expect(g.status()).toBe('rejected');
  });

  it('gives up after N initial failures but keeps going once anything succeeds', async () => {
    let n = 0;
    const g = guardCaller(async () => {
      n++;
      throw new Error('overloaded');
    }, 3);
    for (let i = 0; i < 5; i++) await g.callModel('x').catch(() => undefined);
    expect(n).toBe(3);
    expect(g.status()).toBe('failing');

    const g2 = guardCaller(async () => ok);
    await g2.callModel('x');
    expect(g2.status()).toBe('ok');
  });
});

describe('rates helpers', () => {
  it('computes savings headlines', () => {
    const h = savingsHeadline(introSaver.depositRates!);
    expect(h.base).toBe(0.0055);
    expect(h.bonus).toBe(0.0535);
    expect(h.ongoing).toBeCloseTo(0.059);
    expect(h.withIntro).toBeCloseTo(0.065);
  });
  it('identifies term-deposit terms from durations and tiers', () => {
    const [m12, y1, m6, tiered] = termDeposit.depositRates!;
    expect(appliesToTerm(m12!, 12)).toBe(true);
    expect(appliesToTerm(y1!, 12)).toBe(true);
    expect(appliesToTerm(m6!, 12)).toBe(false);
    expect(appliesToTerm(tiered!, 30)).toBe(true);
    expect(appliesToTerm(tiered!, 12)).toBe(false);
    expect(termRangesMonths(tdNoTerm.depositRates![0]!)).toEqual([]);
  });
});

describe('analyse', () => {
  const raws = [rawFile('example', [boostSaver, introSaver, termDeposit]), rawFile('odd', [quirky, tdNoTerm])];
  const report = analyse(raws, null, null, new Date('2026-11-22T00:00:00Z'));

  it('counts products and rate rows', () => {
    expect(report.products.byCategory).toEqual({ TRANS_AND_SAVINGS_ACCOUNTS: 3, TERM_DEPOSITS: 2 });
    expect(report.rates.rowsByType.TRANS_AND_SAVINGS_ACCOUNTS).toMatchObject({ VARIABLE: 3, BONUS: 4, INTRODUCTORY: 2 });
  });

  it('classifies bonus rows by structured vs free text', () => {
    expect(report.bonus).toMatchObject({ rows: 4, withStructured: 1, freeTextOnly: 3, structuredOnly: 0, neither: 0 });
    expect(report.bonus.conditionTypes).toEqual({ MIN_DEPOSIT_AMOUNT: 1, MIN_PURCHASES: 1 });
  });

  it('raises the known data-quality flags', () => {
    expect(flag(report, 'RATE_LOOKS_LIKE_PERCENT').count).toBe(1);
    expect(flag(report, 'DUPLICATE_RATE_ROWS').count).toBe(1);
    expect(flag(report, 'INTRO_WITHOUT_DURATION').count).toBe(1);
    expect(flag(report, 'TIER_MAX_ZERO').count).toBe(1);
    expect(flag(report, 'TIER_NUMERIC_VALUES').count).toBe(1);
    expect(flag(report, 'TIER_LEGACY_CONDITIONS').count).toBe(1);
    expect(flag(report, 'TD_RATE_WITHOUT_TERM').count).toBe(1);
    expect(flag(report, 'HEADLINE_IMPLAUSIBLE').count).toBe(1);
    expect(flag(report, 'RATE_UNPARSEABLE').count).toBe(0);
    expect(flag(report, 'TD_RATE_WITHOUT_TERM').examples[0]).toContain('Mystery TD');
  });

  it('ranks top savings and 12-month TDs', () => {
    // Quirky Saver's percent-formatted rate excludes it from the ranking (it's flagged instead).
    expect(report.topSavings.map((t) => t.product)).toEqual(['Intro Saver', 'Boost Saver']);
    expect(report.topSavings[0]!.headline).toBeCloseTo(0.065);
    expect(report.topTd12).toHaveLength(1);
    expect(report.topTd12[0]).toMatchObject({ product: 'Term Deposit', headline: 0.053, note: 'at maturity' });
    expect(report.td12Coverage).toEqual({ products: 2, with12m: 1 });
  });

  it('renders markdown', () => {
    const md = renderMarkdown(report);
    expect(md).toContain('# CDR product data — crawl report');
    expect(md).toContain('RATE_LOOKS_LIKE_PERCENT');
    expect(md).toContain('Top 12-month term deposits');
  });
});

describe('condition extraction', () => {
  const raws = [rawFile('example', [boostSaver, introSaver, termDeposit]), rawFile('odd', [quirky])];

  it('collects one item per bonus/intro row with free text, de-duplicated', () => {
    const { items, structuredOnly, noInformation } = collectItems(raws);
    // boost bonus, intro-saver bonus, intro-saver intro, quirky bonus (x2 identical → 1), quirky intro
    expect(items).toHaveLength(5);
    const dup = items.find((i) => i.contexts.length === 2)!;
    expect(dup.input).toContain('Deposit $500 each month');
    expect(structuredOnly + noInformation).toBe(0);
    const boost = items.find((i) => i.input.includes('Boost Saver'))!;
    expect(boost.input).toContain('Structured conditions published by the bank: MIN_DEPOSIT_AMOUNT (1000); MIN_PURCHASES (5)');
    expect(boost.input).toContain('$0–$250,000 (WHOLE_BALANCE)');
    expect(items.find((i) => i.input.includes('INTRODUCTORY 0.60%'))!.input).toContain('Published introductory duration: 4 months');
  });

  it('calls the model only for uncached items and keeps failures out of the cache', async () => {
    const { items } = collectItems(raws);
    const fake: Extraction = {
      noConditions: false,
      conditions: [
        { type: 'MIN_DEPOSIT_AMOUNT', amount: 1000, count: null, minAge: null, maxAge: null, period: 'MONTH', externalOnly: true, description: 'Deposit $1,000 monthly' },
      ],
      rateSemantics: 'ADDITIVE_TO_BASE',
      introPeriodMonths: null,
      confidence: 'high',
      notes: '',
    };
    expect(ExtractionSchema.parse(fake)).toEqual(fake);

    const cache = emptyCache();
    cache.entries[items[0]!.key] = { extraction: fake, extractedAt: '2026-11-21T00:00:00Z' };
    cache.entries['stale-key'] = { extraction: fake, extractedAt: '2026-01-01T00:00:00Z' };
    const callModel = vi.fn(async (input: string) => {
      if (input.includes('Quirky')) throw new Error('boom');
      return fake;
    });
    const { output, cache: next } = await runExtraction({ items, cache, callModel, now: () => new Date('2026-11-22T00:00:00Z') });
    expect(output.stats).toMatchObject({ items: 5, cached: 1, called: 4, failed: 2 });
    expect(callModel).toHaveBeenCalledTimes(4);
    expect(Object.keys(next.entries)).toHaveLength(3);
    expect(next.entries['stale-key']).toBeUndefined();

    const report = analyse(raws, null, output);
    expect(report.extraction).toMatchObject({ items: 5, extracted: 3, failed: 2 });
    expect(report.extraction!.agreement.itemsWithStructured).toBeGreaterThanOrEqual(1);
  });
});
