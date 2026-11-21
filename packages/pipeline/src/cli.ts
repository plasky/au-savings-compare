#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { crawl } from './crawl.js';
import {
  collectItems,
  createAnthropicCaller,
  emptyCache,
  guardCaller,
  runExtraction,
  type ApiKeyStatus,
  type CacheFile,
  type ExtractionOutput,
} from './extract/conditions.js';
import { CdrClient } from './http.js';
import { buildCatalogue, renderCatalogueSummary } from './catalogue.js';
import { normaliseAll } from './normalise.js';
import { rankSavings, rankTermDeposits, renderRank, type RankOptions } from './rank.js';
import { buildReport, loadRaws, renderMarkdown } from './report.js';
import {
  applyAnswers,
  buildCandidates,
  buildQueue,
  DEFAULT_THRESHOLD,
  emptyReviews,
  renderBatch,
  type ReviewsFile,
} from './review/review.js';
import { readJsonIfExists, writeJson } from './util.js';
import { EXTRACTION_MODEL, EXTRACTION_PROMPT_VERSION } from './config.js';

const inActions = !!process.env.GITHUB_ACTIONS;
const log = (msg: string) => console.log(msg);
const warn = (msg: string) => console.log(inActions ? `::warning::${msg}` : `WARNING: ${msg}`);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'out' },
    cache: { type: 'string', default: 'cache/conditions.json' },
    limit: { type: 'string' },
    filter: { type: 'string' },
    concurrency: { type: 'string' },
    reviews: { type: 'string', default: '../../curation/reviews.json' },
    threshold: { type: 'string' },
    file: { type: 'string', default: 'review-batch.md' },
    answers: { type: 'string', default: 'answers.json' },
    balance: { type: 'string', default: '50000' },
    deposit: { type: 'string', default: '1000' },
    purchases: { type: 'string', default: '5' },
    withdraw: { type: 'string', default: '0' },
    ages: { type: 'string', default: '40,40' },
    incomes: { type: 'string', default: '100000,100000' },
    months: { type: 'string', default: '12' },
    solo: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    td: { type: 'string' },
    top: { type: 'string', default: '20' },
    start: { type: 'string' },
  },
});

/** Rank real products for a household scenario with the engine. */
async function cmdRank() {
  const raws = await loadRaws(values.out!);
  const products = normaliseAll(raws, await loadReviews(), await loadBrandRestrictions());
  const now = new Date();
  const opts: RankOptions = {
    balance: Number(values.balance),
    monthlyDeposit: Number(values.deposit),
    purchases: Number(values.purchases),
    withdrawal: Number(values.withdraw),
    ages: values.ages!.split(',').map(Number),
    incomes: values.incomes!.split(',').map(Number),
    months: Number(values.months),
    joint: !values.solo,
    includeRestricted: !!values.all,
    startDate: values.start ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10),
  };
  const who = `${opts.joint ? 'joint' : 'sole'} account, ages ${opts.ages.join('/')}, incomes ${opts.incomes.map((i) => `$${i.toLocaleString('en-AU')}`).join('/')}`;
  if (values.td) {
    const term = Number(values.td);
    const rows = rankTermDeposits(products, opts, term);
    console.log(renderRank(rows, `Best ${term}-month term deposits for $${opts.balance.toLocaleString('en-AU')} (${who}; interest at maturity)`, Number(values.top)));
  } else {
    const rows = rankSavings(products, opts);
    console.log(
      renderRank(
        rows,
        `Best savings accounts over ${opts.months} months: $${opts.balance.toLocaleString('en-AU')} + $${opts.monthlyDeposit.toLocaleString('en-AU')}/month deposit, ${opts.purchases} card purchases/month, $${opts.withdrawal} withdrawals (${who})`,
        Number(values.top),
      ),
    );
  }
  const counts = { savings: products.filter((p) => p.kind === 'savings').length, td: products.filter((p) => p.kind === 'term_deposit').length, reviewed: products.filter((p) => p.reviewed).length };
  console.log(`\n${counts.savings} savings and ${counts.td} term-deposit products normalised (${counts.reviewed} with reviews).`);
}

