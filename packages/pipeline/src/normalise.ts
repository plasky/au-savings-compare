/**
 * Raw CDR product detail + curated review → engine Product.
 * Reviewed products use the review's row roles/conditions (aligned by row
 * content, so reordering by the bank is harmless). Unreviewed products fall
 * back to the CDR labels and structured conditions.
 */
import type { Condition, ConditionType, Product, RateRow, Tier } from '@asc/engine';
import { ageRangeFromText, isBaseType, isForeignCurrency, isNonPersonal, rateConditions, freeTextParts, restrictionFromName, termRangesMonths } from './rates.js';
import { matchReview, rowSignature, stableStringify, type ReviewsFile, type RowReview } from './review/review.js';
import type { DepositRate, ProductDetail, RawEndpointFile, RawProduct } from './types.js';
import { durationToMonths, isIsoDuration, parseAmount, parseRate, truncate } from './util.js';

const CDR_TO_ENGINE: Record<string, ConditionType> = {
  MIN_DEPOSIT_AMOUNT: 'MIN_DEPOSIT_AMOUNT',
  MIN_DEPOSITS: 'MIN_DEPOSITS',
  MIN_PURCHASES: 'MIN_PURCHASES',
  DEPOSIT_BALANCE_INCREASED: 'DEPOSIT_BALANCE_INCREASED',
  MAX_WITHDRAWALS: 'MAX_WITHDRAWALS',
  MAX_WITHDRAWAL_AMOUNT: 'MAX_WITHDRAWAL_AMOUNT',
  NEW_CUSTOMER: 'NEW_CUSTOMER',
  NEW_CUSTOMER_TO_GROUP: 'NEW_CUSTOMER',
  NEW_ACCOUNTS: 'NEW_CUSTOMER',
  EXISTING_CUST: 'EXISTING_CUSTOMER',
  ONLINE_ONLY: 'ONLINE_ONLY',
  OTHER: 'OTHER',
};

function blankCondition(type: ConditionType, description = ''): Condition {
  return { type, amount: null, count: null, minAge: null, maxAge: null, period: 'MONTH', externalOnly: null, description };
}

/** Structured CDR conditions for an unreviewed row; free-text-only bonuses become an OTHER condition. */
function cdrConditions(r: DepositRate): Condition[] {
  const out: Condition[] = [];
  for (const c of rateConditions(r)) {
    const type = CDR_TO_ENGINE[c.rateApplicabilityType ?? ''];
    if (!type) continue;
    const cond = blankCondition(type, c.additionalInfo ? truncate(c.additionalInfo, 120) : '');
    const v = parseAmount(c.additionalValue);
    if (['MIN_DEPOSITS', 'MIN_PURCHASES', 'MAX_WITHDRAWALS'].includes(type)) cond.count = v;
    else if (['MIN_DEPOSIT_AMOUNT', 'DEPOSIT_BALANCE_INCREASED', 'MAX_WITHDRAWAL_AMOUNT'].includes(type)) cond.amount = v;
    if (['NEW_CUSTOMER', 'EXISTING_CUSTOMER', 'ONLINE_ONLY'].includes(type)) cond.period = 'ONCE';
    out.push(cond);
  }
  const role = r.depositRateType;
  if ((role === 'BONUS' || role === 'BUNDLE_BONUS') && out.length === 0) {
    const text = freeTextParts(r).join(' / ');
    out.push(blankCondition('OTHER', text ? `Unstructured: ${truncate(text, 160)}` : 'Conditions not published'));
  }
  return out;
}

function dollarTiers(r: DepositRate): { tiers: Tier[]; method: RateRow['method'] } {
  const ts = (r.tiers ?? []).filter((t) => (t.unitOfMeasure ?? '').toUpperCase() === 'DOLLAR');
  const tiers = ts
    .map((t) => {
      const min = parseAmount(t.minimumValue) ?? 0;
      const max = parseAmount(t.maximumValue);
      return { min, max: max === null || max === 0 ? null : max };
    })
    .filter((t) => t.max === null || t.max >= t.min);
  const method = ts[0]?.rateApplicationMethod === 'PER_TIER' ? 'PER_TIER' : 'WHOLE_BALANCE';
  return { tiers, method };
}

