/** Turns app state into engine inputs, and runs the plan simulation. */
import {
  LONG_HELD,
  fyOf,
  marginalRate,
  ownersFor,
  rulesFor,
  simulate,
  type AccountPlan,
  type Behaviour,
  type CashEvent,
  type CatalogueProduct,
  type HeldAccount,
  type Person,
  type Scenario,
  type SimulationResult,
} from '@asc/engine';
import { cashEtf } from './data';
import type { AppState, HeldInput, PlanAccount } from './store';

/** YYYY-MM for a date (local time). */
export const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** Whole months from one YYYY-MM(-DD) to another. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

export function monthLabel(ym: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: style, year: 'numeric' });
}

/** One-off cash flows as month indexes from the simulation start (past months dropped). */
export function cashEventsOf(s: Pick<AppState, 'cashEvents'>, start: string): CashEvent[] {
  return s.cashEvents.map((e) => ({ month: monthsBetween(start, e.month), amount: e.amount })).filter((e) => e.month >= 0 && e.amount !== 0);
}

/** Simulations start on the first of next month. */
export function startDate(now = new Date()): string {
  return new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1)).toISOString().slice(0, 10);
}

export function peopleOf(s: Pick<AppState, 'people' | 'partner'>): Person[] {
  const list = s.partner ? s.people : [s.people[0]];
  return list.map((p) => ({ id: p.id, name: p.name || (p.id === 'p1' ? 'You' : 'Partner'), age: p.age, taxableIncome: p.income }));
}

export const displayName = (p: AppState['people'][number]) => p.name.trim() || (p.id === 'p1' ? 'You' : 'Your partner');

export function behaviourOf(s: AppState): Partial<Behaviour> {
  return {
    monthlyDeposit: s.monthlyDeposit,
    cardPurchasesPerMonth: s.purchases,
    monthlyWithdrawal: s.withdrawal,
    withdrawalsPerMonth: s.withdrawal > 0 ? 1 : 0,
    linkedAccounts: s.linkedAccounts,
    otherConditionsMet: s.otherConditionsMet,
    onlineOk: true,
  };
}

export function rateShiftOf(s: Pick<AppState, 'rateShift' | 'rateShiftFromMonth'>): ((m: number) => number) | undefined {
  if (!s.rateShift) return undefined;
  const { rateShift, rateShiftFromMonth } = s;
  return (m: number) => (m >= rateShiftFromMonth ? rateShift : 0);
}

export function scenarioOf(s: AppState, start = startDate()): Scenario {
  const people = peopleOf(s);
  return {
    people,
    owners: ownersFor(people, s.partner),
    startDate: start,
    behaviour: behaviourOf(s),
    newCustomer: s.newCustomer,
    includeRestricted: s.includeRestricted,
    cpi: s.cpi,
  };
}

export function withExtras(products: CatalogueProduct[], s: Pick<AppState, 'cashEtf'>): CatalogueProduct[] {
  return s.cashEtf.enabled ? [...products, cashEtf(s.cashEtf.yield)] : products;
}

export const hasNoWithdrawalRule = (p: CatalogueProduct) =>
  !p.rows.some((r) => r.role !== 'BASE' && r.conditions.some((c) => c.type === 'MAX_WITHDRAWALS' || c.type === 'MAX_WITHDRAWAL_AMOUNT' || c.type === 'DEPOSIT_BALANCE_INCREASED'));

/** The account withdrawals come out of: the chosen one, else the first savings account without a no-withdrawal bonus. */
export function withdrawalAccount(accounts: PlanAccount[], byKey: Map<string, CatalogueProduct>, chosen: string | null): string | null {
  const savings = accounts.filter((a) => a.termMonths === null && byKey.has(a.key));
  if (chosen && savings.some((a) => a.id === chosen)) return chosen;
  return (savings.find((a) => hasNoWithdrawalRule(byKey.get(a.key)!)) ?? savings[0])?.id ?? null;
}

export function planToAccounts(s: AppState, accounts: PlanAccount[], byKey: Map<string, CatalogueProduct>, start = startDate()): AccountPlan[] {
  const people = peopleOf(s);
  const owners = ownersFor(people, s.partner);
  const from = withdrawalAccount(accounts, byKey, s.withdrawFrom);
  const events = cashEventsOf(s, start);
  const out: AccountPlan[] = [];
  for (const a of accounts) {
    const product = byKey.get(a.key);
    if (!product || a.amount < 0) continue;
    if (a.termMonths !== null && product.kind === 'term_deposit') {
      if (a.amount <= 0) continue;
      out.push({ kind: 'term_deposit', id: a.id, product, owners, principal: a.amount, termMonths: a.termMonths, payment: 'MATURITY', rollover: true, newCustomer: s.newCustomer });
    } else {
      const takesWithdrawals = a.id === from;
      out.push({
        kind: 'savings',
        id: a.id,
        product,
        owners,
        openingBalance: a.amount,
        newCustomer: s.newCustomer,
        behaviour: {
          ...behaviourOf(s),
          monthlyDeposit: a.deposit,
          monthlyWithdrawal: takesWithdrawals ? s.withdrawal : 0,
          withdrawalsPerMonth: takesWithdrawals && s.withdrawal > 0 ? 1 : 0,
        },
        events: takesWithdrawals ? events : undefined,
      });
    }
  }
  return out;
}

export function runPlan(s: AppState, accounts: PlanAccount[], byKey: Map<string, CatalogueProduct>, months: number, start = startDate()): SimulationResult | null {
  const plans = planToAccounts(s, accounts, byKey, start);
  if (!plans.length) return null;
  return simulate({ startDate: start, months, people: peopleOf(s), accounts: plans, cpi: s.cpi, rateShift: rateShiftOf(s) });
}

