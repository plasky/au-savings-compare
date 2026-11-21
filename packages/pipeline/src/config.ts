/** Central configuration for the CDR product-data pipeline. */

export const REGISTER_URL =
  'https://api.cdr.gov.au/cdr-register/v1/all/data-holders/brands/summary';

/** Register industries whose brands publish banking product data. */
export const INDUSTRIES = ['banking', 'non-bank-lending'] as const;

/** Product categories in scope (no mortgages: the user has none). */
export const CATEGORIES = ['TRANS_AND_SAVINGS_ACCOUNTS', 'TERM_DEPOSITS'] as const;

/**
 * Endpoint versions. Holders must support Get Products v5 / Product Detail v7
 * from 13 Jul 2026 and may retire v4 / v6 from 10 Aug 2026. We ask for the
 * newest and negotiate down for holders that lag or mis-handle x-min-v.
 */
export const VERSIONS = {
  register: { preferred: 2, min: 1 },
  productList: { preferred: 5, min: 1 },
  productDetail: { preferred: 7, min: 1 },
} as const;

export const USER_AGENT = 'au-savings-compare/0.1 (personal, non-commercial rate comparison)';

/** Origin sent with requests so we can see each holder's CORS behaviour. */
export const PROBE_ORIGIN = 'https://example.org';

export const PAGE_SIZE = 100;
export const MAX_PAGES = 50;

/** Base rate types vs adjustments, per the CDR standard. */
export const BASE_DEPOSIT_RATE_TYPES = ['FIXED', 'FLOATING', 'MARKET_LINKED', 'VARIABLE'] as const;
export const ADJUSTMENT_DEPOSIT_RATE_TYPES = ['BONUS', 'BUNDLE_BONUS', 'INTRODUCTORY'] as const;

/** Claude model and prompt version for bonus-condition extraction. */
export const EXTRACTION_MODEL = 'claude-haiku-5-5';
export const EXTRACTION_PROMPT_VERSION = 'conditions-v1';