function payment(r: DepositRate): RateRow['payment'] {
  if (r.applicationType === 'MATURITY') return { type: 'MATURITY', everyMonths: null };
  if (r.applicationType === 'UPFRONT') return { type: 'UPFRONT', everyMonths: null };
  if (r.applicationType === 'PERIODIC') {
    const m = durationToMonths(r.applicationFrequency);
    return { type: 'PERIODIC', everyMonths: m === null ? null : Math.max(1, Math.round(m)) };
  }
  return null;
}

function term(r: DepositRate, name: string | undefined, override: number | null): RateRow['term'] {
  if (override !== null) return { min: override, max: override };
  const ranges = termRangesMonths(r, name);
  if (!ranges.length) return null;
  const min = Math.min(...ranges.map((x) => x.min));
  const max = ranges.some((x) => x.max === null) ? null : Math.max(...ranges.map((x) => x.max!));
  return { min, max };
}

function defaultRole(type: string | undefined): RateRow['role'] {
  if (isBaseType(type)) return 'BASE';
  return type === 'INTRODUCTORY' ? 'INTRO' : 'BONUS';
}

function cdrAge(d: ProductDetail, type: 'MIN_AGE' | 'MAX_AGE'): number | null {
  const e = (d.eligibility ?? []).find((x) => x.eligibilityType === type);
  const v = parseAmount(e?.additionalValue);
  return v !== null && v > 0 && v < 120 ? v : null;
}

function coverage(r: RateRow): Array<[number, number]> {
  return r.tiers.length ? r.tiers.map((t) => [t.min, t.max ?? Number.POSITIVE_INFINITY]) : [[0, Number.POSITIVE_INFINITY]];
}

function overlaps(a: RateRow, b: RateRow): boolean {
  return coverage(a).some(([a0, a1]) => coverage(b).some(([b0, b1]) => a0 < b1 && b0 < a1));
}

/**
 * Unreviewed products sometimes publish the same balance band several times
 * (e.g. Macquarie: advised vs non-advised accounts). Summing those would
 * double-count, so overlapping base rows become choose-one alternatives,
 * grouped by their description text.
 */
export function autoAlternatives(rows: RateRow[], labels: Map<string, string>): boolean {
  const bases = rows.filter((r) => r.role === 'BASE' && !r.alternativeSet);
  const clash = bases.some((a, i) => bases.slice(i + 1).some((b) => overlaps(a, b)));
  if (!clash) return false;
  for (const r of bases) {
    r.alternativeSet = 'base (auto)';
    r.option = labels.get(r.id) ?? r.id;
  }
  return true;
}

/**
 * Bonus rows that are exact copies of each other (same rate, conditions and
 * balance bands) are almost always one bonus split by something the data
 * doesn't say, such as age. Adding them together would double the bonus, so
 * treat each group as alternatives: only one can apply.
 */
export function identicalBonuses(rows: RateRow[], labels: Map<string, string>): boolean {
  const groups = new Map<string, RateRow[]>();
  for (const r of rows) {
    if (r.role === 'BASE' || r.alternativeSet) continue;
    const k = stableStringify({ role: r.role, rate: r.rate, combine: r.combine, tiers: r.tiers, method: r.method, conditions: r.conditions, intro: r.introMonths });
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let n = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    n++;
    g.forEach((r, i) => {
      r.alternativeSet = `bonus (auto ${n})`;
      r.option = `${labels.get(r.id) ?? r.id} (${i + 1})`;
    });
  }
  return n > 0;
}

