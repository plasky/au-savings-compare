import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { EXTRACTION_MODEL, EXTRACTION_PROMPT_VERSION } from '../config.js';
import { describeTiers, freeTextParts, rateConditions, structuredConditionTypes } from '../rates.js';
import type { RawEndpointFile } from '../types.js';
import { durationToMonths, parseRate, pct, pLimit, sha256 } from '../util.js';

export const CONDITION_TYPES = [
  'MIN_DEPOSIT_AMOUNT',
  'MIN_DEPOSITS',
  'MIN_PURCHASES',
  'DEPOSIT_BALANCE_INCREASED',
  'MAX_WITHDRAWALS',
  'MAX_WITHDRAWAL_AMOUNT',
  'MIN_BALANCE',
  'BALANCE_CAP',
  'NEW_CUSTOMER',
  'EXISTING_CUSTOMER',
  'AGE_RANGE',
  'LINKED_ACCOUNT',
  'ONLINE_ONLY',
  'OTHER',
] as const;

export const ConditionSchema = z.object({
  type: z.enum(CONDITION_TYPES),
  /** Dollar amount for amount-based conditions, else null. */
  amount: z.number().nullable(),
  /** Count for count-based conditions (purchases, deposits, withdrawals), else null. */
  count: z.number().nullable(),
  minAge: z.number().nullable(),
  maxAge: z.number().nullable(),
  period: z.enum(['MONTH', 'QUARTER', 'YEAR', 'ONCE', 'NONE']),
  /** Deposits must come from an external account/source (true), internal transfers count (false), unstated (null). */
  externalOnly: z.boolean().nullable(),
  description: z.string(),
});

export const ExtractionSchema = z.object({
  noConditions: z.boolean(),
  conditions: z.array(ConditionSchema),
  rateSemantics: z.enum(['ADDITIVE_TO_BASE', 'TOTAL_RATE_INCLUDING_BASE', 'UNCLEAR']),
  introPeriodMonths: z.number().nullable(),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.string(),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedCondition = z.infer<typeof ConditionSchema>;

export const SYSTEM_PROMPT = `You convert the bonus and introductory interest-rate conditions that Australian banks publish for savings accounts and term deposits (via the Consumer Data Right) into structured data for an interest calculator.

Rules:
- Extract only what the bank's text or structured conditions state. Never invent conditions or values.
- Amounts are Australian dollars as plain numbers (e.g. 1000 for "$1,000").
- Use period MONTH for "each month"/"monthly"/"in a calendar month", ONCE for one-off requirements, NONE when no period applies.
- Condition types:
  MIN_DEPOSIT_AMOUNT: deposit at least \`amount\` per period. Set externalOnly=true if deposits must come from an external account, another bank, or salary; false if internal transfers count; null if unstated.
  MIN_DEPOSITS: make at least \`count\` deposits per period.
  MIN_PURCHASES: make at least \`count\` card purchases/settled transactions per period (often from a linked transaction account).
  DEPOSIT_BALANCE_INCREASED: closing balance must exceed opening balance for the period (amount = minimum increase if stated, else null).
  MAX_WITHDRAWALS: at most \`count\` withdrawals per period (0 = no withdrawals).
  MAX_WITHDRAWAL_AMOUNT: withdrawals must not exceed \`amount\` per period.
  MIN_BALANCE: balance must be at least \`amount\` to earn the rate.
  BALANCE_CAP: the rate applies only to balances up to \`amount\`.
  NEW_CUSTOMER: only for customers new to the bank, brand, group or product type (say which in description).
  EXISTING_CUSTOMER: only for existing customers.
  AGE_RANGE: eligibility by age; minAge/maxAge inclusive, null when open-ended.
  LINKED_ACCOUNT: must hold another specified product with the bank (e.g. an everyday transaction account).
  ONLINE_ONLY: must be opened or managed online only.
  OTHER: anything else; describe it.
- Fill amount/count/minAge/maxAge only where relevant to the type, otherwise null.
- rateSemantics: the CDR standard says a BONUS or INTRODUCTORY rate is added to the base rate. Use TOTAL_RATE_INCLUDING_BASE only if the text clearly says the quoted figure is the total rate (for example the row's rate equals a stated total that already includes the base). Use ADDITIVE_TO_BASE when the text describes it as a bonus/margin on top of the base or gives no contrary signal. Use UNCLEAR when the text conflicts.
- introPeriodMonths: for introductory rates, the duration in months if stated (convert days/years), else null.
- noConditions: true if the rate has no conditions at all.
- confidence: low if the text is ambiguous, truncated, or contradicts the structured conditions.
- description and notes: short, plain English.`;

export interface ItemContext {
  slug: string;
  brandName: string;
  productId: string;
  productName: string;
  productCategory: string | null;
  depositRateType: string;
  rate: number | null;
  structuredTypes: string[];
}

export interface BonusItem {
  key: string;
  input: string;
  contexts: ItemContext[];
}

const EXTRACT_TYPES = new Set(['BONUS', 'BUNDLE_BONUS', 'INTRODUCTORY']);

/** Build one extraction input per bonus/intro rate row that carries free text. */
export function collectItems(raws: RawEndpointFile[]): { items: BonusItem[]; structuredOnly: number; noInformation: number } {
  const byKey = new Map<string, BonusItem>();
  let structuredOnly = 0;
  let noInformation = 0;
  for (const file of raws) {
    for (const p of file.products) {
      const d = p.detail;
      if (!d) continue;
      for (const rate of d.depositRates ?? []) {
        const type = rate.depositRateType ?? '';
        if (!EXTRACT_TYPES.has(type)) continue;
        const text = freeTextParts(rate);
        const structured = structuredConditionTypes(rate);
        if (text.length === 0) {
          if (structured.length) structuredOnly++;
          else noInformation++;
          continue;
        }
        const brandName = d.brandName ?? file.brands[0]?.brandName ?? file.slug;
        const productName = d.name ?? p.productId;
        const rateValue = parseRate(rate.rate);
        const structuredDesc = rateConditions(rate)
          .map((c) => `${c.rateApplicabilityType ?? '?'}${c.additionalValue !== undefined ? ` (${String(c.additionalValue)})` : ''}`)
          .join('; ');
        const intro = type === 'INTRODUCTORY' ? durationToMonths(rate.additionalValue) : null;
        const lines = [
          `Bank: ${brandName}`,
          `Product: ${productName} (${p.productCategory ?? d.productCategory ?? 'unknown category'})`,
          `Rate row: ${type} ${pct(rateValue)} p.a.`,
          intro !== null ? `Published introductory duration: ${intro} months` : null,
          rate.tiers?.length ? `Tiers: ${describeTiers(rate)}` : null,
          structuredDesc ? `Structured conditions published by the bank: ${structuredDesc}` : null,
          `Bank's text:\n"""\n${text.join('\n')}\n"""`,
        ].filter(Boolean);
        const input = lines.join('\n');
        const key = sha256(`${EXTRACTION_PROMPT_VERSION}|${EXTRACTION_MODEL}|${input}`);
        const ctx: ItemContext = {
          slug: file.slug,
          brandName,
          productId: p.productId,
          productName,
          productCategory: p.productCategory,
          depositRateType: type,
          rate: rateValue,
          structuredTypes: structured,
        };
        const existing = byKey.get(key);
        if (existing) existing.contexts.push(ctx);
        else byKey.set(key, { key, input, contexts: [ctx] });
      }
    }
  }
  const items = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { items, structuredOnly, noInformation };
}

export type CallModel = (input: string) => Promise<Extraction>;

export function createAnthropicCaller(opts: { apiKey?: string; model?: string; client?: Anthropic } = {}): CallModel {
  const client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 4 });
  const model = opts.model ?? EXTRACTION_MODEL;
  return async (input: string) => {
    const response = await client.messages.parse({
      model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input }],
      output_config: { format: zodOutputFormat(ExtractionSchema) },
    });
    if (!response.parsed_output) throw new Error(`no parsed output (stop_reason=${response.stop_reason})`);
    return response.parsed_output;
  };
}

