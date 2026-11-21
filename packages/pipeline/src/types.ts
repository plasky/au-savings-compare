/**
 * Loose types for the parts of CDR product reference data we read.
 * Holders deviate from the standard (numbers instead of strings, legacy
 * single-object conditions, missing fields), so everything is optional and
 * `unknown` where the wire type varies.
 */

export interface BrandSummary {
  dataHolderBrandId: string;
  brandName: string;
  brandGroup?: string | null;
  abn?: string | null;
  acn?: string | null;
  arbn?: string | null;
  industries: string[];
  publicBaseUri?: string | null;
  productBaseUri?: string | null;
  logoUri?: string | null;
  lastUpdated?: string | null;
}

export interface RateCondition {
  rateApplicabilityType?: string;
  additionalValue?: unknown;
  additionalInfo?: string;
  additionalInfoUri?: string;
}

export interface RateTier {
  name?: string;
  unitOfMeasure?: string;
  minimumValue?: unknown;
  maximumValue?: unknown;
  rateApplicationMethod?: string;
  /** Array in Detail v6+, a single object in older versions. */
  applicabilityConditions?: RateCondition | RateCondition[];
  additionalInfo?: string;
  additionalInfoUri?: string;
}

export interface DepositRate {
  depositRateType?: string;
  rate?: unknown;
  calculationFrequency?: string;
  applicationType?: string;
  applicationFrequency?: string;
  tiers?: RateTier[];
  applicabilityConditions?: RateCondition | RateCondition[];
  additionalValue?: unknown;
  additionalInfo?: string;
  additionalInfoUri?: string;
}

export interface ProductSummary {
  productId: string;
  productCategory?: string;
  name?: string;
  description?: string;
  brand?: string;
  brandName?: string;
  lastUpdated?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  isTailored?: boolean;
  applicationUri?: string;
  [key: string]: unknown;
}

export interface ProductDetail extends ProductSummary {
  depositRates?: DepositRate[];
  features?: Array<{ featureType?: string; additionalValue?: unknown; additionalInfo?: string }>;
  eligibility?: Array<{ eligibilityType?: string; additionalValue?: unknown; additionalInfo?: string }>;
  constraints?: Array<{ constraintType?: string; additionalValue?: unknown; additionalInfo?: string }>;
  fees?: unknown[];
}

/** One crawled product as stored in a raw endpoint file. */
export interface RawProduct {
  productId: string;
  productCategory: string | null;
  /** Only kept when the detail call failed. */
  summary?: ProductSummary;
  detail: ProductDetail | null;
  detailStatus: number;
  detailVersion: string | null;
  detailError?: string;
  detailErrorDetail?: string;
}

/** Contents of raw/<slug>.json — one per unique product endpoint. */
export interface RawEndpointFile {
  endpoint: string;
  slug: string;
  brands: Array<Pick<BrandSummary, 'dataHolderBrandId' | 'brandName' | 'brandGroup' | 'abn' | 'industries'>>;
  list: {
    ok: boolean;
    status: number;
    version: string | null;
    error?: string;
    errorDetail?: string;
    totalPages: number | null;
    pagesFetched: number;
    productCount: number;
    categoryCounts: Record<string, number>;
  };
  products: RawProduct[];
}
