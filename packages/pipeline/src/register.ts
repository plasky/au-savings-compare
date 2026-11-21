import { INDUSTRIES, REGISTER_URL, VERSIONS } from './config.js';
import type { CdrClient, CdrResult } from './http.js';
import type { BrandSummary } from './types.js';
import { shortHash, slugify } from './util.js';

export interface RegisterResult {
  ok: boolean;
  brands: BrandSummary[];
  version: string | null;
  result: CdrResult;
}

/** Fetch every data holder brand from the public CDR register (no auth). */
export async function fetchRegister(client: CdrClient, url = REGISTER_URL): Promise<RegisterResult> {
  const result = await client.get<{ data?: unknown[] }>(url, VERSIONS.register, 'register');
  const data = result.ok && Array.isArray(result.body?.data) ? result.body!.data : [];
  const brands = data.map(normaliseBrand).filter((b): b is BrandSummary => b !== null);
  return { ok: result.ok && brands.length > 0, brands, version: result.version, result };
}

export function normaliseBrand(raw: unknown): BrandSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const id = b.dataHolderBrandId ?? b.interimId;
  if (typeof id !== 'string' || typeof b.brandName !== 'string') return null;
  const industries = Array.isArray(b.industries)
    ? b.industries.filter((x): x is string => typeof x === 'string')
    : typeof b.industry === 'string'
      ? [b.industry]
      : [];
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    dataHolderBrandId: id,
    brandName: b.brandName.trim(),
    brandGroup: str(b.brandGroup),
    abn: str(b.abn)?.replace(/\s+/g, '') ?? null,
    acn: str(b.acn),
    arbn: str(b.arbn),
    industries: industries.map((i) => i.toLowerCase()),
    publicBaseUri: str(b.publicBaseUri),
    productBaseUri: str(b.productBaseUri),
    logoUri: str(b.logoUri),
    lastUpdated: str(b.lastUpdated),
  };
}

export function inScopeBrands(brands: BrandSummary[], industries: readonly string[] = INDUSTRIES): BrandSummary[] {
  return brands.filter((b) => b.industries.some((i) => industries.includes(i)));
}

/**
 * Build the Get Products URL for a brand. productBaseUri (standards v1.36)
 * takes precedence over publicBaseUri. Tolerates bases that already include
 * the /cds-au/v1 or /cds-au/v1/banking path segments.
 */
export function productsEndpoint(brand: BrandSummary): string | null {
  const base = (brand.productBaseUri ?? brand.publicBaseUri)?.trim();
  if (!base) return null;
  let url = base.replace(/\/+$/, '');
  if (/\/cds-au\/v1\/banking\/products$/i.test(url)) return url;
  if (/\/cds-au\/v1\/banking$/i.test(url)) return `${url}/products`;
  if (/\/cds-au\/v1$/i.test(url)) return `${url}/banking/products`;
  url = `${url}/cds-au/v1/banking/products`;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

export interface Endpoint {
  url: string;
  slug: string;
  brands: BrandSummary[];
}

/** Several brands can share one endpoint (it returns all their products). Crawl each URL once. */
export function groupByEndpoint(brands: BrandSummary[]): { endpoints: Endpoint[]; withoutEndpoint: BrandSummary[] } {
  const byUrl = new Map<string, BrandSummary[]>();
  const withoutEndpoint: BrandSummary[] = [];
  for (const brand of brands) {
    const url = productsEndpoint(brand);
    if (!url) {
      withoutEndpoint.push(brand);
      continue;
    }
    const key = url.toLowerCase();
    byUrl.set(key, [...(byUrl.get(key) ?? []), brand]);
  }
  const endpoints = [...byUrl.values()].map((group) => {
    const sorted = [...group].sort((a, b) => a.brandName.localeCompare(b.brandName));
    const url = productsEndpoint(sorted[0]!)!;
    return { url, slug: `${slugify(sorted[0]!.brandName)}-${shortHash(url.toLowerCase())}`, brands: sorted };
  });
  endpoints.sort((a, b) => a.slug.localeCompare(b.slug));
  return { endpoints, withoutEndpoint };
}
