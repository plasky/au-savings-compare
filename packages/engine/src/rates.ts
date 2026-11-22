import type { Behaviour, Condition, Person, RateRow } from './types.js';

const EPS = 1e-9;

/** Balance a row's rate applies to on a given day (0 if it doesn't apply). */
export function applicableBalance(row: RateRow, balance: number): number {
  if (balance <= 0) return 0;
  for (const c of row.conditions) {
    if (c.type === 'MIN_BALANCE' && c.amount !== null && balance < c.amount - EPS) return 0;
  }
  let amount: number;
  if (row.tiers.length === 0) {
    amount = balance;
  } else if (row.method === 'PER_TIER') {
    amount = row.tiers.reduce((sum, t) => {
      const top = Math.min(balance, t.max ?? Number.POSITIVE_INFINITY);
      return sum + Math.max(0, top - t.min);
    }, 0);
  } else if (row.tiers.some((t) => balance >= t.min - EPS && (t.max === null || balance <= t.max + EPS))) {
    amount = balance;
  } else if (row.capped) {
    // Above the top band of a bonus: paid on the amount up to the band's limit.
    const top = Math.max(...row.tiers.map((t) => t.max ?? Number.POSITIVE_INFINITY));
    amount = balance > top ? top : 0;
  } else {
    amount = 0;
  }
  const cap = row.conditions.find((c) => c.type === 'BALANCE_CAP' && c.amount !== null);
  return cap ? Math.min(amount, cap.amount!) : amount;
}

/**
 * Mark the top balance band of each bonus or intro "ladder" as capped. Banks
 * publish "bonus on balances up to $250,000" as a WHOLE_BALANCE band of
 * $0–$250,000, but pay it on the first $250,000 of a larger balance rather
 * than dropping it. A band is the top of its ladder when no other row of the
 * same role covers balances above it (ME's $0–100k and $100k–1M bands: only
 * the $1M band is capped).
 */
export function markCappedBands(rows: RateRow[]): RateRow[] {
  const top = (r: RateRow) => Math.max(...r.tiers.map((t) => t.max ?? Number.POSITIVE_INFINITY));
  return rows.map((r) => {
    if (r.role === 'BASE' || r.method !== 'WHOLE_BALANCE' || !r.tiers.length || r.capped !== undefined) return r;
    const limit = top(r);
    if (!Number.isFinite(limit)) return r;
    const coveredAbove = rows.some((o) => o !== r && o.role === r.role && o.tiers.length > 0 && top(o) > limit + 1);
    return coveredAbove ? r : { ...r, capped: true };
  });
}

/** One day's interest from a row at an annual rate (simple daily accrual on a 365-day year). */
export function dailyInterest(row: RateRow, balance: number, shift = 0): number {
  const rate = Math.max(0, row.rate + shift);
  return (applicableBalance(row, balance) * rate) / 365;
}

/** Whether a rate scenario shift applies to this row (variable base or total rates). */
export function shiftApplies(row: RateRow): boolean {
  return row.variable && (row.role === 'BASE' || row.combine === 'TOTAL_RATE');
}

export interface MonthActivity {
  depositsTotal: number;
  externalDepositsTotal: number;
  depositsCount: number;
  withdrawalsTotal: number;
  withdrawalsCount: number;
  purchases: number;
  openingBalance: number;
  closingBalanceExInterest: number;
}

export interface ConditionContext {
  joint: boolean;
  holderAges: number[];
  newCustomer: boolean;
  behaviour: Behaviour;
}

/** Evaluate one condition for a month. Balance-based conditions (MIN_BALANCE, BALANCE_CAP) are handled daily. */
export function conditionMet(c: Condition, a: MonthActivity, ctx: ConditionContext): boolean {
  switch (c.type) {
    case 'MIN_DEPOSIT_AMOUNT':
      return (c.externalOnly ? a.externalDepositsTotal : a.depositsTotal) >= (c.amount ?? 0) - EPS;
    case 'MIN_DEPOSITS':
      return a.depositsCount >= (c.count ?? 1);
    case 'MIN_PURCHASES':
      return a.purchases >= (c.count ?? 1);
    case 'DEPOSIT_BALANCE_INCREASED':
      return a.closingBalanceExInterest - a.openingBalance >= Math.max(c.amount ?? 0.01, 0.01) - EPS;
    case 'MAX_WITHDRAWALS':
      return a.withdrawalsCount <= (c.count ?? 0);
    case 'MAX_WITHDRAWAL_AMOUNT':
      return a.withdrawalsTotal <= (c.amount ?? 0) + EPS;
    case 'MIN_BALANCE':
    case 'BALANCE_CAP':
      return true;
    case 'NEW_CUSTOMER':
      return ctx.newCustomer;
    case 'EXISTING_CUSTOMER':
      return !ctx.newCustomer;
    case 'AGE_RANGE':
      // Conservative for joint accounts: every holder must qualify.
      return ctx.holderAges.every((age) => (c.minAge === null || age >= c.minAge) && (c.maxAge === null || age <= c.maxAge));
    case 'LINKED_ACCOUNT':
      return ctx.behaviour.linkedAccounts;
    case 'ONLINE_ONLY':
      return ctx.behaviour.onlineOk;
    case 'SOLE_HOLDER_ONLY':
      return !ctx.joint;
    case 'OTHER':
      return ctx.behaviour.otherConditionsMet;
  }
}

