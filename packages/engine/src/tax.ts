import type { TaxRules } from './types.js';

/**
 * Australian resident individual tax rules by financial year.
 * Later years without published rules reuse the latest known year
 * (no bracket indexation is legislated).
 */
export const TAX_RULES: TaxRules[] = [
  {
    fy: '2026-27',
    brackets: [
      { from: 0, rate: 0 },
      { from: 18_200, rate: 0.15 },
      { from: 45_000, rate: 0.3 },
      { from: 135_000, rate: 0.37 },
      { from: 190_000, rate: 0.45 },
    ],
    lito: { max: 700, fullTo: 37_500, firstTaperTo: 45_000, firstTaper: 0.05, secondTaper: 0.015 },
    medicare: { rate: 0.02, lowerThreshold: 28_011, phaseInRate: 0.1 },
    sources: [
      'https://www.ato.gov.au/tax-rates-and-codes/tax-rates-australian-residents',
      'https://ato.gov.au/about-ato/new-legislation/in-detail/individuals/personal-income-tax-new-tax-cuts-for-every-australian-taxpayer',
      'https://www.ato.gov.au/individuals-and-families/medicare-and-private-health-insurance/medicare-levy/medicare-levy-reduction/medicare-levy-reduction-for-low-income-earners',
    ],
    notes: 'Medicare low-income threshold is the 2025-26 singles figure; 2026-27 thresholds are set in a later Budget.',
  },
  {
    fy: '2027-28',
    brackets: [
      { from: 0, rate: 0 },
      { from: 18_200, rate: 0.14 },
      { from: 45_000, rate: 0.3 },
      { from: 135_000, rate: 0.37 },
      { from: 190_000, rate: 0.45 },
    ],
    lito: { max: 700, fullTo: 37_500, firstTaperTo: 45_000, firstTaper: 0.05, secondTaper: 0.015 },
    medicare: { rate: 0.02, lowerThreshold: 28_011, phaseInRate: 0.1 },
    sources: ['https://ato.gov.au/about-ato/new-legislation/in-detail/individuals/personal-income-tax-new-tax-cuts-for-every-australian-taxpayer'],
    notes: '16% → 15% (1 Jul 2026) → 14% (1 Jul 2027) is legislated; other thresholds assumed unchanged.',
  },
];

/** Financial year label for a date: July–June, e.g. 2026-11-01 → "2026-27". */
export function fyOf(date: Date): string {
  const y = date.getUTCFullYear();
  const start = date.getUTCMonth() >= 6 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function fyStartYear(fy: string): number {
  return Number(fy.slice(0, 4));
}

/** Rules for a financial year: exact match, else the latest earlier year, else the earliest known. */
export function rulesFor(fy: string, rules: TaxRules[] = TAX_RULES): TaxRules {
  const sorted = [...rules].sort((a, b) => a.fy.localeCompare(b.fy));
  let chosen = sorted[0]!;
  for (const r of sorted) if (r.fy <= fy) chosen = r;
  return chosen;
}

export interface TaxBreakdown {
  incomeTax: number;
  lito: number;
  medicare: number;
  /** Income tax after LITO (non-refundable) plus Medicare levy. */
  total: number;
}

export function incomeTax(taxable: number, rules: TaxRules): TaxBreakdown {
  const income = Math.max(0, taxable);
  let tax = 0;
  rules.brackets.forEach((b, i) => {
    const next = rules.brackets[i + 1]?.from ?? Number.POSITIVE_INFINITY;
    if (income > b.from) tax += (Math.min(income, next) - b.from) * b.rate;
  });
  const l = rules.lito;
  let lito = l.max;
  if (income > l.fullTo) lito -= (Math.min(income, l.firstTaperTo) - l.fullTo) * l.firstTaper;
  if (income > l.firstTaperTo) lito -= (income - l.firstTaperTo) * l.secondTaper;
  lito = Math.max(0, lito);
  const appliedLito = Math.min(lito, tax);
  const m = rules.medicare;
  const medicare = Math.max(0, Math.min(income * m.rate, (income - m.lowerThreshold) * m.phaseInRate));
  return { incomeTax: tax, lito: appliedLito, medicare, total: tax - appliedLito + medicare };
}

/** Extra tax (incl. Medicare levy) caused by adding `extra` income on top of `base`. */
export function incrementalTax(base: number, extra: number, rules: TaxRules): number {
  return incomeTax(base + extra, rules).total - incomeTax(base, rules).total;
}

/** Effective marginal rate on the next dollar (useful for display). */
export function marginalRate(base: number, rules: TaxRules): number {
  return incrementalTax(base, 100, rules) / 100;
}