export function normaliseProduct(
  file: RawEndpointFile,
  raw: RawProduct,
  reviews: ReviewsFile,
  brandRestrictions: Record<string, string> = {},
): Product | null {
  const d = raw.detail;
  const category = raw.productCategory ?? d?.productCategory ?? '';
  if (!d || !['TRANS_AND_SAVINGS_ACCOUNTS', 'TERM_DEPOSITS'].includes(category)) return null;
  if (isForeignCurrency(d.name, d.description) || isNonPersonal(d.name, d.eligibility, d.description)) return null;
  const rates = d.depositRates ?? [];
  if (!rates.length) return null;
  // Some banks publish percentages ("2.25" for 2.25%). No deposit rate is 25% or more,
  // so one such value means the whole product is in percent, small values (".25") included.
  const percent = rates.some((r) => (parseRate(r.rate) ?? 0) >= 0.25);
  const rateOf = (r: DepositRate) => {
    const v = parseRate(r.rate);
    return v === null ? null : percent ? v / 100 : v;
  };

  const key = `${file.slug}:${raw.productId}`;
  const entry = reviews.entries[key];
  const match = matchReview(entry, d);
  const aligned: RowReview[] | null = match?.rows ?? null;
  const notes: string[] = [];
  if (entry && !match) notes.push('The bank changed this account since it was checked by hand; rates are combined using the bank’s own labels until the next check');
  if (match && !match.exact) notes.push('Rates changed since the hand check, but how they combine is unchanged, so the check still applies');
  if (match && entry?.review.notes) notes.push(entry.review.notes);

  const rows: RateRow[] = [];
  const labels = new Map<string, string>();
  const nameForTerms = category === 'TERM_DEPOSITS' ? d.name : undefined;
  rates.forEach((r, i) => {
    const value = rateOf(r);
    if (value === null) return;
    const rr = aligned?.[i];
    if (rr?.role === 'EXCLUDE') return;
    const { tiers, method } = dollarTiers(r);
    const role = rr ? rr.role : defaultRole(r.depositRateType);
    const conditions: Condition[] = rr ? rr.conditions.map((c) => ({ ...c })) : cdrConditions(r);
    // Unreviewed bonus rows often say who they're for only in words ("for customers 31 years old or older").
    if (!rr && role !== 'BASE' && !conditions.some((c) => c.type === 'AGE_RANGE')) {
      const age = ageRangeFromText([typeof r.additionalValue === 'string' ? r.additionalValue : '', r.additionalInfo ?? ''].join(' '));
      if (age) conditions.push({ ...blankCondition('AGE_RANGE', 'Age stated in the bank’s description'), ...age, period: 'ONCE' });
    }
    const introFromData = r.depositRateType === 'INTRODUCTORY' ? durationToMonths(r.additionalValue) : null;
    const id = `${rowSignature(r)}#${i}`;
    const av = typeof r.additionalValue === 'string' && !isIsoDuration(r.additionalValue) ? r.additionalValue : '';
    labels.set(id, truncate(r.additionalInfo || av || `row ${i}`, 60));
    rows.push({
      id,
      role,
      combine: rr?.combine ?? 'ADD_TO_BASE',
      rate: value,
      variable: r.depositRateType !== 'FIXED',
      tiers,
      method,
      conditions,
      alternativeSet: rr?.alternativeSet ?? null,
      option: rr?.option ?? null,
      introMonths: role === 'INTRO' ? (rr?.introMonths ?? introFromData) : null,
      term: term(r, nameForTerms, rr?.termMonths ?? null),
      payment: payment(r),
    });
  });
  if (!rows.length) return null;

  const isTd = category === 'TERM_DEPOSITS' || rows.every((r) => r.term !== null && r.role !== 'INTRO');
  let finalRows = rows;
  if (!isTd && !aligned) {
    // Fixed-term sub-options inside an at-call product can't all apply at once; ignore them.
    const atCall = rows.filter((r) => !(r.term && !r.variable));
    if (atCall.length && atCall.length < rows.length) {
      notes.push('Fixed-term options inside this account ignored');
      finalRows = atCall;
    }
  }
  if (!isTd && autoAlternatives(finalRows, labels)) notes.push('Overlapping base rates treated as alternatives');
  if (!isTd && !aligned && identicalBonuses(finalRows, labels)) notes.push('Identical bonus rows treated as one bonus, not added together');
  const el = entry?.review.eligibility;
  return {
    key,
    brand: d.brandName ?? file.brands[0]?.brandName ?? file.slug,
    name: d.name ?? raw.productId,
    kind: isTd ? 'term_deposit' : 'savings',
    rows: finalRows,
    eligibility: {
      minAge: el?.minAge ?? cdrAge(d, 'MIN_AGE'),
      maxAge: el?.maxAge ?? cdrAge(d, 'MAX_AGE'),
      jointAllowed: el?.jointAllowed ?? null,
      restrictedTo: el?.restrictedTo ?? brandRestrictions[file.slug] ?? (aligned ? null : restrictionFromName(d.name)),
      newCustomersOnly: el?.newCustomersOnly ?? null,
    },
    reviewed: !!match,
    confidence: aligned ? (entry?.review.confidence ?? null) : null,
    notes,
    abn: file.brands.find((b) => b.abn)?.abn ?? null,
  };
}

export function normaliseAll(raws: RawEndpointFile[], reviews: ReviewsFile, brandRestrictions: Record<string, string> = {}): Product[] {
  const out: Product[] = [];
  for (const f of raws) for (const p of f.products) {
    const n = normaliseProduct(f, p, reviews, brandRestrictions);
    if (n) out.push(n);
  }
  return out;
}
