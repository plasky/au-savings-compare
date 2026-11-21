import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crawl } from '../src/crawl.js';
import { CdrClient } from '../src/http.js';
import { listAllProducts } from '../src/products.js';
import { fetchRegister, groupByEndpoint, inScopeBrands, normaliseBrand, productsEndpoint } from '../src/register.js';
import type { BrandSummary, RawEndpointFile } from '../src/types.js';
import { readJson } from '../src/util.js';
import { boostSaver, termDeposit } from './fixtures/products.js';
import { fakeFetch, json, noSleep } from './helpers.js';

const brand = (over: Partial<BrandSummary>): BrandSummary => ({
  dataHolderBrandId: 'id',
  brandName: 'Bank',
  industries: ['banking'],
  ...over,
});

describe('productsEndpoint', () => {
  it.each([
    [{ publicBaseUri: 'https://api.bank.com.au/public' }, 'https://api.bank.com.au/public/cds-au/v1/banking/products'],
    [{ publicBaseUri: 'https://api.bank.com.au/' }, 'https://api.bank.com.au/cds-au/v1/banking/products'],
    [{ publicBaseUri: 'https://x.au/cds-au/v1' }, 'https://x.au/cds-au/v1/banking/products'],
    [{ publicBaseUri: 'https://x.au/cds-au/v1/banking/' }, 'https://x.au/cds-au/v1/banking/products'],
    [{ publicBaseUri: 'https://old.au', productBaseUri: 'https://prd.au/api' }, 'https://prd.au/api/cds-au/v1/banking/products'],
  ])('%j', (over, expected) => {
    expect(productsEndpoint(brand(over))).toBe(expected);
  });
  it('returns null without a usable base', () => {
    expect(productsEndpoint(brand({}))).toBeNull();
    expect(productsEndpoint(brand({ publicBaseUri: 'not a url' }))).toBeNull();
  });
});

describe('register', () => {
  it('normalises v2 summaries and filters industries', async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      json(
        {
          data: [
            { dataHolderBrandId: 'a', brandName: 'Alpha Bank', industries: ['banking'], publicBaseUri: 'https://a.au', abn: '11 222 333 444' },
            { dataHolderBrandId: 'b', brandName: 'Beta Energy', industries: ['energy'], publicBaseUri: 'https://b.au' },
            { dataHolderBrandId: 'c', brandName: 'Gamma Lending', industries: ['non-bank-lending'], productBaseUri: 'https://c.au' },
            { brandName: 'no id' },
          ],
        },
        200,
        { 'x-v': '2' },
      ),
    );
    const res = await fetchRegister(new CdrClient({ fetchFn, sleep: noSleep }), 'https://register/x');
    expect(calls[0]!.headers['x-v']).toBe('2');
    expect(res.version).toBe('2');
    expect(res.brands).toHaveLength(3);
    expect(res.brands[0]!.abn).toBe('11222333444');
    expect(inScopeBrands(res.brands).map((b) => b.brandName)).toEqual(['Alpha Bank', 'Gamma Lending']);
  });

  it('accepts a v1-style singular industry', () => {
    expect(normaliseBrand({ dataHolderBrandId: 'x', brandName: 'X', industry: 'Banking' })?.industries).toEqual(['banking']);
  });

  it('crawls a shared endpoint once', () => {
    const { endpoints, withoutEndpoint } = groupByEndpoint([
      brand({ brandName: 'Westpac', publicBaseUri: 'https://wbc.au' }),
      brand({ brandName: 'St.George', publicBaseUri: 'https://WBC.au/' }),
      brand({ brandName: 'Orphan' }),
    ]);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.brands.map((b) => b.brandName)).toEqual(['St.George', 'Westpac']);
    expect(withoutEndpoint.map((b) => b.brandName)).toEqual(['Orphan']);
  });
});

