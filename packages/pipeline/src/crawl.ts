import { join } from 'node:path';
import { CATEGORIES } from './config.js';
import { assessCors, type CdrClient, type CorsAssessment, type CorsProbe } from './http.js';
import { fetchProductDetail, listAllProducts } from './products.js';
import { fetchRegister, groupByEndpoint, inScopeBrands, type Endpoint } from './register.js';
import type { BrandSummary, RawEndpointFile, RawProduct } from './types.js';
import { pLimit, writeJson } from './util.js';

export interface CrawlOptions {
  outDir: string;
  client: CdrClient;
  endpointConcurrency?: number;
  detailConcurrency?: number;
  categories?: readonly string[];
  /** Only crawl the first N endpoints (for quick runs). */
  limit?: number;
  /** Only crawl endpoints whose brand names contain this text (case-insensitive). */
  filter?: string;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface EndpointStatus {
  slug: string;
  url: string;
  brandNames: string[];
  listOk: boolean;
  listStatus: number;
  listVersion: string | null;
  listError?: string;
  listErrorDetail?: string;
  pageErrors: string[];
  productCount: number;
  categoryCounts: Record<string, number>;
  inScope: number;
  detailOk: number;
  detailFailed: number;
  detailVersions: Record<string, number>;
  detailErrors: Record<string, number>;
  cors: CorsAssessment & { probe: CorsProbe };
  durationMs: number;
}

export interface CrawlStatus {
  crawledAt: string;
  durationMs: number;
  register: {
    ok: boolean;
    status: number;
    version: string | null;
    error?: string;
    brandsTotal: number;
    brandsInScope: number;
    brandsWithoutEndpoint: string[];
    endpoints: number;
  };
  totals: {
    endpointsOk: number;
    endpointsFailed: number;
    productsListed: number;
    productsInScope: number;
    detailsOk: number;
    detailsFailed: number;
    browserReady: number;
  };
  endpoints: EndpointStatus[];
}

function brandRecord(b: BrandSummary): RawEndpointFile['brands'][number] {
  return {
    dataHolderBrandId: b.dataHolderBrandId,
    brandName: b.brandName,
    brandGroup: b.brandGroup ?? null,
    abn: b.abn ?? null,
    industries: b.industries,
  };
}

async function crawlEndpoint(
  ep: Endpoint,
  opts: Required<Pick<CrawlOptions, 'client' | 'detailConcurrency' | 'categories' | 'log'>>,
): Promise<{ file: RawEndpointFile; status: EndpointStatus }> {
  const started = Date.now();
  const { client, log } = opts;
  const probe = await client.probeCors(ep.url);
  const list = await listAllProducts(client, ep.url, `${ep.url}:list`);

  const categoryCounts: Record<string, number> = {};
  for (const p of list.products) {
    const c = p.productCategory ?? 'UNKNOWN';
    categoryCounts[c] = (categoryCounts[c] ?? 0) + 1;
  }
  const inScope = list.products
    .filter((p) => p.productCategory && opts.categories.includes(p.productCategory))
    .sort((a, b) => a.productId.localeCompare(b.productId));

  const limit = pLimit(opts.detailConcurrency);
  const products: RawProduct[] = await Promise.all(
    inScope.map((summary) =>
      limit(async () => {
        const res = await fetchProductDetail(client, ep.url, summary.productId, `${ep.url}:detail`);
        const detail = res.ok && res.body?.data && typeof res.body.data === 'object' ? res.body.data : null;
        const rp: RawProduct = {
          productId: summary.productId,
          productCategory: summary.productCategory ?? null,
          detail,
          detailStatus: res.status,
          detailVersion: res.version,
        };
        if (!detail) {
          rp.summary = summary;
          rp.detailError = res.ok ? 'unexpected-shape' : (res.error ?? 'unknown');
          if (res.errorDetail) rp.detailErrorDetail = res.errorDetail;
        }
        return rp;
      }),
    ),
  );

  const detailVersions: Record<string, number> = {};
  const detailErrors: Record<string, number> = {};
  for (const p of products) {
    if (p.detail) detailVersions[p.detailVersion ?? 'none'] = (detailVersions[p.detailVersion ?? 'none'] ?? 0) + 1;
    else detailErrors[p.detailError ?? 'unknown'] = (detailErrors[p.detailError ?? 'unknown'] ?? 0) + 1;
  }
  const detailOk = products.filter((p) => p.detail).length;

  const file: RawEndpointFile = {
    endpoint: ep.url,
    slug: ep.slug,
    brands: ep.brands.map(brandRecord),
    list: {
      ok: list.ok,
      status: list.status,
      version: list.version,
      ...(list.error ? { error: list.error } : {}),
      ...(list.errorDetail ? { errorDetail: list.errorDetail } : {}),
      totalPages: list.totalPages,
      pagesFetched: list.pagesFetched,
      productCount: list.products.length,
      categoryCounts,
    },
    products,
  };

  const status: EndpointStatus = {
    slug: ep.slug,
    url: ep.url,
    brandNames: ep.brands.map((b) => b.brandName),
    listOk: list.ok,
    listStatus: list.status,
    listVersion: list.version,
    ...(list.error ? { listError: list.error } : {}),
    ...(list.errorDetail ? { listErrorDetail: list.errorDetail } : {}),
    pageErrors: list.pageErrors,
    productCount: list.products.length,
    categoryCounts,
    inScope: inScope.length,
    detailOk,
    detailFailed: products.length - detailOk,
    detailVersions,
    detailErrors,
    cors: { ...assessCors(probe, list.firstPageHeaders), probe },
    durationMs: Date.now() - started,
  };

  log(
    `${list.ok ? 'ok  ' : 'FAIL'} ${ep.brands[0]!.brandName.padEnd(36)} list=${list.status} v${list.version ?? '-'} ` +
      `products=${list.products.length} inScope=${inScope.length} details=${detailOk}/${products.length}` +
      (list.error ? ` error=${list.error}` : ''),
  );
  return { file, status };
}

/** Crawl the register and every in-scope holder; write raw/<slug>.json, register.json and status.json. */
export async function crawl(opts: CrawlOptions): Promise<CrawlStatus> {
  const started = Date.now();
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => undefined);
  const categories = opts.categories ?? CATEGORIES;

