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

/** Term ranges (in months) a term-deposit rate row applies to, from additionalValue or MONTH/DAY tiers. */
export function termRangesMonths(rate: DepositRate): Range[] {
  const fromDuration = durationToMonths(rate.additionalValue);
  if (fromDuration !== null) return [{ min: fromDuration, max: fromDuration }];
  const ranges: Range[] = [];
  for (const tier of rate.tiers ?? []) {
    const months = tierRange(tier, 'MONTH');
    if (months) ranges.push(months);
    const days = tierRange(tier, 'DAY');
    if (days) ranges.push({ min: days.min / 30.4375, max: days.max === null ? null : days.max / 30.4375 });
  }
  return ranges;
}

export function appliesToTerm(rate: DepositRate, months: number, tolerance = 0.5): boolean {
  return termRangesMonths(rate).some((r) =>
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

export interface SavingsHeadline {
  base: number | null;
  bonus: number | null;
  intro: number | null;
  bonusRows: number;
  /** base + best bonus (assumes bonus is additive, per the standard). */
  ongoing: number | null;
  /** ongoing + intro, where an intro rate exists. */
  withIntro: number | null;
}

export function savingsHeadline(rates: DepositRate[]): SavingsHeadline {
  const max = (type: (t: string | undefined) => boolean) => {
    const vals = rates
      .filter((r) => type(r.depositRateType))
      .map((r) => parseRate(r.rate))
      .filter((v): v is number => v !== null);
    return vals.length ? Math.max(...vals) : null;
  };
  const base = max(isBaseType);
  const bonus = max((t) => t === 'BONUS' || t === 'BUNDLE_BONUS');
  const intro = max((t) => t === 'INTRODUCTORY');
  const bonusRows = rates.filter((r) => r.depositRateType === 'BONUS' || r.depositRateType === 'BUNDLE_BONUS').length;
  const ongoing = base === null && bonus === null ? null : (base ?? 0) + (bonus ?? 0);
  const withIntro = intro === null ? null : (ongoing ?? 0) + intro;
  return { base, bonus, intro, bonusRows, ongoing, withIntro };
}
