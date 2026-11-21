/**
 * Builds the app's product catalogue (products.json): normalised products,
 * grouped by licensed institution (ABN) for the Financial Claims Scheme check.
 */
import { CATALOGUE_VERSION, type Catalogue, type CatalogueProduct, type InstitutionGroup } from '@asc/engine';
import { normaliseProduct } from './normalise.js';
import type { ReviewsFile } from './review/review.js';
import type { ProductDetail, RawEndpointFile } from './types.js';
import { truncate } from './util.js';

const httpUrl = (v: unknown): string | null =>
  typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : null;

/** The bank's page for a product: overview first, then the application link. */
export function productUrl(d: ProductDetail): string | null {
  const info = (d.additionalInformation ?? {}) as Record<string, unknown>;
  return httpUrl(info.overviewUri) ?? httpUrl(d.applicationUri) ?? null;
}

const SMALL_WORDS = new Set(['of', 'and', 'the', 'for']);

/** Readable brand name: an explicit mapping, else trim legal/internal suffixes and fix SHOUTING CASE. */
export function displayBrand(name: string, names: Record<string, string> = {}): string {
  if (names[name]) return names[name]!;
  let s = name.trim().replace(/\s+(Prod|Product|Production)$/i, '');
  s = s.replace(/\s+(Co-Operative\s+)?(Limited|Ltd\.?)$/i, '').trim();
  if (s.length > 5 && s === s.toUpperCase()) {
    s = s
      .toLowerCase()
      .split(' ')
      .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(' ');
  }
  return s;
}

export function groupId(file: RawEndpointFile): string {
  const abn = file.brands.find((b) => b.abn)?.abn?.replace(/\s+/g, '');
  return abn ? `abn:${abn}` : `endpoint:${file.slug}`;
}

export interface CatalogueInput {
  raws: RawEndpointFile[];
  reviews: ReviewsFile;
  brandRestrictions?: Record<string, string>;
  /** Raw CDR brandName → display name (curation/brands.json displayNames). */
  displayNames?: Record<string, string>;
  crawledAt?: string | null;
  now?: Date;
}

export function buildCatalogue({ raws, reviews, brandRestrictions = {}, displayNames = {}, crawledAt = null, now = new Date() }: CatalogueInput): Catalogue {
  const products: CatalogueProduct[] = [];
  const groups = new Map<string, InstitutionGroup>();
  let zeroRate = 0;
  for (const file of raws) {
    const group = groupId(file);
    for (const raw of file.products) {
      const p = normaliseProduct(file, raw, reviews, brandRestrictions);
      if (!p) continue;
      if (p.rows.every((r) => r.rate <= 0)) {
        zeroRate++;
        continue;
      }
      const d = raw.detail!;
      p.brand = displayBrand(p.brand, displayNames);
      products.push({
        ...p,
        group,
        url: productUrl(d),
        lastUpdated: typeof d.lastUpdated === 'string' ? d.lastUpdated : null,
        description: d.description ? truncate(d.description.replace(/\s+/g, ' ').trim(), 280) : null,
      });
      const g = groups.get(group) ?? { id: group, abn: group.startsWith('abn:') ? group.slice(4) : null, brands: [] };
      if (!g.brands.includes(p.brand)) g.brands.push(p.brand);
      groups.set(group, g);
    }
  }
  products.sort((a, b) => a.brand.localeCompare(b.brand) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const groupList = [...groups.values()]
    .map((g) => ({ ...g, brands: [...g.brands].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    version: CATALOGUE_VERSION,
    generatedAt: now.toISOString(),
    crawledAt,
    counts: {
      savings: products.filter((p) => p.kind === 'savings').length,
      termDeposits: products.filter((p) => p.kind === 'term_deposit').length,
      reviewed: products.filter((p) => p.reviewed).length,
      restricted: products.filter((p) => p.eligibility.restrictedTo).length,
      groups: groupList.length,
      zeroRate,
    },
    groups: groupList,
    products,
  };
}

export function renderCatalogueSummary(c: Catalogue): string {
  const multi = c.groups.filter((g) => g.brands.length > 1);
  const lines = [
    '## App catalogue (products.json)',
    '',
    `- ${c.counts.savings} savings and ${c.counts.termDeposits} term-deposit products (${c.counts.reviewed} with a curated review, ${c.counts.restricted} restricted to particular customers)`,
    `- ${c.counts.zeroRate} products left out because every published rate is 0%`,
    `- ${c.counts.groups} institutions for the $250k Financial Claims Scheme check; ${multi.length} cover more than one brand`,
  ];
  if (multi.length) {
    lines.push('', '| Institution (ABN) | Brands sharing one guarantee cap |', '|---|---|');
    for (const g of multi) lines.push(`| ${g.abn ?? g.id} | ${g.brands.join(', ')} |`);
  }
  return lines.join('\n') + '\n';
}
