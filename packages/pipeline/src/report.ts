import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CrawlStatus } from './crawl.js';
import { mapCdrConditionType, type ExtractionOutput } from './extract/conditions.js';
import {
  appliesToTerm,
  describeTiers,
  isBaseType,
  isForeignCurrency,
  isNonPersonal,
  KNOWN_DEPOSIT_RATE_TYPES,
  savingsHeadline,
  structuredConditionTypes,
  freeTextParts,
  termRangesMonths,
} from './rates.js';
import type { DepositRate, ProductDetail, RawEndpointFile } from './types.js';
import { isIsoDuration, parseAmount, parseRate, pct, readJson, readJsonIfExists, truncate, writeJson } from './util.js';

const MAX_EXAMPLES = 6;
/** Above this, a savings headline is implausible for Nov 2026 (cash rate 4.85%). */
const IMPLAUSIBLE_HEADLINE = 0.09;
const PERCENT_FORMATTED = 0.25;

export interface QualityFlag {
  code: string;
  description: string;
  count: number;
  examples: string[];
}

export interface TopRow {
  brand: string;
  product: string;
  productId: string;
  base: number | null;
  bonus: number | null;
  intro: number | null;
  headline: number | null;
  note: string;
}

export interface Report {
  generatedAt: string;
  crawl: {
    crawledAt: string | null;
    registerOk: boolean | null;
    brandsTotal: number | null;
    brandsInScope: number | null;
    endpoints: number;
    endpointsOk: number;
    endpointsFailed: Array<{ brands: string; status: number; error: string; detail?: string }>;
    listVersions: Record<string, number>;
    detailVersions: Record<string, number>;
    cors: { browserReady: number; preflightOk: number; exposesXv: number; checked: number };
  };
  products: {
    byCategory: Record<string, number>;
    detailsOk: number;
    detailsMissing: number;
    withDepositRates: Record<string, number>;
  };
  rates: {
    rowsByType: Record<string, Record<string, number>>;
    tierMethods: Record<string, number>;
  };
  bonus: {
    rows: number;
    withStructured: number;
    freeTextOnly: number;
    structuredOnly: number;
    neither: number;
    conditionTypes: Record<string, number>;
  };
  flags: QualityFlag[];
  topSavings: TopRow[];
  topTd12: TopRow[];
  td12Coverage: { products: number; with12m: number };
  extraction?: {
    model: string;
    apiKey: string;
    items: number;
    extracted: number;
    failed: number;
    cached: number;
    called: number;
    conditionTypes: Record<string, number>;
    rateSemantics: Record<string, number>;
    confidence: Record<string, number>;
    agreement: { itemsWithStructured: number; fullRecall: number; meanRecall: number | null };
    lowConfidenceExamples: string[];
  };
}