  const register = await fetchRegister(opts.client);
  const inScope = inScopeBrands(register.brands);
  const { endpoints: allEndpoints, withoutEndpoint } = groupByEndpoint(inScope);
  log(
    `register: ${register.ok ? 'ok' : 'FAILED'} v${register.version ?? '-'} brands=${register.brands.length} ` +
      `inScope=${inScope.length} endpoints=${allEndpoints.length}`,
  );

  let endpoints = allEndpoints;
  if (opts.filter) {
    const f = opts.filter.toLowerCase();
    endpoints = endpoints.filter((e) => e.brands.some((b) => b.brandName.toLowerCase().includes(f)));
  }
  if (opts.limit !== undefined) endpoints = endpoints.slice(0, opts.limit);

  await writeJson(join(opts.outDir, 'register.json'), {
    version: register.version,
    brands: [...register.brands].sort((a, b) => a.brandName.localeCompare(b.brandName)),
  });

  const limit = pLimit(opts.endpointConcurrency ?? 6);
  const results = await Promise.all(
    endpoints.map((ep) =>
      limit(async () => {
        const r = await crawlEndpoint(ep, {
          client: opts.client,
          detailConcurrency: opts.detailConcurrency ?? 4,
          categories,
          log,
        });
        await writeJson(join(opts.outDir, 'raw', `${ep.slug}.json`), r.file);
        return r.status;
      }),
    ),
  );

  const statuses = results.sort((a, b) => a.slug.localeCompare(b.slug));
  const status: CrawlStatus = {
    crawledAt: now().toISOString(),
    durationMs: Date.now() - started,
    register: {
      ok: register.ok,
      status: register.result.status,
      version: register.version,
      ...(register.result.error ? { error: register.result.error } : {}),
      brandsTotal: register.brands.length,
      brandsInScope: inScope.length,
      brandsWithoutEndpoint: withoutEndpoint.map((b) => b.brandName).sort(),
      endpoints: allEndpoints.length,
    },
    totals: {
      endpointsOk: statuses.filter((s) => s.listOk).length,
      endpointsFailed: statuses.filter((s) => !s.listOk).length,
      productsListed: statuses.reduce((n, s) => n + s.productCount, 0),
      productsInScope: statuses.reduce((n, s) => n + s.inScope, 0),
      detailsOk: statuses.reduce((n, s) => n + s.detailOk, 0),
      detailsFailed: statuses.reduce((n, s) => n + s.detailFailed, 0),
      browserReady: statuses.filter((s) => s.cors.browserReady).length,
    },
    endpoints: statuses,
  };
  await writeJson(join(opts.outDir, 'status.json'), status);
  return status;
}
