import { describe, expect, it, vi } from 'vitest';
import {
  collectItems,
  emptyCache,
  ExtractionSchema,
  runExtraction,
  type Extraction,
} from '../src/extract/conditions.js';
import { appliesToTerm, savingsHeadline, termRangesMonths } from '../src/rates.js';
import { analyse, renderMarkdown } from '../src/report.js';
import { boostSaver, introSaver, quirky, rawFile, tdNoTerm, termDeposit } from './fixtures/products.js';

const flag = (r: ReturnType<typeof analyse>, code: string) => r.flags.find((f) => f.code === code)!;

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
    expect(report.topSavings[0]!.product).toBe('Quirky Saver'); // the bad 533% rate floats to the top — flagged above
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
