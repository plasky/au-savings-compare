import { describe, expect, it } from 'vitest';
import { buildCatalogue, displayBrand, groupId, productUrl, renderCatalogueSummary } from '../src/catalogue.js';
import { emptyReviews } from '../src/review/review.js';
import type { ProductDetail } from '../src/types.js';
import { boostSaver, rawFile } from './fixtures/products.js';

const everyday: ProductDetail = {
  ...boostSaver,
  productId: 'everyday',
  name: 'Everyday Account',
  depositRates: [{ depositRateType: 'VARIABLE', rate: '0.00' }],
};

describe('catalogue', () => {
  it('groups brands that share an ABN and drops zero-rate products', () => {
    const a = rawFile('alpha', [{ ...boostSaver, brandName: 'Alpha Bank', additionalInformation: { overviewUri: 'https://alpha.example/saver' } }, everyday]);
    const b = rawFile('beta', [{ ...boostSaver, productId: 'b1', brandName: 'Beta' }]);
    const c = rawFile('gamma', [{ ...boostSaver, productId: 'c1', brandName: 'Gamma' }], {
      brands: [{ dataHolderBrandId: 'g', brandName: 'Gamma', brandGroup: null, abn: '22 000 000 000', industries: ['banking'] }],
    });
    const cat = buildCatalogue({ raws: [a, b, c], reviews: emptyReviews(), crawledAt: '2026-11-21T23:08:11Z', now: new Date('2026-11-22T00:00:00Z') });

    expect(cat.version).toBe('catalogue-v1');
    expect(cat.crawledAt).toBe('2026-11-21T23:08:11Z');
    expect(cat.counts).toMatchObject({ savings: 3, termDeposits: 0, zeroRate: 1, groups: 2 });
    expect(cat.groups).toEqual([
      { id: 'abn:11000000000', abn: '11000000000', brands: ['Alpha Bank', 'Beta'] },
      { id: 'abn:22000000000', abn: '22000000000', brands: ['Gamma'] },
    ]);
    const alpha = cat.products.find((p) => p.brand === 'Alpha Bank')!;
    expect(alpha.group).toBe('abn:11000000000');
    expect(alpha.url).toBe('https://alpha.example/saver');
    expect(alpha.lastUpdated).toBe('2026-11-10T00:00:00Z');
    expect(renderCatalogueSummary(cat)).toContain('| 11000000000 | Alpha Bank, Beta |');
  });

  it('falls back to the endpoint when no ABN is published', () => {
    const f = rawFile('delta', [boostSaver], { brands: [{ dataHolderBrandId: 'd', brandName: 'Delta', brandGroup: null, abn: null, industries: ['banking'] }] });
    expect(groupId(f)).toBe('endpoint:delta');
  });

  it('prefers the overview page and ignores non-URL values', () => {
    expect(productUrl({ ...boostSaver, additionalInformation: { overviewUri: 'see branch' }, applicationUri: 'https://x.example/apply' })).toBe('https://x.example/apply');
    expect(productUrl({ ...boostSaver })).toBeNull();
  });

  it('tidies brand names', () => {
    expect(displayBrand('HUME BANK LIMITED')).toBe('Hume Bank');
    expect(displayBrand('CENTRAL WEST CREDIT UNION LTD')).toBe('Central West Credit Union');
    expect(displayBrand('Bank First Production')).toBe('Bank First');
    expect(displayBrand('THE CAPRICORNIAN')).toBe('The Capricornian');
    expect(displayBrand('ANZ')).toBe('ANZ');
    expect(displayBrand('NATIONAL AUSTRALIA BANK', { 'NATIONAL AUSTRALIA BANK': 'NAB' })).toBe('NAB');
  });
});
