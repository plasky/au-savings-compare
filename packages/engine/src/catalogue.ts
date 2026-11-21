/**
 * The published product catalogue (products.json on the data branch) and the
 * Financial Claims Scheme check the app runs over a household's holdings.
 */
import type { Product } from './types.js';

export const CATALOGUE_VERSION = 'catalogue-v1';

/** A product as published for the app: an engine Product plus display and grouping fields. */
export interface CatalogueProduct extends Product {
  /** Financial Claims Scheme group: brands sharing one licence (ABN) share one $250k cap. */
  group: string;
  /** Bank page for the product (overview, else application). */
  url: string | null;
  /** When the bank last changed this product's data (ISO timestamp). */
  lastUpdated: string | null;
  description: string | null;
}

/** Brands that sit under one authorised deposit-taking institution (same ABN). */
export interface InstitutionGroup {
  id: string;
  abn: string | null;
  brands: string[];
}

export interface Catalogue {
  version: typeof CATALOGUE_VERSION;
  generatedAt: string;
  /** When the bank data was fetched. */
  crawledAt: string | null;
  counts: {
    savings: number;
    termDeposits: number;
    reviewed: number;
    restricted: number;
    groups: number;
    /** Products dropped because every published rate is zero (e.g. everyday accounts). */
    zeroRate: number;
  };
  groups: InstitutionGroup[];
  products: CatalogueProduct[];
}

/** Financial Claims Scheme cap per account holder per institution (AUD). */
export const FCS_LIMIT = 250_000;

export interface Holding {
  /** Institution group (CatalogueProduct.group). */
  group: string;
  balance: number;
  /** Ownership shares by person id, summing to 1. Joint accounts are split equally under the FCS. */
  owners: Record<string, number>;
}

export interface FcsExposure {
  group: string;
  person: string;
  amount: number;
  limit: number;
  /** Amount above the cap that would not be covered. */
  uncovered: number;
}

/**
 * Each person's exposure per institution: sole balances plus their share of
 * joint balances, compared against the per-holder cap. The FCS treats a joint
 * account as held in equal shares, whatever `owners` says, so joint balances
 * are split equally between holders here.
 */
export function fcsExposure(holdings: Holding[], limit = FCS_LIMIT): FcsExposure[] {
  const totals = new Map<string, number>();
  for (const h of holdings) {
    const people = Object.keys(h.owners).filter((p) => (h.owners[p] ?? 0) > 0);
    if (!people.length || h.balance <= 0) continue;
    for (const p of people) {
      const k = `${h.group}\u0000${p}`;
      totals.set(k, (totals.get(k) ?? 0) + h.balance / people.length);
    }
  }
  return [...totals.entries()]
    .map(([k, amount]) => {
      const [group, person] = k.split('\u0000') as [string, string];
      return { group, person, amount, limit, uncovered: Math.max(0, amount - limit) };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.person.localeCompare(b.person));
}
