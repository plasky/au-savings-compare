import { ADJUSTMENT_DEPOSIT_RATE_TYPES, BASE_DEPOSIT_RATE_TYPES } from './config.js';
import type { DepositRate, RateCondition, RateTier } from './types.js';
import { durationToMonths, isIsoDuration, parseAmount, parseRate, toArray } from './util.js';

export const KNOWN_DEPOSIT_RATE_TYPES = [...BASE_DEPOSIT_RATE_TYPES, ...ADJUSTMENT_DEPOSIT_RATE_TYPES] as readonly string[];

export function isBaseType(t: string | undefined): boolean {
  return !!t && (BASE_DEPOSIT_RATE_TYPES as readonly string[]).includes(t);
}

export function rateConditions(rate: DepositRate): RateCondition[] {
  return toArray(rate.applicabilityConditions).filter((c) => !!c && typeof c === 'object');
}

export function tierConditions(tier: RateTier): RateCondition[] {
  return toArray(tier.applicabilityConditions).filter((c) => !!c && typeof c === 'object');
}

/** Structured condition types at rate and tier level (OTHER included). */
export function structuredConditionTypes(rate: DepositRate): string[] {
  const types = new Set<string>();
  for (const c of rateConditions(rate)) if (c.rateApplicabilityType) types.add(c.rateApplicabilityType);
  for (const t of rate.tiers ?? []) for (const c of tierConditions(t)) if (c.rateApplicabilityType) types.add(c.rateApplicabilityType);
  return [...types].sort();
}

/** Free text a bank attached to a rate row: description, info, condition and tier notes. */
export function freeTextParts(rate: DepositRate): string[] {
  const parts: string[] = [];
  const av = rate.additionalValue;
  if (typeof av === 'string' && av.trim() && !isIsoDuration(av)) parts.push(av.trim());
  if (rate.additionalInfo?.trim()) parts.push(rate.additionalInfo.trim());
  for (const c of rateConditions(rate)) if (c.additionalInfo?.trim()) parts.push(c.additionalInfo.trim());
  for (const t of rate.tiers ?? []) {
    if (t.additionalInfo?.trim()) parts.push(t.additionalInfo.trim());
    for (const c of tierConditions(t)) if (c.additionalInfo?.trim()) parts.push(c.additionalInfo.trim());
  }
  return [...new Set(parts)];
}

export interface Range {
  min: number;
  max: number | null;
}

function tierRange(tier: RateTier, unit: string): Range | null {
  if ((tier.unitOfMeasure ?? '').toUpperCase() !== unit) return null;
  const min = parseAmount(tier.minimumValue);
  if (min === null) return null;
  const max = parseAmount(tier.maximumValue);
  return { min, max: max === null || max === 0 ? null : max };
}

const TERM_TEXT_RE = /(\d+(?:\.\d+)?)\s*-?\s*(years?|yrs?|y|months?|mths?|mo|m|days?|d)\b/i;

/** Parse a single term ("12 Month", "12M", "1 year", "90 days") from free text, in months. */
export function termFromText(text: string | undefined | null): number | null {
  if (!text) return null;
  const m = TERM_TEXT_RE.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  if (!Number.isFinite(n) || n <= 0) return null;
  const months = unit.startsWith('y') ? n * 12 : unit.startsWith('d') ? n / 30.4375 : n;
  // Reject implausible terms (e.g. "$5m" amounts read as months).
  if (months > 120) return null;
  return Math.round(months * 100) / 100;
}

/**
 * Term ranges (in months) a term-deposit rate row applies to: from the ISO
 * duration in additionalValue, MONTH/DAY tiers, the row's own text, and
 * finally `fallbackText` (typically the product name, e.g. "12 Month Term Deposit").
 */
export function termRangesMonths(rate: DepositRate, fallbackText?: string): Range[] {
  const fromDuration = durationToMonths(rate.additionalValue);
  if (fromDuration !== null) return [{ min: fromDuration, max: fromDuration }];
  const ranges: Range[] = [];
  for (const tier of rate.tiers ?? []) {
    const months = tierRange(tier, 'MONTH');
    if (months) ranges.push(months);
    const days = tierRange(tier, 'DAY');
    if (days) ranges.push({ min: days.min / 30.4375, max: days.max === null ? null : days.max / 30.4375 });
  }
  if (ranges.length) return ranges;
  const av = typeof rate.additionalValue === 'string' ? rate.additionalValue : undefined;
  const fromText = termFromText(av) ?? termFromText(rate.additionalInfo) ?? termFromText(fallbackText);
  return fromText !== null ? [{ min: fromText, max: fromText }] : [];
}

export function appliesToTerm(rate: DepositRate, months: number, tolerance = 0.5, fallbackText?: string): boolean {
  return termRangesMonths(rate, fallbackText).some((r) =>
    r.max !== null && r.max === r.min
      ? Math.abs(r.min - months) <= tolerance
      : r.min - tolerance <= months && (r.max === null || months <= r.max + tolerance),
  );
}

export function describeTiers(rate: DepositRate): string {
  return (rate.tiers ?? [])
    .map((t) => {
      const unit = (t.unitOfMeasure ?? '').toUpperCase();
      const min = parseAmount(t.minimumValue);
      const max = parseAmount(t.maximumValue);
      const fmt = (v: number | null) =>
        v === null ? '∞' : unit === 'DOLLAR' ? `$${v.toLocaleString('en-AU')}` : `${v}${unit ? ` ${unit.toLowerCase()}` : ''}`;
      const method = t.rateApplicationMethod ? ` (${t.rateApplicationMethod})` : '';
      return `${t.name ? `${t.name}: ` : ''}${fmt(min)}–${fmt(max === 0 ? null : max)}${method}`;
    })
    .join('; ');
}

