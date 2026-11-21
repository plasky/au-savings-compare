#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { crawl } from './crawl.js';
import {
  collectItems,
  createAnthropicCaller,
  emptyCache,
  runExtraction,
  type ApiKeyStatus,
  type CacheFile,
  type CallModel,
  type ExtractionOutput,
} from './extract/conditions.js';
import { CdrClient } from './http.js';
import { buildReport, loadRaws, renderMarkdown } from './report.js';
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
  },
});

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

  // Stop calling the API as soon as the key is rejected.
  let rejected = false;
  let succeeded = false;
  const real = createAnthropicCaller({ apiKey });
  const callModel: CallModel = async (input) => {
    if (rejected) throw new Error('skipped: API key rejected');
    try {
      const result = await real(input);
      succeeded = true;
      return result;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 401 || status === 403) rejected = true;
      throw e;
    }
  };

  const { output, cache: nextCache } = await runExtraction({
    items,
    cache,
    callModel,
    concurrency: values.concurrency ? Number(values.concurrency) : 4,
    structuredOnly,
    noInformation,
    log,
  });
  const keyStatus: ApiKeyStatus = rejected ? 'rejected' : succeeded ? 'ok' : 'unverified';
  output.apiKey = keyStatus;
  await writeJson(outPath, output);
  await writeJson(cachePath, nextCache);
  log(
    `extract done: ${output.stats.cached} cached, ${output.stats.called} API calls, ${output.stats.failed} failed; API key: ${keyStatus}`,
  );
  if (keyStatus === 'rejected') warn('The Anthropic API rejected ANTHROPIC_API_KEY (401/403). Check the secret value.');
}

async function cmdReport() {
  const report = await buildReport(values.out!);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(report));
  }
  log(`report written to ${join(values.out!, 'report.md')}`);
}

const commands: Record<string, () => Promise<void>> = { crawl: cmdCrawl, extract: cmdExtract, report: cmdReport };
const command = positionals[0];
if (!command || !commands[command]) {
  console.error(`usage: cli.ts <${Object.keys(commands).join('|')}> [--out dir] [--cache file] [--limit n] [--filter text]`);
  process.exit(2);
}
commands[command]!().catch((e) => {
  console.error(e);
  process.exit(1);
});