function inc(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

class Flags {
  private flags = new Map<string, QualityFlag>();
  constructor(defs: Record<string, string>) {
    for (const [code, description] of Object.entries(defs)) this.flags.set(code, { code, description, count: 0, examples: [] });
  }
  add(code: string, example: string) {
    const f = this.flags.get(code)!;
    f.count++;
    if (f.examples.length < MAX_EXAMPLES) f.examples.push(example);
  }
  list(): QualityFlag[] {
    return [...this.flags.values()];
  }
}

const FLAG_DEFS = {
  DETAIL_MISSING: 'In-scope product whose detail request failed',
  NO_DEPOSIT_RATES: 'Product detail has no depositRates (common for transaction accounts; a problem for savings/TDs)',
  RATE_UNPARSEABLE: 'Rate value is not a valid RateString',
  RATE_LOOKS_LIKE_PERCENT: `Rate above ${PERCENT_FORMATTED * 100}% — probably published as a percentage ("5.33") instead of a fraction ("0.0533")`,
  RATE_NEGATIVE: 'Negative rate',
  UNKNOWN_RATE_TYPE: 'depositRateType not in the standard',
  DUPLICATE_RATE_ROWS: 'Identical rate rows repeated within one product',
  SAVINGS_WITHOUT_BASE: 'Savings/transaction product with rates but no base (FIXED/VARIABLE/FLOATING/MARKET_LINKED) rate',
  INTRO_WITHOUT_DURATION: 'INTRODUCTORY rate without an ISO 8601 duration in additionalValue',
  TD_RATE_WITHOUT_TERM: 'Term-deposit base rate with no determinable term (no duration, no MONTH/DAY tiers)',
  TIER_MAX_ZERO: 'Tier maximumValue of 0 (often meant as "no maximum")',
  TIER_NUMERIC_VALUES: 'Tier min/max sent as numbers instead of strings',
  TIER_LEGACY_CONDITIONS: 'Tier applicabilityConditions as a single object (pre-v6 shape)',
  BONUS_FREE_TEXT_ONLY: 'Bonus rate whose conditions exist only as free text',
  HEADLINE_IMPLAUSIBLE: `Base + stacked bonuses at $10k above ${IMPLAUSIBLE_HEADLINE * 100}% — likely a "total rate" bonus double-counted, or bad data`,
  OVERLAPPING_BASE_ROWS: 'Several different base rates apply at the same balance — plan or eligibility alternatives that need disambiguating',
  INTRO_MAYBE_TOTAL: 'Introductory rate of 3%+ — probably published as the total rate rather than an add-on to base',
  NON_AUD_PRODUCT: 'Foreign-currency product (to exclude)',
  NON_PERSONAL_PRODUCT: 'Business / SMSF / trust / organisation product (to exclude for a household)',
};

function label(file: RawEndpointFile, d: ProductDetail | null, productId: string): string {
  const brand = d?.brandName ?? file.brands[0]?.brandName ?? file.slug;
  return `${brand} — ${d?.name ?? productId}`;
}

export function analyse(raws: RawEndpointFile[], status: CrawlStatus | null, extraction: ExtractionOutput | null, now = new Date()): Report {
  const flags = new Flags(FLAG_DEFS);
  const byCategory: Record<string, number> = {};
  const withDepositRates: Record<string, number> = {};
  const rowsByType: Record<string, Record<string, number>> = {};
  const tierMethods: Record<string, number> = {};
  const conditionTypes: Record<string, number> = {};
  const bonus = { rows: 0, withStructured: 0, freeTextOnly: 0, structuredOnly: 0, neither: 0 };
  const topSavings: TopRow[] = [];
  const topTd12: TopRow[] = [];
  let detailsOk = 0;
  let detailsMissing = 0;
  let tdProducts = 0;
  let tdWith12 = 0;

  for (const file of raws) {
    for (const p of file.products) {
      const cat = p.productCategory ?? 'UNKNOWN';
      inc(byCategory, cat);
      const d = p.detail;
      const where = label(file, d, p.productId);
      if (!d) {
        detailsMissing++;
        flags.add('DETAIL_MISSING', `${where}: ${p.detailError ?? 'unknown'}${p.detailErrorDetail ? ` (${p.detailErrorDetail})` : ''}`);
        continue;
      }
      detailsOk++;
      const rates: DepositRate[] = Array.isArray(d.depositRates) ? d.depositRates : [];
      if (rates.length === 0) {
        flags.add('NO_DEPOSIT_RATES', `${where} [${cat}]`);
        continue;
      }
      inc(withDepositRates, cat);

      const seenRows = new Set<string>();
      let hasBase = false;
      for (const r of rates) {
        const type = r.depositRateType ?? 'MISSING';
        rowsByType[cat] ??= {};
        inc(rowsByType[cat]!, type);
        if (!KNOWN_DEPOSIT_RATE_TYPES.includes(type)) flags.add('UNKNOWN_RATE_TYPE', `${where}: ${type}`);
        if (isBaseType(type)) hasBase = true;

        const value = parseRate(r.rate);
        if (value === null) flags.add('RATE_UNPARSEABLE', `${where}: ${type} rate=${JSON.stringify(r.rate)}`);
        else if (value > PERCENT_FORMATTED) flags.add('RATE_LOOKS_LIKE_PERCENT', `${where}: ${type} rate=${JSON.stringify(r.rate)}`);
        else if (value < 0) flags.add('RATE_NEGATIVE', `${where}: ${type} rate=${JSON.stringify(r.rate)}`);

        const sig = JSON.stringify(r);
        if (seenRows.has(sig)) flags.add('DUPLICATE_RATE_ROWS', `${where}: ${type} ${pct(value)}`);
        seenRows.add(sig);

        if (type === 'INTRODUCTORY' && !isIsoDuration(r.additionalValue)) {
          flags.add('INTRO_WITHOUT_DURATION', `${where}: additionalValue=${JSON.stringify(r.additionalValue ?? null)}`);
        }
        if (cat === 'TERM_DEPOSITS' && isBaseType(type) && termRangesMonths(r).length === 0) {
          flags.add('TD_RATE_WITHOUT_TERM', `${where}: ${type} ${pct(value)} ${truncate(String(r.additionalValue ?? r.additionalInfo ?? ''), 80)}`);
        }

        for (const t of r.tiers ?? []) {
          if (t.rateApplicationMethod) inc(tierMethods, t.rateApplicationMethod);
          if (parseAmount(t.maximumValue) === 0) flags.add('TIER_MAX_ZERO', `${where}: tier ${t.name ?? ''} ${t.unitOfMeasure ?? ''}`);
          if (typeof t.minimumValue === 'number' || typeof t.maximumValue === 'number') {
            flags.add('TIER_NUMERIC_VALUES', `${where}: tier ${t.name ?? ''} min=${JSON.stringify(t.minimumValue)} max=${JSON.stringify(t.maximumValue)}`);
          }
          if (t.applicabilityConditions && !Array.isArray(t.applicabilityConditions)) {
            flags.add('TIER_LEGACY_CONDITIONS', `${where}: tier ${t.name ?? ''}`);
          }
        }

        if (type === 'BONUS' || type === 'BUNDLE_BONUS') {
          bonus.rows++;
          const structured = structuredConditionTypes(r);
          const text = freeTextParts(r);
          for (const s of structured) inc(conditionTypes, s);
          if (structured.length && text.length) bonus.withStructured++;
          else if (structured.length) bonus.structuredOnly++;
          else if (text.length) {
            bonus.freeTextOnly++;
            flags.add('BONUS_FREE_TEXT_ONLY', `${where}: ${truncate(text.join(' / '), 120)}`);
          } else bonus.neither++;
        }
      }

      const brand = d.brandName ?? file.brands[0]?.brandName ?? file.slug;
      const foreign = isForeignCurrency(d.name, d.description);
      const nonPersonal = isNonPersonal(d.name, d.eligibility);
      if (foreign) flags.add('NON_AUD_PRODUCT', where);
      if (nonPersonal) flags.add('NON_PERSONAL_PRODUCT', where);
      const percentFormatted = rates.some((r) => (parseRate(r.rate) ?? 0) > PERCENT_FORMATTED);
      const rankable = !foreign && !nonPersonal && !percentFormatted;

      if (cat === 'TRANS_AND_SAVINGS_ACCOUNTS') {
        if (!hasBase) flags.add('SAVINGS_WITHOUT_BASE', where);
        const h = savingsHeadline(rates);
        const headline = Math.max(h.ongoing ?? 0, h.withIntro ?? 0);
        if ((h.ongoing ?? 0) > IMPLAUSIBLE_HEADLINE) flags.add('HEADLINE_IMPLAUSIBLE', `${where}: base ${pct(h.base)} + bonus ${pct(h.bonus)}`);
        if (h.baseAlternatives > 1) flags.add('OVERLAPPING_BASE_ROWS', `${where}: ${h.baseAlternatives} base rates at $10k`);
        if ((h.intro ?? 0) >= 0.03) flags.add('INTRO_MAYBE_TOTAL', `${where}: base ${pct(h.base)}, intro ${pct(h.intro)}`);
        if (headline > 0 && rankable) {
          const notes = [
            h.bonusRows > 1 ? `${h.bonusRows} bonuses stacked` : '',
            h.baseAlternatives > 1 ? `${h.baseAlternatives} base alternatives` : '',
            (h.intro ?? 0) >= 0.03 ? 'intro may be total' : '',
          ];
          topSavings.push({
            brand,
            product: d.name ?? p.productId,
            productId: p.productId,
            base: h.base,
            bonus: h.bonus,
            intro: h.intro,
            headline,
            note: notes.filter(Boolean).join('; '),
          });
        }
      }

      if (cat === 'TERM_DEPOSITS' && rankable) {
        tdProducts++;
        const candidates = rates
          .filter((r) => isBaseType(r.depositRateType) && appliesToTerm(r, 12))
          .map((r) => ({ r, v: parseRate(r.rate) }))
          .filter((x): x is { r: DepositRate; v: number } => x.v !== null && x.v <= PERCENT_FORMATTED)
          .sort((a, b) => b.v - a.v);
        const best = candidates[0];
        if (best) {
          tdWith12++;
          const freq = best.r.applicationType === 'MATURITY' ? 'at maturity' : (best.r.applicationFrequency ?? best.r.applicationType ?? '');
          topTd12.push({
            brand,
            product: d.name ?? p.productId,
            productId: p.productId,
            base: best.v,
            bonus: null,
            intro: null,
            headline: best.v,
            note: [freq, best.r.tiers?.length ? describeTiers(best.r) : ''].filter(Boolean).join('; '),
          });
        }
      }
    }
  }

  topSavings.sort((a, b) => (b.headline ?? 0) - (a.headline ?? 0));
  topTd12.sort((a, b) => (b.headline ?? 0) - (a.headline ?? 0));

  const listVersions: Record<string, number> = {};
  const detailVersions: Record<string, number> = {};
  const cors = { browserReady: 0, preflightOk: 0, exposesXv: 0, checked: 0 };
  const endpointsFailed: Report['crawl']['endpointsFailed'] = [];
  for (const e of status?.endpoints ?? []) {
    if (e.listOk) {
      inc(listVersions, e.listVersion ?? 'none');
      for (const [v, n] of Object.entries(e.detailVersions)) inc(detailVersions, v, n);
      cors.checked++;
      if (e.cors.browserReady) cors.browserReady++;
      if (e.cors.preflightOk) cors.preflightOk++;
      if (e.cors.exposesXv) cors.exposesXv++;
    } else {
      endpointsFailed.push({
        brands: e.brandNames.join(', '),
        status: e.listStatus,
        error: e.listError ?? 'unknown',
        ...(e.listErrorDetail ? { detail: e.listErrorDetail } : {}),
      });
    }
  }

  const report: Report = {
    generatedAt: now.toISOString(),
    crawl: {
      crawledAt: status?.crawledAt ?? null,
      registerOk: status?.register.ok ?? null,
      brandsTotal: status?.register.brandsTotal ?? null,
      brandsInScope: status?.register.brandsInScope ?? null,
      endpoints: status?.endpoints.length ?? raws.length,
      endpointsOk: status?.totals.endpointsOk ?? raws.filter((r) => r.list.ok).length,
      endpointsFailed,
      listVersions,
      detailVersions,
      cors,
    },
    products: { byCategory, detailsOk, detailsMissing, withDepositRates },
    rates: { rowsByType, tierMethods },
    bonus: { ...bonus, conditionTypes },
    flags: flags.list(),
    topSavings: topSavings.slice(0, 25),
    topTd12: topTd12.slice(0, 15),
    td12Coverage: { products: tdProducts, with12m: tdWith12 },
  };
  if (extraction) report.extraction = summariseExtraction(extraction);
  return report;
}

export function summariseExtraction(ex: ExtractionOutput): NonNullable<Report['extraction']> {
  const conditionTypes: Record<string, number> = {};
  const rateSemantics: Record<string, number> = {};
  const confidence: Record<string, number> = {};
  const lowConfidenceExamples: string[] = [];
  let itemsWithStructured = 0;
  let fullRecall = 0;
  let recallSum = 0;
  for (const item of ex.items) {
    const e = item.extraction;
    if (!e) continue;
    for (const c of e.conditions) inc(conditionTypes, c.type);
    inc(rateSemantics, e.rateSemantics);
    inc(confidence, e.confidence);
    const ctx = item.contexts[0];
    if (e.confidence === 'low' && lowConfidenceExamples.length < MAX_EXAMPLES && ctx) {
      lowConfidenceExamples.push(`${ctx.brandName} — ${ctx.productName} (${ctx.depositRateType}): ${truncate(e.notes, 140)}`);
    }
    const structured = new Set((ctx?.structuredTypes ?? []).map(mapCdrConditionType).filter((t): t is string => !!t));
    if (structured.size) {
      itemsWithStructured++;
      const extracted = new Set<string>(e.conditions.map((c) => c.type));
      const hits = [...structured].filter((t) => extracted.has(t)).length;
      recallSum += hits / structured.size;
      if (hits === structured.size) fullRecall++;
    }
  }
  return {
    model: ex.model,
    apiKey: ex.apiKey ?? 'unverified',
    items: ex.stats.items,
    extracted: ex.items.filter((i) => i.extraction).length,
    failed: ex.stats.failed,
    cached: ex.stats.cached,
    called: ex.stats.called,
    conditionTypes,
    rateSemantics,
    confidence,
    agreement: {
      itemsWithStructured,
      fullRecall,
      meanRecall: itemsWithStructured ? Math.round((recallSum / itemsWithStructured) * 1000) / 1000 : null,
    },
    lowConfidenceExamples,
  };
}

function table(headers: string[], rows: Array<Array<string | number>>): string {
  const esc = (v: string | number) => String(v).replace(/\|/g, '\\|');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`),
  ].join('\n');
}

function kv(map: Record<string, number>): string {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, v]) => `${k}: ${v}`).join(', ') : '—';
}

export function renderMarkdown(r: Report): string {
  const c = r.crawl;
  const out: string[] = [];
  out.push(`# CDR product data — crawl report`);
  out.push(`Crawled ${c.crawledAt ?? 'unknown'} · report ${r.generatedAt}`);
  out.push(`## Coverage`);
  out.push(
    table(
      ['Measure', 'Value'],
      [
        ['Register brands (all industries)', c.brandsTotal ?? '—'],
        ['Brands in scope (banking + non-bank lending)', c.brandsInScope ?? '—'],
        ['Unique product endpoints crawled', c.endpoints],
        ['Endpoints answering', `${c.endpointsOk} / ${c.endpoints}`],
        ['In-scope products (savings/transaction + term deposits)', kv(r.products.byCategory)],
        ['Product details fetched', `${r.products.detailsOk} ok, ${r.products.detailsMissing} failed`],
        ['Products with deposit rates', kv(r.products.withDepositRates)],
        ['List endpoint versions (x-v)', kv(c.listVersions)],
        ['Detail endpoint versions (x-v)', kv(c.detailVersions)],
        ['Browser-callable (CORS ok with x-v)', `${c.cors.browserReady} / ${c.cors.checked}`],
      ],
    ),
  );
  if (c.endpointsFailed.length) {
    out.push(`### Endpoints that failed`);
    out.push(table(['Brand(s)', 'Status', 'Error', 'Detail'], c.endpointsFailed.map((f) => [f.brands, f.status, f.error, f.detail ?? ''])));
  }
  out.push(`## Rate rows`);
  out.push(table(['Category', 'Rows by depositRateType'], Object.entries(r.rates.rowsByType).map(([k, v]) => [k, kv(v)])));
  out.push(`Tier application methods: ${kv(r.rates.tierMethods)}`);
  out.push(`## Bonus conditions`);
  const b = r.bonus;
  const share = (n: number) => (b.rows ? `${n} (${Math.round((n / b.rows) * 100)}%)` : String(n));
  out.push(
    table(
      ['Bonus rows', 'Structured + text', 'Structured only', 'Free text only', 'Neither'],
      [[b.rows, share(b.withStructured), share(b.structuredOnly), share(b.freeTextOnly), share(b.neither)]],
    ),
  );
  out.push(`Structured condition types: ${kv(b.conditionTypes)}`);
  if (r.extraction) {
    const e = r.extraction;
    out.push(`## Claude condition extraction (${e.model})`);
    out.push(
      table(
        ['API key', 'Items', 'Extracted', 'Failed', 'From cache', 'API calls'],
        [[e.apiKey, e.items, e.extracted, e.failed, e.cached, e.called]],
      ),
    );
    out.push(`Condition types: ${kv(e.conditionTypes)}`);
    out.push(`Rate semantics: ${kv(e.rateSemantics)} · Confidence: ${kv(e.confidence)}`);
    out.push(
      `Agreement with banks' structured conditions: ${e.agreement.fullRecall}/${e.agreement.itemsWithStructured} items fully recovered` +
        (e.agreement.meanRecall !== null ? `, mean recall ${(e.agreement.meanRecall * 100).toFixed(1)}%` : ''),
    );
    if (e.lowConfidenceExamples.length) out.push(`Low-confidence examples:\n${e.lowConfidenceExamples.map((x) => `- ${x}`).join('\n')}`);
  }
  out.push(`## Data-quality flags`);
  out.push(table(['Flag', 'Count', 'Meaning'], r.flags.filter((f) => f.count).map((f) => [f.code, f.count, f.description])));
  for (const f of r.flags.filter((f) => f.count)) {
    out.push(`<details><summary>${f.code} — examples</summary>\n\n${f.examples.map((x) => `- ${x}`).join('\n')}\n\n</details>`);
  }
  out.push(`## Top savings headlines at a $10,000 balance (personal AUD products)`);
  out.push(
    'Headline = base + stacked bonuses (+ intro where present), assuming all conditions are met and adjustments are additive as the standard says. ' +
      'Rows noted "intro may be total" are probably overstated.',
  );
  out.push(
    table(
      ['Brand', 'Product', 'Base', 'Bonus', 'Intro', 'Headline', 'Note'],
      r.topSavings.map((t) => [t.brand, t.product, pct(t.base), pct(t.bonus), pct(t.intro), pct(t.headline), t.note]),
    ),
  );
  out.push(`## Top 12-month term deposits (personal AUD products)`);
  out.push(`${r.td12Coverage.with12m} of ${r.td12Coverage.products} personal AUD term-deposit products have an identifiable 12-month rate.`);
  out.push(table(['Brand', 'Product', 'Rate', 'Paid / tiers'], r.topTd12.map((t) => [t.brand, t.product, pct(t.headline), truncate(t.note, 90)])));
  return out.join('\n\n') + '\n';
}

export async function loadRaws(outDir: string): Promise<RawEndpointFile[]> {
  const dir = join(outDir, 'raw');
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  return Promise.all(names.map((n) => readJson<RawEndpointFile>(join(dir, n))));
}

export async function buildReport(outDir: string): Promise<Report> {
  const raws = await loadRaws(outDir);
  const status = await readJsonIfExists<CrawlStatus>(join(outDir, 'status.json'));
  const extraction = await readJsonIfExists<ExtractionOutput>(join(outDir, 'conditions.json'));
  const report = analyse(raws, status, extraction);
  await writeJson(join(outDir, 'report.json'), report);
  await writeFile(join(outDir, 'report.md'), renderMarkdown(report), 'utf8');
  return report;
}
