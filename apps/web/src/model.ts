/** Turns app state into engine inputs, and runs the plan simulation. */
import {
  ownersFor,
  simulate,
  type AccountPlan,
  type Behaviour,
  type CatalogueProduct,
  type Person,
  type Scenario,
  type SimulationResult,
} from '@asc/engine';
import { cashEtf } from './data';
import type { AppState, PlanAccount } from './store';

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

export function planToAccounts(s: AppState, accounts: PlanAccount[], byKey: Map<string, CatalogueProduct>): AccountPlan[] {
  const people = peopleOf(s);
  const owners = ownersFor(people, s.partner);
  const from = withdrawalAccount(accounts, byKey, s.withdrawFrom);
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
      });
    }
  }
  return out;
}

export function runPlan(s: AppState, accounts: PlanAccount[], byKey: Map<string, CatalogueProduct>, months: number, start = startDate()): SimulationResult | null {
  const plans = planToAccounts(s, accounts, byKey);
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