interface BrandsFile {
  restricted?: Record<string, string>;
  displayNames?: Record<string, string>;
}

async function loadBrands(): Promise<BrandsFile> {
  return (await readJsonIfExists<BrandsFile>(join(dirname(values.reviews!), 'brands.json'))) ?? {};
}

async function loadBrandRestrictions(): Promise<Record<string, string>> {
  return (await loadBrands()).restricted ?? {};
}

/** Write products.json: the normalised catalogue the web app loads. */
async function cmdCatalogue() {
  const raws = await loadRaws(values.out!);
  const status = await readJsonIfExists<{ crawledAt?: string }>(join(values.out!, 'status.json'));
  const catalogue = buildCatalogue({
    raws,
    reviews: await loadReviews(),
    brandRestrictions: (await loadBrands()).restricted ?? {},
    displayNames: (await loadBrands()).displayNames ?? {},
    crawledAt: status?.crawledAt ?? null,
  });
  const file = join(values.out!, 'products.json');
  await writeFile(file, JSON.stringify(catalogue));
  const summary = renderCatalogueSummary(catalogue);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, '\n' + summary);
  }
  log(summary);
  log(`catalogue written to ${file}`);
}

async function loadReviews(): Promise<ReviewsFile> {
  const file = await readJsonIfExists<ReviewsFile>(values.reviews!);
  return file && file.entries ? file : emptyReviews();
}

/** Build the review queue from the crawl in --out and write review-queue.json (no inputs, just stats + keys). */
async function cmdReviewQueue() {
  const raws = await loadRaws(values.out!);
  const threshold = values.threshold ? Number(values.threshold) : DEFAULT_THRESHOLD;
  const { queue, stats } = buildQueue(raws, await loadReviews(), threshold);
  await writeJson(join(values.out!, 'review-queue.json'), {
    generatedAt: new Date().toISOString(),
    stats,
    items: queue.map((c) => ({ key: c.key, brand: c.brand, name: c.name, category: c.category, headline: c.headline, reasons: c.reasons })),
  });
  log(
    `review queue: ${stats.queued} to review (≥${(threshold * 100).toFixed(1)}%), ${stats.reviewed} already reviewed, ` +
      `${stats.stale} changed since review, ${stats.belowThreshold} below threshold, ${stats.candidates} candidates`,
  );
}

/** Render the top --limit queued products to --file for reading. */
async function cmdReviewBatch() {
  const raws = await loadRaws(values.out!);
  const threshold = values.threshold ? Number(values.threshold) : DEFAULT_THRESHOLD;
  const { queue, stats } = buildQueue(raws, await loadReviews(), threshold);
  const limit = values.limit ? Number(values.limit) : 40;
  const batch = queue.slice(0, limit);
  await writeFile(values.file!, renderBatch(batch), 'utf8');
  log(`wrote ${batch.length} of ${stats.queued} queued products to ${values.file} (threshold ${(threshold * 100).toFixed(1)}%)`);
}

/** Validate --answers against the current crawl and merge into --reviews. */
async function cmdReviewApply() {
  const raws = await loadRaws(values.out!);
  const reviews = await loadReviews();
  const answers = JSON.parse(await readFile(values.answers!, 'utf8'));
  const result = applyAnswers(answers, buildCandidates(raws), reviews);
  for (const e of result.errors) console.log(`ERROR   ${e}`);
  for (const w of result.warnings) console.log(`warning ${w}`);
  if (result.applied.length) await writeJson(values.reviews!, reviews);
  log(`applied ${result.applied.length} reviews, ${result.errors.length} errors, ${result.warnings.length} warnings`);
  if (result.errors.length) process.exitCode = 1;
}

