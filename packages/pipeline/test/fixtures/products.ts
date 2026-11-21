import type { ProductDetail, RawEndpointFile } from '../../src/types.js';

/** A conditional bonus saver modelled on real CDR payloads (rate-level structured conditions + text). */
export const boostSaver: ProductDetail = {
  productId: 'boost-saver',
  productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
  name: 'Boost Saver',
  brand: 'Example Bank',
  brandName: 'Example Bank',
  lastUpdated: '2026-11-10T00:00:00Z',
  depositRates: [
    { depositRateType: 'VARIABLE', rate: '0.0005', applicationType: 'PERIODIC', applicationFrequency: 'P1M', calculationFrequency: 'P1D' },
    {
      depositRateType: 'BONUS',
      rate: '0.0575',
      applicationType: 'PERIODIC',
      applicationFrequency: 'P1M',
      additionalValue: 'Over 18 – deposit $1000 or more from an external account and make at least 5 purchases each month',
      applicabilityConditions: [
        { rateApplicabilityType: 'MIN_DEPOSIT_AMOUNT', additionalValue: '1000' },
        { rateApplicabilityType: 'MIN_PURCHASES', additionalValue: '5' },
      ],
      tiers: [{ name: 'Up to $250k', unitOfMeasure: 'DOLLAR', minimumValue: '0', maximumValue: '250000', rateApplicationMethod: 'WHOLE_BALANCE' }],
    },
  ],
};

/** Intro-rate saver whose bonus conditions are free text only. */
export const introSaver: ProductDetail = {
  productId: 'intro-saver',
  productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
  name: 'Intro Saver',
  brandName: 'Example Bank',
  depositRates: [
    { depositRateType: 'VARIABLE', rate: '0.0055', applicationType: 'PERIODIC', applicationFrequency: 'P1M' },
    { depositRateType: 'BONUS', rate: '0.0535', applicationType: 'PERIODIC', additionalInfo: 'Grow your balance each month (excluding interest) to earn the bonus rate.' },
    { depositRateType: 'INTRODUCTORY', rate: '0.006', applicationType: 'PERIODIC', additionalValue: 'P4M', additionalInfo: 'New customers only.' },
  ],
};

/** Term deposit: one row per term x payment frequency, plus a tier-based term row. */
export const termDeposit: ProductDetail = {
  productId: 'td-1',
  productCategory: 'TERM_DEPOSITS',
  name: 'Term Deposit',
  brandName: 'Example Bank',
  depositRates: [
    { depositRateType: 'FIXED', rate: '0.0530', applicationType: 'MATURITY', additionalValue: 'P12M' },
    { depositRateType: 'FIXED', rate: '0.0520', applicationType: 'PERIODIC', applicationFrequency: 'P1M', additionalValue: 'P1Y' },
    { depositRateType: 'FIXED', rate: '0.0480', applicationType: 'MATURITY', additionalValue: 'P6M' },
    {
      depositRateType: 'FIXED',
      rate: '0.0450',
      applicationType: 'MATURITY',
      tiers: [{ name: '24-36 months', unitOfMeasure: 'MONTH', minimumValue: '24', maximumValue: '36' }],
    },
  ],
};

/** A product exhibiting known data-quality problems. */
export const quirky: ProductDetail = {
  productId: 'quirky',
  productCategory: 'TRANS_AND_SAVINGS_ACCOUNTS',
  name: 'Quirky Saver',
  brandName: 'Odd Bank',
  depositRates: [
    { depositRateType: 'VARIABLE', rate: '5.33', applicationType: 'PERIODIC' },
    { depositRateType: 'BONUS', rate: '0.02', additionalValue: 'Deposit $500 each month' },
    { depositRateType: 'BONUS', rate: '0.02', additionalValue: 'Deposit $500 each month' },
    {
      depositRateType: 'INTRODUCTORY',
      rate: '0.01',
      additionalValue: 'four months',
      tiers: [
        {
          name: 'All balances',
          unitOfMeasure: 'DOLLAR',
          minimumValue: 0,
          maximumValue: 0,
          applicabilityConditions: { additionalInfo: 'legacy single-object condition' },
        },
      ],
    },
  ],
};

export const tdNoTerm: ProductDetail = {
  productId: 'td-noterm',
  productCategory: 'TERM_DEPOSITS',
  name: 'Mystery TD',
  brandName: 'Odd Bank',
  depositRates: [{ depositRateType: 'FIXED', rate: '0.05', applicationType: 'MATURITY' }],
};

export function rawFile(slug: string, details: ProductDetail[], extra: Partial<RawEndpointFile> = {}): RawEndpointFile {
  return {
    endpoint: `https://api.${slug}.example/cds-au/v1/banking/products`,
    slug,
    brands: [{ dataHolderBrandId: `${slug}-id`, brandName: details[0]?.brandName ?? slug, brandGroup: null, abn: '11000000000', industries: ['banking'] }],
    list: {
      ok: true,
      status: 200,
      version: '5',
      totalPages: 1,
      pagesFetched: 1,
      productCount: details.length,
      categoryCounts: {},
    },
    products: details.map((d) => ({
      productId: d.productId,
      productCategory: d.productCategory ?? null,
      detail: d,
      detailStatus: 200,
      detailVersion: '7',
    })),
    ...extra,
  };
}