export function describeCondition(c: Condition): string {
  const bits: string[] = [c.type];
  if (c.amount !== null) bits.push(`$${c.amount.toLocaleString('en-AU')}`);
  if (c.count !== null) bits.push(`×${c.count}`);
  if (c.minAge !== null || c.maxAge !== null) bits.push(`age ${c.minAge ?? ''}–${c.maxAge ?? ''}`);
  return c.description ? `${bits.join(' ')} (${c.description})` : bits.join(' ');
}

export function holderAges(owners: Record<string, number>, people: Person[], monthIndex: number): number[] {
  return Object.keys(owners)
    .map((id) => people.find((p) => p.id === id))
    .filter((p): p is Person => !!p)
    .map((p) => p.age + Math.floor(monthIndex / 12));
}

/** Rows active in a given month before monthly conditions: intro rows only within their intro period. */
export function rowsActiveInMonth(rows: RateRow[], monthIndex: number, newCustomer: boolean): RateRow[] {
  return rows.filter((r) => {
    if (r.role !== 'INTRO') return true;
    if (!newCustomer) return false;
    return monthIndex < (r.introMonths ?? 3);
  });
}

export interface Composition {
  interest: number;
  base: number;
  bonus: number;
  intro: number;
}

/**
 * Combine a month's per-row interest into the credited amount:
 * base + additive bonuses + additive intros, unless a TOTAL_RATE row pays more
 * (a total rate replaces base + additive adjustments).
 */
export function compose(rows: RateRow[], accrued: Map<string, number>): Composition {
  const sum = (pred: (r: RateRow) => boolean) => rows.filter(pred).reduce((s, r) => s + (accrued.get(r.id) ?? 0), 0);
  const base = sum((r) => r.role === 'BASE');
  const addBonus = sum((r) => r.role === 'BONUS' && r.combine === 'ADD_TO_BASE');
  const addIntro = sum((r) => r.role === 'INTRO' && r.combine === 'ADD_TO_BASE');
  const additive = base + addBonus + addIntro;
  let best: Composition = { interest: additive, base, bonus: addBonus, intro: addIntro };
  for (const r of rows) {
    if (r.combine !== 'TOTAL_RATE') continue;
    const v = accrued.get(r.id) ?? 0;
    if (v > best.interest + EPS) {
      best = { interest: v, base: Math.min(base, v), bonus: r.role === 'BONUS' ? v - Math.min(base, v) : 0, intro: r.role === 'INTRO' ? v - Math.min(base, v) : 0 };
    }
  }
  return best;
}

/**
 * Resolve alternative sets: keep, per set, the chosen option (by label), or
 * if none chosen, the option with the most accrued interest this month.
 */
export function resolveAlternatives(rows: RateRow[], accrued: Map<string, number>, choices: Record<string, string> = {}): RateRow[] {
  const sets = new Map<string, Map<string, RateRow[]>>();
  const free: RateRow[] = [];
  for (const r of rows) {
    if (!r.alternativeSet) {
      free.push(r);
      continue;
    }
    const opts = sets.get(r.alternativeSet) ?? new Map<string, RateRow[]>();
    const label = r.option ?? r.id;
    opts.set(label, [...(opts.get(label) ?? []), r]);
    sets.set(r.alternativeSet, opts);
  }
  const kept = [...free];
  for (const [set, opts] of sets) {
    const chosen = choices[set];
    if (chosen && opts.has(chosen)) {
      kept.push(...opts.get(chosen)!);
      continue;
    }
    let bestLabel: string | null = null;
    let bestValue = -1;
    for (const [label, rs] of opts) {
      const v = rs.reduce((s, r) => s + (accrued.get(r.id) ?? 0), 0);
      if (v > bestValue) {
        bestValue = v;
        bestLabel = label;
      }
    }
    if (bestLabel !== null) kept.push(...opts.get(bestLabel)!);
  }
  return kept;
}