export interface CacheEntry {
  extraction: Extraction;
  extractedAt: string;
}

export interface CacheFile {
  promptVersion: string;
  model: string;
  entries: Record<string, CacheEntry>;
}

export function emptyCache(): CacheFile {
  return { promptVersion: EXTRACTION_PROMPT_VERSION, model: EXTRACTION_MODEL, entries: {} };
}

/** Whether the Anthropic API key was present and accepted (the key itself is never recorded). */
export type ApiKeyStatus = 'missing' | 'ok' | 'rejected' | 'unverified';

export interface ExtractionOutput {
  generatedAt: string;
  model: string;
  promptVersion: string;
  apiKey?: ApiKeyStatus;
  stats: { items: number; cached: number; called: number; failed: number; structuredOnly: number; noInformation: number };
  items: Array<{ key: string; contexts: ItemContext[]; extraction: Extraction | null; error?: string }>;
}

/**
 * Extract conditions for every item, reusing cached results by key.
 * The returned cache holds only entries used in this run, so discontinued
 * products drop out over time.
 */
export async function runExtraction(opts: {
  items: BonusItem[];
  cache: CacheFile;
  callModel: CallModel;
  concurrency?: number;
  structuredOnly?: number;
  noInformation?: number;
  log?: (msg: string) => void;
  now?: () => Date;
}): Promise<{ output: ExtractionOutput; cache: CacheFile }> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const limit = pLimit(opts.concurrency ?? 4);
  const nextCache = emptyCache();
  let cached = 0;
  let called = 0;
  let failed = 0;

  const results = await Promise.all(
    opts.items.map((item) =>
      limit(async () => {
        const hit = opts.cache.entries[item.key];
        if (hit) {
          cached++;
          nextCache.entries[item.key] = hit;
          return { key: item.key, contexts: item.contexts, extraction: hit.extraction };
        }
        called++;
        try {
          const extraction = await opts.callModel(item.input);
          nextCache.entries[item.key] = { extraction, extractedAt: now().toISOString() };
          return { key: item.key, contexts: item.contexts, extraction };
        } catch (e) {
          failed++;
          const error = (e as Error).message?.slice(0, 300) ?? String(e);
          log(`extraction failed for ${item.contexts[0]?.brandName} / ${item.contexts[0]?.productName}: ${error}`);
          return { key: item.key, contexts: item.contexts, extraction: null, error };
        }
      }),
    ),
  );

  return {
    cache: nextCache,
    output: {
      generatedAt: now().toISOString(),
      model: EXTRACTION_MODEL,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      stats: {
        items: opts.items.length,
        cached,
        called,
        failed,
        structuredOnly: opts.structuredOnly ?? 0,
        noInformation: opts.noInformation ?? 0,
      },
      items: results,
    },
  };
}

/** Map CDR structured condition types onto our extraction types, for agreement checks. */
export function mapCdrConditionType(t: string): string | null {
  switch (t) {
    case 'EXISTING_CUST':
      return 'EXISTING_CUSTOMER';
    case 'NEW_CUSTOMER':
    case 'NEW_CUSTOMER_TO_GROUP':
    case 'NEW_ACCOUNTS':
      return 'NEW_CUSTOMER';
    case 'OTHER':
      return null;
    default:
      return (CONDITION_TYPES as readonly string[]).includes(t) ? t : null;
  }
}
