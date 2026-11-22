/** Rank products for a household: eligibility, then a simulated first year (savings) or term (term deposits). */
import { simulate, tdRate } from './simulate.js';
import type { Behaviour, Person, Product, TermDepositPlan } from './types.js';

export interface Scenario {
  people: Person[];
  /** Ownership of new accounts: equal shares for a joint account, or one person. */
  owners: Record<string, number>;
  /** YYYY-MM-01 */
  startDate: string;
  behaviour: Partial<Behaviour>;
  /** New to each bank (intro rates, new-customer offers). */
  newCustomer: boolean;
  includeRestricted: boolean;
  rateShift?: (monthIndex: number) => number;
  cpi?: number;
}

export interface Eligibility {
  ok: boolean;
  reasons: string[];
}

/** Equal-share joint ownership across everyone, or the first person alone. */
export function ownersFor(people: Person[], joint: boolean): Record<string, number> {
  if (!people.length) return {};
  if (!joint || people.length === 1) return { [people[0]!.id]: 1 };
  return Object.fromEntries(people.map((p) => [p.id, 1 / people.length]));
}

export function checkEligibility(p: Product, s: Pick<Scenario, 'people' | 'owners' | 'includeRestricted' | 'newCustomer'>): Eligibility {
  const reasons: string[] = [];
  const holders = s.people.filter((x) => (s.owners[x.id] ?? 0) > 0);
  const e = p.eligibility;
  if (e.restrictedTo && !s.includeRestricted) reasons.push(`Only for ${e.restrictedTo.replace(/^only (for )?/i, '')}`);
  if (holders.length > 1 && e.jointAllowed === false) reasons.push('Not available as a joint account');
  if (e.minAge !== null && holders.some((h) => h.age < e.minAge!)) reasons.push(`Account holders must be ${e.minAge} or over`);
  if (e.maxAge !== null && holders.some((h) => h.age > e.maxAge!)) reasons.push(`Account holders must be ${e.maxAge} or under`);
  if (e.newCustomersOnly && !s.newCustomer) reasons.push('New customers only');
  return { ok: reasons.length === 0, reasons };
}

export interface Ranked {
  product: Product;
  eligibility: Eligibility;
  /** Interest over the period (first 12 months for savings; the term for term deposits). */
  interest: number;
  afterTax: number;
  /** Effective annual rate over the period. */
  rate: number;
  months: number;
  /** Months in which every bonus condition was met. */
  bonusMonths: number;
  /** Bonus or intro conditions missed at least once. */
  unmet: string[];
  warnings: string[];
  termMonths: number | null;
}

export function rankSavings(products: Product[], balance: number, s: Scenario, opts: { months?: number; includeIneligible?: boolean } = {}): Ranked[] {
  const months = opts.months ?? 12;
  const out: Ranked[] = [];
  for (const p of products) {
    if (p.kind !== 'savings') continue;
    const eligibility = checkEligibility(p, s);
    if (!eligibility.ok && !opts.includeIneligible) continue;
    const r = simulate({
      startDate: s.startDate,
      months,
      people: s.people,
      cpi: s.cpi,
      rateShift: s.rateShift,
      accounts: [{ kind: 'savings', id: 'a', product: p, owners: s.owners, openingBalance: balance, behaviour: s.behaviour, newCustomer: s.newCustomer }],
    });
    const acct = r.months.map((m) => m.accounts.a!);
    out.push({
      product: p,
      eligibility,
      interest: r.summary.firstYearInterest,
      afterTax: r.summary.firstYearAfterTax,
      rate: r.summary.perAccountFirstYear.a?.rate ?? 0,
      months,
      bonusMonths: acct.filter((m) => m.bonusMet).length,
      unmet: [...new Set(acct.flatMap((m) => m.unmet))],
      warnings: r.warnings,
      termMonths: null,
    });
  }
  return out.sort((a, b) => b.interest - a.interest || a.product.key.localeCompare(b.product.key));
}

export function rankTermDeposits(
  products: Product[],
  balance: number,
  termMonths: number,
  s: Scenario,
  opts: { payment?: TermDepositPlan['payment']; includeIneligible?: boolean } = {},
): Ranked[] {
  const out: Ranked[] = [];
  for (const p of products) {
    if (p.kind !== 'term_deposit') continue;
    const eligibility = checkEligibility(p, s);
    if (!eligibility.ok && !opts.includeIneligible) continue;
    const plan: TermDepositPlan = {
      kind: 'term_deposit',
      id: 't',
      product: p,
      owners: s.owners,
      principal: balance,
      termMonths,
      payment: opts.payment ?? 'MATURITY',
      rollover: false,
      newCustomer: s.newCustomer,
    };
    const warnings: string[] = [];
    const rate = tdRate(plan, balance, warnings);
    if (rate <= 0) continue;
    const r = simulate({ startDate: s.startDate, months: termMonths, people: s.people, cpi: s.cpi, accounts: [plan] });
    out.push({
      product: p,
      eligibility,
      interest: r.summary.interest,
      afterTax: r.summary.afterTax,
      rate,
      months: termMonths,
      bonusMonths: termMonths,
      unmet: [],
      warnings: [...warnings, ...r.warnings],
      termMonths,
    });
  }
  return out.sort((a, b) => b.rate - a.rate || b.interest - a.interest || a.product.key.localeCompare(b.product.key));
}
