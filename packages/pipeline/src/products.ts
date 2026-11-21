import { MAX_PAGES, PAGE_SIZE, VERSIONS } from './config.js';
import type { CdrClient, CdrResult } from './http.js';
import type { ProductDetail, ProductSummary } from './types.js';

export interface ListResult {
  ok: boolean;
  status: number;
  version: string | null;
  error?: string;
  errorDetail?: string;
  totalPages: number | null;
  pagesFetched: number;
  products: ProductSummary[];
  /** Headers from the first page, for the CORS assessment. */
  firstPageHeaders: CdrResult['headers'] | null;
  pageErrors: string[];
}

interface ListBody {
  data?: { products?: unknown[] };
  meta?: { totalPages?: unknown; totalRecords?: unknown };
}

function pageUrl(endpoint: string, page: number, pageSize: number): string {
  const u = new URL(endpoint);
  u.searchParams.set('page', String(page));
  u.searchParams.set('page-size', String(pageSize));
  return u.toString();
}

function extractProducts(body: ListBody | null): ProductSummary[] | null {
  const products = body?.data?.products;
  if (!Array.isArray(products)) return null;
  return products.filter(
    (p): p is ProductSummary => !!p && typeof p === 'object' && typeof (p as ProductSummary).productId === 'string',
  );
}

/**
 * Fetch every current product from a holder's Get Products endpoint.
 * We fetch all categories and filter client-side, because some holders
 * mishandle the product-category filter. Pages are addressed by number
 * (from meta.totalPages) rather than by following links.next, which some
 * holders populate with unusable hosts.
 */
export async function listAllProducts(
  client: CdrClient,
  endpoint: string,
  memoKey: string,
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES,
): Promise<ListResult> {
  const first = await client.get<ListBody>(pageUrl(endpoint, 1, pageSize), VERSIONS.productList, memoKey);
  const base = {
    status: first.status,
    version: first.version,
    firstPageHeaders: first.status ? first.headers : null,
    pageErrors: [] as string[],
  };
  if (!first.ok) {
    return { ...base, ok: false, error: first.error, errorDetail: first.errorDetail, totalPages: null, pagesFetched: 0, products: [] };
  }
  const firstProducts = extractProducts(first.body);
  if (!firstProducts) {
    return { ...base, ok: false, error: 'unexpected-shape', totalPages: null, pagesFetched: 1, products: [] };
  }

  const rawTotal = Number(first.body?.meta?.totalPages);
  const totalPages = Number.isFinite(rawTotal) && rawTotal >= 1 ? Math.floor(rawTotal) : null;
  const all = [...firstProducts];
  let pagesFetched = 1;

  if (totalPages !== null) {
    for (let page = 2; page <= Math.min(totalPages, maxPages); page++) {
      const res = await client.get<ListBody>(pageUrl(endpoint, page, pageSize), VERSIONS.productList, memoKey);
      const products = res.ok ? extractProducts(res.body) : null;
      if (!products) {
        base.pageErrors.push(`page ${page}: ${res.error ?? 'unexpected-shape'}`);
        continue;
      }
      pagesFetched++;
      all.push(...products);
    }
  } else {
    // No usable meta: keep paging while pages come back full.
    let lastCount = firstProducts.length;
    for (let page = 2; lastCount >= pageSize && page <= maxPages; page++) {
      const res = await client.get<ListBody>(pageUrl(endpoint, page, pageSize), VERSIONS.productList, memoKey);
      const products = res.ok ? extractProducts(res.body) : null;
      if (!products) break;
      pagesFetched++;
      lastCount = products.length;
      all.push(...products);
    }
  }

  const seen = new Set<string>();
  const products = all.filter((p) => (seen.has(p.productId) ? false : (seen.add(p.productId), true)));
  return { ...base, ok: true, totalPages, pagesFetched, products };
}

export async function fetchProductDetail(
  client: CdrClient,
  endpoint: string,
  productId: string,
  memoKey: string,
): Promise<CdrResult<{ data?: ProductDetail }>> {
  const url = `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(productId)}`;
  return client.get<{ data?: ProductDetail }>(url, VERSIONS.productDetail, memoKey);
}
