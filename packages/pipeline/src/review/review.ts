/**
 * Product-level "rate composition" reviews, written by Claude in a chat
 * session (no API key needed) and stored in curation/reviews.json on main.
 *
 * Flow: the nightly crawl builds a queue of products whose rate structure
 * needs judgement (bonus/intro rows, overlapping base rows, TD terms that
 * can't be parsed) and whose headline rate is above a threshold. A weekly
 * session renders a batch, writes answers.json, and applies it here with
 * validation. Reviews are keyed by a hash of the product's rate content, so
 * a product re-enters the queue only when the bank changes it.
 */
import { z } from 'zod';
import { CONDITION_TYPES } from '../extract/conditions.js';
import {
  appliesAtBalance,
  describeTiers,
  isBaseType,
  isForeignCurrency,
  isNonPersonal,
  rateConditions,
  savingsHeadline,
  termRangesMonths,
} from '../rates.js';
import type { DepositRate, ProductDetail, RawEndpointFile } from '../types.js';
import { parseAmount, parseRate, pct, sha256, truncate } from '../util.js';

export const REVIEW_VERSION = 'review-v2';
export const DEFAULT_THRESHOLD = 0.03;
const CATEGORIES = new Set(['TRANS_AND_SAVINGS_ACCOUNTS', 'TERM_DEPOSITS']);
const ADJUSTMENTS = new Set(['BONUS', 'BUNDLE_BONUS', 'INTRODUCTORY']);
/** Balances at which composed rates are evaluated for sanity checks. */
const CHECK_BALANCES = [1_000, 10_000, 50_000, 100_000, 250_000, 1_000_000];

// ---------- Schema (defaults keep hand-written answers short) ----------

export const ReviewConditionSchema = z.object({
  type: z.enum(CONDITION_TYPES),
  amount: z.number().nullable().default(null),
  count: z.number().nullable().default(null),
  minAge: z.number().nullable().default(null),
  maxAge: z.number().nullable().default(null),
  period: z.enum(['MONTH', 'QUARTER', 'YEAR', 'ONCE', 'NONE']).default('MONTH'),
  externalOnly: z.boolean().nullable().default(null),
  description: z.string().default(''),
});

export const RowReviewSchema = z.object({
  /** Index into the product's depositRates array. */
  index: z.number().int().nonnegative(),
  /** EXCLUDE = not available to an ordinary household (competition winners, staff, business-only…). */
  role: z.enum(['BASE', 'BONUS', 'INTRO', 'EXCLUDE']),
  /** ADD_TO_BASE per the standard, or TOTAL_RATE when the row's rate already includes base. */
  combine: z.enum(['ADD_TO_BASE', 'TOTAL_RATE']).default('ADD_TO_BASE'),
  /** Rows sharing a set name are mutually exclusive choices (plans, age bands, alternative bonuses). */
  alternativeSet: z.string().nullable().default(null),
  /** Label for this choice within its set, e.g. "Ultra plan ($X/month)", "Age 18–29". */
  option: z.string().nullable().default(null),
  conditions: z.array(ReviewConditionSchema).default([]),
  introMonths: z.number().nullable().default(null),
  termMonths: z.number().nullable().default(null),
  excludeReason: z.string().nullable().default(null),
});

export const ProductReviewSchema = z.object({
  /** `${slug}:${productId}` from the batch. */
  key: z.string(),
  reviewKey: z.string(),
  /** Role for any depositRates index not listed in `rows` (handy for TDs with dozens of plain term rows). */
  defaultRole: z.enum(['BASE', 'BONUS', 'INTRO', 'EXCLUDE']).nullable().default(null),
  rows: z.array(RowReviewSchema),
  eligibility: z
    .object({
      minAge: z.number().nullable().default(null),
      maxAge: z.number().nullable().default(null),
      newCustomersOnly: z.boolean().nullable().default(null),
      /** Can the product be held jointly? false = sole holder only; null = not stated. */
      jointAllowed: z.boolean().nullable().default(null),
      /** Restricted audience, e.g. "ADF members at service milestones", "students", "staff". */
      restrictedTo: z.string().nullable().default(null),
      notes: z.string().default(''),
    })
    .default({ minAge: null, maxAge: null, newCustomersOnly: null, jointAllowed: null, restrictedTo: null, notes: '' }),
  /** A maximum/total rate the bank's text states (fraction), for cross-checking. */
  statedHeadline: z.number().nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  notes: z.string().default(''),
});