/** Whether a rate row applies at a given balance, judged by its DOLLAR tiers (no DOLLAR tiers = applies). */
export function appliesAtBalance(rate: DepositRate, balance: number): boolean {
  const dollarTiers = (rate.tiers ?? []).filter((t) => (t.unitOfMeasure ?? '').toUpperCase() === 'DOLLAR');
  if (dollarTiers.length === 0) return true;
  return dollarTiers.some((t) => {
    const min = parseAmount(t.minimumValue) ?? 0;
    const rawMax = parseAmount(t.maximumValue);
    const max = rawMax === null || rawMax === 0 ? Number.POSITIVE_INFINITY : rawMax;
    return balance >= min && balance <= max;
  });
}

export interface SavingsHeadline {
  balance: number;
  base: number | null;
  /** Sum of distinct bonus rows applying at this balance (bonuses with different conditions stack). */
  bonus: number | null;
  intro: number | null;
  bonusRows: number;
  /** Distinct base rates applying at this balance; >1 means plan/eligibility alternatives. */
  baseAlternatives: number;
  /** base + stacked bonuses (assumes additive, per the standard). */
  ongoing: number | null;
  /** ongoing + intro, where an intro rate exists. */
  withIntro: number | null;
}

/**
 * Indicative headline rates at a reference balance. Rows apply by DOLLAR
 * tier; distinct bonus rows that apply at the same balance are summed (e.g.
 * Virgin Money Boost Saver: 0.05% + 0.50% + 5.75% = 6.30%); overlapping base
 * rows are alternatives (plans, special eligibility) and the best VARIABLE/
 * FLOATING one is preferred over FIXED promotional rows. This is a diagnostic
 * approximation; the engine (phase 1) will evaluate conditions properly.
 */
export function savingsHeadline(rates: DepositRate[], balance = 10_000): SavingsHeadline {
  const applicable = rates
    .filter((r) => appliesAtBalance(r, balance))
    .map((r) => ({ r, v: parseRate(r.rate) }))
    .filter((x): x is { r: DepositRate; v: number } => x.v !== null);

  const bases = applicable.filter((x) => isBaseType(x.r.depositRateType));
  const preferred = bases.filter((x) => x.r.depositRateType !== 'FIXED');
  const baseVals = (preferred.length ? preferred : bases).map((x) => x.v);
  const base = baseVals.length ? Math.max(...baseVals) : null;
  const baseAlternatives = new Set(baseVals).size;

  const seenBonus = new Set<string>();
  const bonusVals: number[] = [];
  for (const x of applicable) {
    if (x.r.depositRateType !== 'BONUS' && x.r.depositRateType !== 'BUNDLE_BONUS') continue;
    const sig = `${x.v}|${freeTextParts(x.r).join('|')}|${structuredConditionTypes(x.r).join(',')}`;
    if (seenBonus.has(sig)) continue;
    seenBonus.add(sig);
    bonusVals.push(x.v);
  }
  const bonus = bonusVals.length ? bonusVals.reduce((a, b) => a + b, 0) : null;

  const introVals = applicable.filter((x) => x.r.depositRateType === 'INTRODUCTORY').map((x) => x.v);
  const intro = introVals.length ? Math.max(...introVals) : null;

  const ongoing = base === null && bonus === null ? null : (base ?? 0) + (bonus ?? 0);
  const withIntro = intro === null ? null : (ongoing ?? 0) + intro;
  return { balance, base, bonus, intro, bonusRows: bonusVals.length, baseAlternatives, ongoing, withIntro };
}

const FOREIGN_CURRENCY_RE = /\b(USD|CNY|RMB|EUR|GBP|NZD|JPY|HKD|SGD|CAD|CHF|INR)\b|foreign currency/i;
const BUSINESS_RE = /\b(business|smsf|self[- ]managed super|trust|corporate|commercial|community|club|not[- ]for[- ]profit|farm)\b/i;

/** Product looks like a non-AUD (foreign-currency) product. */
export function isForeignCurrency(name: string | undefined, description?: string): boolean {
  return FOREIGN_CURRENCY_RE.test(`${name ?? ''} ${description ?? ''}`);
}

/** Product looks aimed at businesses, SMSFs, trusts or organisations rather than individuals. */
const SUPER_RE = /\b(superannuation|super fund|guaranteed super|pension account)\b/i;

/** Description wording that marks an account as for organisations or super funds rather than people. */
const ORGANISATION_RE =
  /\b(not[- ]for[- ]profit|charit(?:y|ies|able)|community organisations?|(?:for|to) (?:businesses|organisations|clubs|associations|body corporates?)|incorporated associations?|self[- ]managed super)\b/i;

export function isNonPersonal(
  name: string | undefined,
  eligibility?: Array<{ eligibilityType?: string }>,
  description?: string,
): boolean {
  if ((eligibility ?? []).some((e) => e.eligibilityType === 'BUSINESS')) return true;
  return BUSINESS_RE.test(name ?? '') || SUPER_RE.test(name ?? '') || ORGANISATION_RE.test(description ?? '');
}

const RESTRICTED_NAME_RE = /\b(kids?|junior|youth|teens?|child(?:ren)?(?:'s)?|students?|pensioners?|seniors?|retire(?:e|es|ment)|over\s?55|55\s?\+|staff|broker|long service leave)\b/i;

/** Audience restriction implied by a product name (for products without a review). */
export function restrictionFromName(name: string | undefined): string | null {
  const m = RESTRICTED_NAME_RE.exec(name ?? '');
  return m ? `Name suggests a restricted audience ("${m[1]}")` : null;
}