/** Spread the monthly deposit: each account gets what its bonus asks for (in order), the first account the rest. */
export function suggestDeposits(accounts: Array<{ key: string; termMonths: number | null }>, byKey: Map<string, CatalogueProduct>, total: number, need: (p: CatalogueProduct) => number): number[] {
  let left = total;
  const out = accounts.map(() => 0);
  accounts.forEach((a, i) => {
    const p = byKey.get(a.key);
    if (!p || a.termMonths !== null) return;
    const n = need(p);
    if (n > 0 && n <= left) {
      out[i] = n;
      left -= n;
    }
  });
  const first = accounts.findIndex((a) => a.termMonths === null);
  if (first >= 0) out[first]! += left;
  return out;
}

// ---------- Accounts already held ----------

export const isCustomKey = (key: string) => key.startsWith('custom:');

/** An account that isn't in the bank data: one flat rate, entered by hand. */
export function customProduct(h: HeldInput): CatalogueProduct {
  const etf = cashEtf(h.custom?.rate ?? 0);
  return {
    ...etf,
    key: h.key,
    brand: h.custom?.name || 'Other account',
    name: '',
    notes: ['Entered by hand, so conditions and the guarantee check aren’t known.'],
    eligibility: { ...etf.eligibility, jointAllowed: null },
    group: h.key,
    description: null,
    rows: etf.rows.map((r) => ({ ...r, id: `${h.key}-rate` })),
  };
}

/** Product lookup that also knows hand-entered accounts. */
export function withHeldProducts(byKey: Map<string, CatalogueProduct>, held: HeldInput[]): Map<string, CatalogueProduct> {
  const custom = held.filter((h) => isCustomKey(h.key));
  if (!custom.length) return byKey;
  const m = new Map(byKey);
  for (const h of custom) m.set(h.key, customProduct(h));
  return m;
}

/** Months since a held account was opened (LONG_HELD if more than a year ago or unknown). */
export function heldAge(h: HeldInput, start: string): number {
  if (!h.opened) return LONG_HELD;
  return Math.max(0, monthsBetween(h.opened, start));
}

/** Months into the current term of a held term deposit. */
export function heldTdElapsed(h: HeldInput, start: string): number {
  if (!h.termMonths) return 0;
  if (!h.maturity) return 0;
  const left = Math.max(1, monthsBetween(start, h.maturity));
  return Math.max(0, h.termMonths - Math.min(h.termMonths, left));
}

export function heldSavingsMain(held: HeldInput[], byKey: Map<string, CatalogueProduct>): string | null {
  const savings = held.filter((h) => h.termMonths === null && byKey.has(h.key));
  return (savings.find((h) => hasNoWithdrawalRule(byKey.get(h.key)!)) ?? savings[0])?.id ?? null;
}

export function heldToAccounts(s: AppState, held: HeldInput[], byKey: Map<string, CatalogueProduct>, start = startDate()): AccountPlan[] {
  const owners = ownersFor(peopleOf(s), s.partner);
  const main = heldSavingsMain(held, byKey);
  const events = cashEventsOf(s, start);
  const out: AccountPlan[] = [];
  for (const h of held) {
    const product = byKey.get(h.key);
    if (!product || h.amount <= 0) continue;
    if (h.termMonths !== null) {
      out.push({
        kind: 'term_deposit',
        id: h.id,
        product,
        owners,
        principal: h.amount,
        termMonths: h.termMonths,
        payment: 'MATURITY',
        rollover: true,
        newCustomer: false,
        fixedRate: h.tdRate ?? undefined,
        elapsedMonths: heldTdElapsed(h, start),
      });
    } else {
      const isMain = h.id === main;
      out.push({
        kind: 'savings',
        id: h.id,
        product,
        owners,
        openingBalance: h.amount,
        newCustomer: true,
        introElapsedMonths: heldAge(h, start),
        behaviour: {
          ...behaviourOf(s),
          monthlyDeposit: h.deposit,
          monthlyWithdrawal: isMain ? s.withdrawal : 0,
          withdrawalsPerMonth: isMain && s.withdrawal > 0 ? 1 : 0,
        },
        events: isMain ? events : undefined,
      });
    }
  }
  return out;
}

export function runHeld(s: AppState, held: HeldInput[], byKey: Map<string, CatalogueProduct>, months: number, start = startDate()): SimulationResult | null {
  const plans = heldToAccounts(s, held, byKey, start);
  if (!plans.length) return null;
  return simulate({ startDate: start, months, people: peopleOf(s), accounts: plans, cpi: s.cpi, rateShift: rateShiftOf(s) });
}

/** Held accounts in the switching planner's terms. */
export function heldForSwitching(held: HeldInput[], byKey: Map<string, CatalogueProduct>, start = startDate()): HeldAccount[] {
  return held
    .filter((h) => byKey.has(h.key) && h.amount > 0)
    .map((h) => ({
      id: h.id,
      product: byKey.get(h.key)!,
      amount: h.amount,
      deposit: h.termMonths === null ? h.deposit : 0,
      termMonths: h.termMonths,
      elapsedMonths: h.termMonths === null ? heldAge(h, start) : heldTdElapsed(h, start),
      fixedRate: h.tdRate ?? undefined,
    }));
}

/** Roughly what's left of an extra dollar of interest after tax: one minus the holders' average marginal rate. */
export function afterTaxFactor(s: Pick<AppState, 'people' | 'partner'>): number {
  const rules = rulesFor(fyOf(new Date()));
  const people = s.partner ? s.people : [s.people[0]];
  return 1 - people.reduce((sum, p) => sum + marginalRate(p.income, rules), 0) / people.length;
}