describe('listAllProducts', () => {
  it('pages by totalPages and de-duplicates', async () => {
    const page = (n: number) => ({
      data: { products: [{ productId: `p${n}`, productCategory: 'TERM_DEPOSITS' }, { productId: 'dup' }] },
      meta: { totalPages: 3, totalRecords: 6 },
      links: { next: 'https://wrong-host.internal/next' },
    });
    const { fetchFn, calls } = fakeFetch((c) => json(page(Number(new URL(c.url).searchParams.get('page')))));
    const res = await listAllProducts(new CdrClient({ fetchFn, sleep: noSleep }), 'https://h.au/cds-au/v1/banking/products', 'k', 2);
    expect(res.ok).toBe(true);
    expect(calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(res.products.map((p) => p.productId)).toEqual(['p1', 'dup', 'p2', 'p3']);
  });

  it('keeps paging on full pages when meta is missing', async () => {
    const { fetchFn } = fakeFetch((c) => {
      const p = Number(new URL(c.url).searchParams.get('page'));
      const products = p < 3 ? [{ productId: `a${p}` }, { productId: `b${p}` }] : [{ productId: 'last' }];
      return json({ data: { products } });
    });
    const res = await listAllProducts(new CdrClient({ fetchFn, sleep: noSleep }), 'https://h.au/x', 'k', 2);
    expect(res.products).toHaveLength(5);
    expect(res.totalPages).toBeNull();
  });

  it('reports an unexpected payload shape', async () => {
    const { fetchFn } = fakeFetch(() => json({ data: { items: [] } }));
    const res = await listAllProducts(new CdrClient({ fetchFn, sleep: noSleep }), 'https://h.au/x', 'k');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unexpected-shape');
  });
});

describe('crawl (end to end with a fake network)', () => {
  it('writes raw files, register.json and status.json', async () => {
    const products = [
      { productId: boostSaver.productId, productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS' },
      { productId: termDeposit.productId, productCategory: 'TERM_DEPOSITS' },
      { productId: 'card', productCategory: 'CRED_AND_CHRG_CARDS' },
      { productId: 'broken', productCategory: 'TERM_DEPOSITS' },
    ];
    const { fetchFn } = fakeFetch((c) => {
      if (c.url.startsWith('https://register')) {
        return json({
          data: [
            { dataHolderBrandId: 'ex', brandName: 'Example Bank', industries: ['banking'], publicBaseUri: 'https://ex.au' },
            { dataHolderBrandId: 'down', brandName: 'Down Bank', industries: ['banking'], publicBaseUri: 'https://down.au' },
          ],
        });
      }
      if (c.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-v,x-min-v' } });
      }
      if (c.url.startsWith('https://down.au')) return new Response('bad gateway', { status: 502 });
      const u = new URL(c.url);
      const corsHeaders = { 'x-v': '5', 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-v' };
      if (u.pathname.endsWith('/products')) return json({ data: { products }, meta: { totalPages: 1 } }, 200, corsHeaders);
      const id = decodeURIComponent(u.pathname.split('/').pop()!);
      const detail = [boostSaver, termDeposit].find((p) => p.productId === id);
      return detail ? json({ data: detail }, 200, { 'x-v': '7' }) : json({ errors: [{ title: 'Not Found' }] }, 404);
    });

    const outDir = await mkdtemp(join(tmpdir(), 'crawl-'));
    // Route the real register host to the fake.
    const client = new CdrClient({ fetchFn: (url, init) => fetchFn(url.replace(/^https:\/\/api\.cdr\.gov\.au/, 'https://register'), init), sleep: noSleep, maxRetries: 1 });
    const status = await crawl({ outDir, client, now: () => new Date('2026-11-22T00:00:00Z') });

    expect(status.register.ok).toBe(true);
    expect(status.totals).toMatchObject({ endpointsOk: 1, endpointsFailed: 1, productsInScope: 3, detailsOk: 2, detailsFailed: 1, browserReady: 1 });
    const files = await readdir(join(outDir, 'raw'));
    expect(files).toHaveLength(2);
    const ex = await readJson<RawEndpointFile>(join(outDir, 'raw', files.find((f) => f.startsWith('example'))!));
    expect(ex.list.categoryCounts).toEqual({ TRANS_AND_SAVINGS_ACCOUNTS: 1, TERM_DEPOSITS: 2, CRED_AND_CHRG_CARDS: 1 });
    expect(ex.products.map((p) => p.productId)).toEqual(['boost-saver', 'broken', 'td-1']);
    const broken = ex.products.find((p) => p.productId === 'broken')!;
    expect(broken.detail).toBeNull();
    expect(broken.summary?.productId).toBe('broken');
    expect(broken.detailError).toBe('http-404');
    const down = status.endpoints.find((e) => e.brandNames.includes('Down Bank'))!;
    expect(down.listOk).toBe(false);
    expect(down.listError).toBe('http-502');
  });
});