async function cmdCrawl() {
  const client = new CdrClient();
  const status = await crawl({
    outDir: values.out!,
    client,
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values.filter ? { filter: values.filter } : {}),
    ...(values.concurrency ? { endpointConcurrency: Number(values.concurrency) } : {}),
    log,
  });
  const t = status.totals;
  log(
    `\ncrawl done in ${(status.durationMs / 1000).toFixed(0)}s: endpoints ok ${t.endpointsOk}/${t.endpointsOk + t.endpointsFailed}, ` +
      `in-scope products ${t.productsInScope}, details ${t.detailsOk} ok / ${t.detailsFailed} failed, browser-ready ${t.browserReady}`,
  );
  if (!status.register.ok) {
    console.error(`register request failed: ${status.register.error ?? status.register.status}`);
    process.exit(1);
  }
  if (t.endpointsOk === 0) {
    console.error('no endpoints answered');
    process.exit(1);
  }
}

async function cmdExtract() {
  const raws = await loadRaws(values.out!);
  const { items, structuredOnly, noInformation } = collectItems(raws);
  const cachePath = values.cache!;
  const loaded = await readJsonIfExists<CacheFile>(cachePath);
  const cache = loaded && loaded.entries ? loaded : emptyCache();
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const outPath = join(values.out!, 'conditions.json');
  log(`extract: ${items.length} bonus/intro rate rows with free text (${structuredOnly} structured-only, ${noInformation} with no information)`);

  if (!apiKey) {
    warn('ANTHROPIC_API_KEY is not set — skipping condition extraction. Add it as a repository Actions secret.');
    const output: ExtractionOutput = {
      generatedAt: new Date().toISOString(),
      model: EXTRACTION_MODEL,
      promptVersion: EXTRACTION_PROMPT_VERSION,
      apiKey: 'missing',
      stats: { items: items.length, cached: 0, called: 0, failed: 0, structuredOnly, noInformation },
      items: [],
    };
    await writeJson(outPath, output);
    return;
  }

  const { callModel, status } = guardCaller(createAnthropicCaller({ apiKey }));

  const { output, cache: nextCache } = await runExtraction({
    items,
    cache,
    callModel,
    concurrency: values.concurrency ? Number(values.concurrency) : 4,
    structuredOnly,
    noInformation,
    log,
  });
  const keyStatus: ApiKeyStatus = output.stats.called === 0 ? 'unverified' : status();
  output.apiKey = keyStatus;
  await writeJson(outPath, output);
  // Keep previous cache entries if nothing could be extracted this run (e.g. no credit).
  await writeJson(cachePath, keyStatus === 'ok' || keyStatus === 'unverified' ? nextCache : cache);
  log(
    `extract done: ${output.stats.cached} cached, ${output.stats.called} API calls, ${output.stats.failed} failed; API key: ${keyStatus}`,
  );
  if (keyStatus === 'rejected') warn('The Anthropic API rejected ANTHROPIC_API_KEY (401/403). Check the secret value.');
  if (keyStatus === 'no_credit') warn('ANTHROPIC_API_KEY is valid but the Anthropic account has no credit (Plans & Billing).');
  if (keyStatus === 'failing') warn('Initial Claude calls all failed; extraction stopped early. See conditions.json for errors.');
}

async function cmdReport() {
  const report = await buildReport(values.out!);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  }
  log(`report written to ${join(values.out!, 'report.md')}`);
}

const commands: Record<string, () => Promise<void>> = {
  crawl: cmdCrawl,
  extract: cmdExtract,
  report: cmdReport,
  'review-queue': cmdReviewQueue,
  'review-batch': cmdReviewBatch,
  'review-apply': cmdReviewApply,
  rank: cmdRank,
  catalogue: cmdCatalogue,
};
const command = positionals[0];
if (!command || !commands[command]) {
  console.error(`usage: cli.ts <${Object.keys(commands).join('|')}> [--out dir] [--cache file] [--limit n] [--filter text]`);
  process.exit(2);
}
commands[command]!().catch((e) => {
  console.error(e);
  process.exit(1);
});