export const AnswersSchema = z.object({ reviews: z.array(ProductReviewSchema) });

export type ProductReview = z.infer<typeof ProductReviewSchema>;
export type RowReview = z.infer<typeof RowReviewSchema>;

export interface ReviewEntry {
  reviewKey: string;
  reviewedAt: string;
  /** rowSignature of each depositRates row at review time, by index — lets reviews survive row reordering. */
  rowSignatures: string[];
  /** rowShape (signature without the rate value) of each row, by index — lets reviews survive rate-only changes. */
  rowShapes?: string[];
  /** shapeKeyFor at review time (name and eligibility). */
  shapeKey?: string;
  /** rowCore (type, balance bands and structured conditions only) of each row, by index — survives rewording. */
  rowCores?: string[];
  review: ProductReview;
}

export interface ReviewsFile {
  version: string;
  entries: Record<string, ReviewEntry>;
}

export function emptyReviews(): ReviewsFile {
  return { version: REVIEW_VERSION, entries: {} };
}

// ---------- Candidates and queue ----------

/** Rate value with percent-formatted values ("5.33") corrected, for thresholds and checks. */
export function normalisedRate(value: unknown): number | null {
  const v = parseRate(value);
  if (v === null) return null;
  return v > 0.25 && v < 25 ? v / 100 : v;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortByContent<T>(items: T[]): T[] {
  return [...items].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

/** A rate row with order-insensitive parts (conditions, tiers) sorted, so holders reshuffling arrays don't matter. */
function canonicalRate(r: DepositRate): unknown {
  const conds = (c: unknown) => (Array.isArray(c) ? sortByContent(c) : c);
  return {
    ...r,
    applicabilityConditions: conds(r.applicabilityConditions),
    tiers: r.tiers ? sortByContent(r.tiers.map((t) => ({ ...t, applicabilityConditions: conds(t.applicabilityConditions) }))) : undefined,
  };
}

/** Content signature of one rate row, independent of its position and of array ordering inside it. */
export function rowSignature(r: DepositRate): string {
  return sha256(stableStringify(canonicalRate(r))).slice(0, 16);
}

/**
 * A row's signature without its rate value. When a bank changes a rate but
 * nothing else about the row, the shape stays the same, and so does how the
 * rows combine — the hand review still holds.
 */
export function rowShape(r: DepositRate): string {
  return sha256(stableStringify({ ...(canonicalRate(r) as Record<string, unknown>), rate: undefined })).slice(0, 16);
}

const amountKey = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/** Structured conditions as type plus any short value; free text is left out. */
function coreConditions(list: unknown): unknown[] {
  const arr = Array.isArray(list) ? list : list && typeof list === 'object' ? [list] : [];
  return sortByContent(
    arr
      .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
      .map((c) => ({ t: c.rateApplicabilityType ?? null, v: typeof c.additionalValue === 'string' && c.additionalValue.length <= 24 ? c.additionalValue.trim() : null })),
  );
}

/**
 * A row's core: its rate type, balance bands and structured conditions,
 * without the rate or any wording. Banks often fix a typo or add a label
 * ("P4M") without changing what a row means; the core stays the same, so the
 * hand review can carry on until the next weekly check looks at it again.
 */
export function rowCore(r: DepositRate): string {
  const tiers = sortByContent(
    (r.tiers ?? []).map((t) => ({
      unit: t.unitOfMeasure ?? null,
      min: amountKey(t.minimumValue),
      max: amountKey(t.maximumValue),
      method: t.rateApplicationMethod ?? null,
      conds: coreConditions(t.applicabilityConditions),
    })),
  );
  return sha256(stableStringify({ type: r.depositRateType ?? null, tiers, conds: coreConditions(r.applicabilityConditions) })).slice(0, 16);
}

/** Order-insensitive key over a product's name, rate rows and eligibility. */
export function reviewKeyFor(d: ProductDetail): string {
  const rows = (d.depositRates ?? []).map(rowSignature).sort();
  const eligibility = (d.eligibility ?? []).map(stableStringify).sort();
  return sha256(`${REVIEW_VERSION}|${stableStringify({ name: d.name ?? null, rows, eligibility })}`);
}

/**
 * Map a stored review onto the product's *current* row order by row
 * signature (holders sometimes reorder depositRates). Returns null if any
 * current row has no reviewed counterpart.
 */
export function alignReview(entry: ReviewEntry, detail: ProductDetail, by: 'signature' | 'shape' | 'core' = 'signature'): RowReview[] | null {
  const keys = by === 'signature' ? entry.rowSignatures : by === 'shape' ? entry.rowShapes : entry.rowCores;
  const keyOf = by === 'signature' ? rowSignature : by === 'shape' ? rowShape : rowCore;
  if (!keys || keys.length !== (detail.depositRates ?? []).length) return null;
  const pool = new Map<string, RowReview[]>();
  keys.forEach((sig, i) => {
    const rr = entry.review.rows.find((r) => r.index === i);
    if (rr) pool.set(sig, [...(pool.get(sig) ?? []), rr]);
  });
  const out: RowReview[] = [];
  for (const [i, r] of (detail.depositRates ?? []).entries()) {
    const rr = pool.get(keyOf(r))?.shift();
    if (!rr) return null;
    out.push({ ...rr, index: i });
  }
  return out;
}

/**
 * The stored review that still applies to a product: exactly (same rows), or
 * after a rate-only change (same row shapes, the product's name and
 * eligibility unchanged). Null when the product has changed in any other way.
 */
export function matchReview(
  entry: ReviewEntry | undefined,
  detail: ProductDetail,
): { rows: RowReview[]; exact: boolean; how: 'exact' | 'rates' | 'wording' } | null {
  if (!entry) return null;
  const exact = alignReview(entry, detail, 'signature');
  if (exact) return { rows: exact, exact: true, how: 'exact' };
  if (!sameNameAndEligibility(entry, detail)) return null;
  const byShape = entry.rowShapes ? alignReview(entry, detail, 'shape') : null;
  if (byShape) return { rows: byShape, exact: false, how: 'rates' };
  const byCore = entry.rowCores ? alignReview(entry, detail, 'core') : null;
  if (byCore) return { rows: byCore, exact: false, how: 'wording' };
  return null;
}

function sameNameAndEligibility(entry: ReviewEntry, detail: ProductDetail): boolean {
  if (!entry.shapeKey) return true;
  return entry.shapeKey === shapeKeyFor(detail);
}

/** Name and eligibility part of the review key, so a rate-only change can be told apart from a rewrite. */
export function shapeKeyFor(d: ProductDetail): string {
  const eligibility = (d.eligibility ?? []).map(stableStringify).sort();
  return sha256(stableStringify({ name: d.name ?? null, eligibility })).slice(0, 16);
}

export interface Candidate {
  key: string;
  slug: string;
  productId: string;
  brand: string;
  name: string;
  category: string;
  headline: number;
  reasons: string[];
  reviewKey: string;
  detail: ProductDetail;
}

/** Why a product needs judgement beyond deterministic rules (empty = rules suffice). */
export function reviewReasons(d: ProductDetail, category: string): string[] {
  const rates = (d.depositRates ?? []).filter((r) => parseRate(r.rate) !== null);
  const reasons: string[] = [];
  if (rates.some((r) => ADJUSTMENTS.has(r.depositRateType ?? ''))) reasons.push('bonus/intro rows');
  if (category === 'TRANS_AND_SAVINGS_ACCOUNTS') {
    if ([10_000, 100_000].some((b) => savingsHeadline(rates, b).baseAlternatives > 1)) reasons.push('overlapping base rows');
  }
  if (category === 'TERM_DEPOSITS') {
    if (rates.some((r) => isBaseType(r.depositRateType) && termRangesMonths(r, d.name).length === 0)) reasons.push('term unknown');
  }
  return reasons;
}

/** Optimistic headline (max over balances, stacked bonuses, intro) used for the review threshold. */
export function candidateHeadline(d: ProductDetail, category: string): number {
  const rates = (d.depositRates ?? [])
    .map((r) => ({ ...r, rate: String(normalisedRate(r.rate) ?? '') }))
    .filter((r) => r.rate !== '');
  const singles = rates.map((r) => Number(r.rate));
  let best = singles.length ? Math.max(...singles) : 0;
  if (category === 'TRANS_AND_SAVINGS_ACCOUNTS') {
    for (const b of CHECK_BALANCES) {
      const h = savingsHeadline(rates, b);
      best = Math.max(best, h.ongoing ?? 0, h.withIntro ?? 0);
    }
  }
  return best;
}

export function buildCandidates(raws: RawEndpointFile[]): Candidate[] {
  const out: Candidate[] = [];
  for (const file of raws) {
    for (const p of file.products) {
      const d = p.detail;
      const category = p.productCategory ?? d?.productCategory ?? '';
      if (!d || !CATEGORIES.has(category)) continue;
      if (!(d.depositRates ?? []).length) continue;
      if (isForeignCurrency(d.name, d.description) || isNonPersonal(d.name, d.eligibility, d.description)) continue;
      const reasons = reviewReasons(d, category);
      if (!reasons.length) continue;
      out.push({
        key: `${file.slug}:${p.productId}`,
        slug: file.slug,
        productId: p.productId,
        brand: d.brandName ?? file.brands[0]?.brandName ?? file.slug,
        name: d.name ?? p.productId,
        category,
        headline: candidateHeadline(d, category),
        reasons,
        reviewKey: reviewKeyFor(d),
        detail: d,
      });
    }
  }
  return out.sort((a, b) => b.headline - a.headline || a.key.localeCompare(b.key));
}

export interface QueueStats {
  candidates: number;
  reviewed: number;
  /** Reviewed products whose rates changed but nothing else (review still applies). */
  rateOnly: number;
  /** Reviewed products whose wording changed (review still applied, but queued again). */
  reworded: number;
  stale: number;
  queued: number;
  belowThreshold: number;
  threshold: number;
}

export function buildQueue(raws: RawEndpointFile[], reviews: ReviewsFile, threshold = DEFAULT_THRESHOLD) {
  const candidates = buildCandidates(raws);
  const stats: QueueStats = { candidates: candidates.length, reviewed: 0, rateOnly: 0, reworded: 0, stale: 0, queued: 0, belowThreshold: 0, threshold };
  const queue: Candidate[] = [];
  for (const c of candidates) {
    const entry = reviews.entries[c.key];
    if (entry?.reviewKey === c.reviewKey) {
      stats.reviewed++;
      continue;
    }
    // A rate-only change keeps the review: how the rows combine hasn't changed.
    const m = entry ? matchReview(entry, c.detail) : null;
    if (m?.how === 'rates') {
      stats.reviewed++;
      stats.rateOnly++;
      continue;
    }
    // Reworded rows keep the review for now, but go back in the queue to be looked at again.
    if (m?.how === 'wording') stats.reworded++;
    if (c.headline < threshold) {
      stats.belowThreshold++;
      continue;
    }
    if (entry) stats.stale++;
    queue.push(c);
  }
  stats.queued = queue.length;
  return { queue, candidates, stats };
}

// ---------- Rendering a batch for reading ----------

function rowLine(r: DepositRate, i: number): string {
  const parts = [`${i}: ${r.depositRateType ?? '?'} ${pct(normalisedRate(r.rate), 2)}`];
  const raw = parseRate(r.rate);
  if (raw !== null && raw > 0.25) parts.push(`(published as "${String(r.rate)}")`);
  if (r.applicationType) parts.push(`paid ${r.applicationType}${r.applicationFrequency ? ` ${r.applicationFrequency}` : ''}`);
  if (r.tiers?.length) parts.push(`tiers ${describeTiers(r)}`);
  const conds = rateConditions(r).map((c) => `${c.rateApplicabilityType}${c.additionalValue !== undefined ? `=${String(c.additionalValue)}` : ''}${c.additionalInfo ? ` "${truncate(c.additionalInfo, 160)}"` : ''}`);
  if (conds.length) parts.push(`conds [${conds.join('; ')}]`);
  for (const t of r.tiers ?? []) {
    for (const c of Array.isArray(t.applicabilityConditions) ? t.applicabilityConditions : t.applicabilityConditions ? [t.applicabilityConditions] : []) {
      if (c.rateApplicabilityType || c.additionalInfo) parts.push(`tier-cond ${c.rateApplicabilityType ?? ''} ${c.additionalInfo ? `"${truncate(c.additionalInfo, 160)}"` : ''}`.trim());
    }
  }
  if (r.additionalValue !== undefined && r.additionalValue !== null && r.additionalValue !== '') parts.push(`value "${truncate(String(r.additionalValue), 300)}"`);
  if (r.additionalInfo) parts.push(`info "${truncate(r.additionalInfo, 300)}"`);
  return `  ${parts.join(' | ')}`;
}

export function renderBatch(items: Candidate[]): string {
  const blocks = items.map((c, n) => {
    const d = c.detail;
    const elig = (d.eligibility ?? [])
      .map((e) => `${e.eligibilityType}${e.additionalValue !== undefined ? `=${String(e.additionalValue)}` : ''}${e.additionalInfo ? ` "${truncate(e.additionalInfo, 120)}"` : ''}`)
      .join('; ');
    return [
      `### ${n + 1}. ${c.brand} — ${c.name} (${c.category === 'TERM_DEPOSITS' ? 'TD' : 'savings'}, headline≈${pct(c.headline)})`,
      `key: ${c.key}`,
      `reviewKey: ${c.reviewKey}`,
      `why: ${c.reasons.join(', ')}`,
      d.description ? `description: "${truncate(d.description, 400)}"` : null,
      elig ? `eligibility: ${elig}` : null,
      `rows:`,
      ...(d.depositRates ?? []).map(rowLine),
    ]
      .filter(Boolean)
      .join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

// ---------- Applying answers ----------

/** Best composed rate across check balances, given a review. Ignores conditions (assumes all met). */
export function composedMax(review: ProductReview, rates: DepositRate[]): number {
  let best = 0;
  for (const b of CHECK_BALANCES) {
    const rows = review.rows
      .filter((rr) => rr.role !== 'EXCLUDE')
      .map((rr) => ({ rr, r: rates[rr.index], v: normalisedRate(rates[rr.index]?.rate) }))
      .filter((x): x is { rr: RowReview; r: DepositRate; v: number } => !!x.r && x.v !== null && appliesAtBalance(x.r, b));
    const baseVals = rows.filter((x) => x.rr.role === 'BASE').map((x) => x.v);
    const base = baseVals.length ? Math.max(...baseVals) : 0;
    const additive = (role: RowReview['role']) => {
      const free = rows.filter((x) => x.rr.role === role && x.rr.combine === 'ADD_TO_BASE' && !x.rr.alternativeSet).reduce((s, x) => s + x.v, 0);
      const sets = new Map<string, number>();
      for (const x of rows.filter((x) => x.rr.role === role && x.rr.combine === 'ADD_TO_BASE' && x.rr.alternativeSet)) {
        sets.set(x.rr.alternativeSet!, Math.max(sets.get(x.rr.alternativeSet!) ?? 0, x.v));
      }
      return free + [...sets.values()].reduce((s, v) => s + v, 0);
    };
    const total = (role: RowReview['role']) => Math.max(0, ...rows.filter((x) => x.rr.role === role && x.rr.combine === 'TOTAL_RATE').map((x) => x.v));
    const ongoing = Math.max(base + additive('BONUS'), total('BONUS'));
    const withIntro = Math.max(ongoing + additive('INTRO'), total('INTRO'));
    best = Math.max(best, ongoing, withIntro);
  }
  return best;
}

export interface ApplyResult {
  applied: string[];
  errors: string[];
  warnings: string[];
}

export function applyAnswers(
  answersJson: unknown,
  candidates: Candidate[],
  reviews: ReviewsFile,
  now = new Date(),
): ApplyResult {
  const result: ApplyResult = { applied: [], errors: [], warnings: [] };
  const parsed = AnswersSchema.safeParse(answersJson);
  if (!parsed.success) {
    result.errors.push(`answers.json does not match the schema: ${parsed.error.message.slice(0, 2000)}`);
    return result;
  }
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  for (const review of parsed.data.reviews) {
    const c = byKey.get(review.key);
    const label = c ? `${c.brand} — ${c.name}` : review.key;
    if (!c) {
      result.errors.push(`${review.key}: not a current review candidate`);
      continue;
    }
    if (review.reviewKey !== c.reviewKey) {
      result.errors.push(`${label}: stale reviewKey (the product changed since the batch was rendered)`);
      continue;
    }
    const rates = c.detail.depositRates ?? [];
    if (review.defaultRole) {
      const listed = new Set(review.rows.map((r) => r.index));
      for (let i = 0; i < rates.length; i++) {
        if (!listed.has(i)) {
          review.rows.push(
            RowReviewSchema.parse({
              index: i,
              role: review.defaultRole,
              ...(review.defaultRole === 'EXCLUDE' ? { excludeReason: 'Excluded by default; see review notes' } : {}),
            }),
          );
        }
      }
      review.rows.sort((a, b) => a.index - b.index);
    }
    const indices = review.rows.map((r) => r.index).sort((a, b) => a - b);
    const expected = rates.map((_, i) => i);
    if (indices.length !== expected.length || indices.some((v, i) => v !== expected[i])) {
      result.errors.push(`${label}: rows must cover each depositRates index 0..${rates.length - 1} exactly once (got ${indices.join(',')})`);
      continue;
    }
    for (const rr of review.rows) {
      if (rr.role === 'EXCLUDE' && !rr.excludeReason) result.warnings.push(`${label}: row ${rr.index} excluded without a reason`);
      if (c.category === 'TERM_DEPOSITS' && rr.role === 'BASE' && rr.termMonths === null && termRangesMonths(rates[rr.index]!, c.name).length === 0) {
        result.warnings.push(`${label}: row ${rr.index} has no term`);
      }
    }
    if (c.category === 'TRANS_AND_SAVINGS_ACCOUNTS') {
      const free = review.rows.filter((rr) => rr.role === 'BASE' && !rr.alternativeSet).map((rr) => rates[rr.index]!);
      const range = (r: DepositRate) => {
        const ts = (r.tiers ?? []).filter((t) => (t.unitOfMeasure ?? '').toUpperCase() === 'DOLLAR');
        return ts.length
          ? ts.map((t) => [parseAmount(t.minimumValue) ?? 0, parseAmount(t.maximumValue) || Number.POSITIVE_INFINITY] as const)
          : [[0, Number.POSITIVE_INFINITY] as const];
      };
      const clash = free.some((a, i) => free.slice(i + 1).some((b) => range(a).some(([a0, a1]) => range(b).some(([b0, b1]) => a0 < b1 && b0 < a1))));
      if (clash) result.warnings.push(`${label}: base rows overlap in balance coverage without an alternativeSet (the engine would treat them as alternatives)`);
      const composed = composedMax(review, rates);
      if (composed > 0.12) result.warnings.push(`${label}: composed headline ${pct(composed)} looks implausible`);
      if (review.statedHeadline !== null && Math.abs(composed - review.statedHeadline) > 0.0005) {
        result.warnings.push(`${label}: composed ${pct(composed)} ≠ stated ${pct(review.statedHeadline)}`);
      }
    }
    reviews.entries[review.key] = {
      reviewKey: review.reviewKey,
      reviewedAt: now.toISOString(),
      rowSignatures: rates.map(rowSignature),
      rowShapes: rates.map(rowShape),
      rowCores: rates.map(rowCore),
      shapeKey: shapeKeyFor(c.detail),
      review,
    };
    result.applied.push(label);
  }
  return result;
}
