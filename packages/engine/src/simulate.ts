import {
  compose,
  conditionMet,
  dailyInterest,
  holderAges,
  markCappedBands,
  resolveAlternatives,
  rowsActiveInMonth,
  shiftApplies,
  type MonthActivity,
} from './rates.js';
import { explainCondition } from './explain.js';
import { fyOf, fyStartYear, incrementalTax, rulesFor, TAX_RULES } from './tax.js';
import {
  DEFAULT_BEHAVIOUR,
  type AccountMonth,
  type MonthResult,
  type Person,
  type RateRow,
  type SavingsPlan,
  type SimulationInput,
  type SimulationResult,
  type TermDepositPlan,
  type YearResult,
} from './types.js';

const round2 = (x: number) => Math.round(x * 100) / 100;

const cappedCache = new WeakMap<RateRow[], RateRow[]>();
function savingsRows(rows: RateRow[]): RateRow[] {
  let out = cappedCache.get(rows);
  if (!out) {
    out = markCappedBands(rows);
    cappedCache.set(rows, out);
  }
  return out;
}

function monthStart(start: Date, offset: number): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
}

function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------- Savings ----------

/** Simulate one savings account for one month with `days` days. Mutates and returns the new balance. */
function stepSavings(
  plan: SavingsPlan,
  state: { balance: number },
  m: number,
  days: number,
  people: Person[],
  rateShift: (m: number) => number,
): AccountMonth {
  const b = { ...DEFAULT_BEHAVIOUR, ...plan.behaviour };
  const newCustomer = plan.newCustomer ?? true;
  const joint = Object.keys(plan.owners).length > 1;
  const rows = rowsActiveInMonth(savingsRows(plan.product.rows), m, newCustomer);
  const accrued = new Map<string, number>(rows.map((r) => [r.id, 0]));
  const shift = rateShift(m);
  const activity: MonthActivity = {
    depositsTotal: 0,
    externalDepositsTotal: 0,
    depositsCount: 0,
    withdrawalsTotal: 0,
    withdrawalsCount: 0,
    purchases: b.cardPurchasesPerMonth,
    openingBalance: state.balance,
    closingBalanceExInterest: state.balance,
  };
  const depositDay = Math.min(Math.max(1, b.depositDay), days);
  const withdrawalDay = Math.min(Math.max(1, b.withdrawalDay), days);

  let balanceDays = 0;
  for (let day = 1; day <= days; day++) {
    if (day === depositDay && b.monthlyDeposit > 0) {
      state.balance += b.monthlyDeposit;
      activity.depositsTotal += b.monthlyDeposit;
      if (b.externalDeposits) activity.externalDepositsTotal += b.monthlyDeposit;
      activity.depositsCount += Math.max(1, b.depositsPerMonth);
    }
    if (day === withdrawalDay && b.monthlyWithdrawal > 0) {
      const amount = Math.min(state.balance, b.monthlyWithdrawal);
      state.balance -= amount;
      activity.withdrawalsTotal += amount;
      activity.withdrawalsCount += Math.max(1, b.withdrawalsPerMonth);
    }
    for (const r of rows) accrued.set(r.id, accrued.get(r.id)! + dailyInterest(r, state.balance, shiftApplies(r) ? shift : 0));
    balanceDays += state.balance;
  }
  activity.closingBalanceExInterest = state.balance;

  const ctx = { joint, holderAges: holderAges(plan.owners, people, m), newCustomer, behaviour: b };
  const unmet: string[] = [];
  let bonusMet = true;
  const met = rows.filter((r) => {
    const failed = r.conditions.filter((c) => !conditionMet(c, activity, ctx));
    if (failed.length && r.role !== 'BASE') unmet.push(...failed.map(explainCondition));
    if (failed.length && r.role === 'BONUS') bonusMet = false;
    return failed.length === 0;
  });
  const kept = resolveAlternatives(met, accrued, plan.choices);
  const c = compose(kept, accrued);
  const interest = round2(c.interest);
  state.balance += interest;
  return {
    balance: state.balance,
    interest,
    base: c.base,
    bonus: c.bonus,
    intro: c.intro,
    bonusMet,
    unmet: [...new Set(unmet)],
    paidOut: 0,
    avgBalance: balanceDays / days,
  };
}

// ---------- Term deposits ----------

interface TdState {
  principal: number;
  rate: number;
  termStart: number; // month index
  accruedSincePayment: number;
}

function paymentMatches(row: RateRow, payment: TermDepositPlan['payment'], termMonths: number): boolean {
  if (!row.payment) return payment === 'MATURITY';
  if (payment === 'MATURITY') return row.payment.type === 'MATURITY' || (row.payment.everyMonths ?? 0) >= termMonths;
  return row.payment.type === 'PERIODIC' && row.payment.everyMonths === payment.everyMonths;
}

function termMatches(row: RateRow, months: number): boolean {
  if (!row.term) return false;
  const { min, max } = row.term;
  return max === null ? Math.abs(min - months) <= 0.5 || months >= min - 0.5 : months >= min - 0.5 && months <= max + 0.5;
}

/** Rate for a TD: best matching base row + matching additive bonus rows. */
export function tdRate(plan: TermDepositPlan, principal: number, warnings: string[]): number {
  const label = `${plan.product.brand} — ${plan.product.name}`;
  const okConditions = plan.conditionsMet ?? true;
  const newCustomer = plan.newCustomer ?? true;
  const usable = (r: RateRow) =>
    r.conditions.every((c) => {
      if (c.type === 'MIN_BALANCE') return principal >= (c.amount ?? 0);
      if (c.type === 'NEW_CUSTOMER') return newCustomer;
      if (c.type === 'EXISTING_CUSTOMER') return !newCustomer || okConditions;
      return okConditions;
    }) && (r.tiers.length === 0 || r.tiers.some((t) => principal >= t.min && (t.max === null || principal <= t.max)));
  const forTerm = plan.product.rows.filter((r) => r.role === 'BASE' && termMatches(r, plan.termMonths));
  const bases = forTerm.filter(usable);
  let candidates = bases.filter((r) => paymentMatches(r, plan.payment, plan.termMonths));
  if (!candidates.length && bases.length) {
    warnings.push(`${label}: no rate for the chosen payment frequency; using the best rate for the term`);
    candidates = bases;
  }
  if (!candidates.length) {
    warnings.push(
      forTerm.length
        ? `${label}: $${Math.round(principal).toLocaleString('en-AU')} is outside the amounts accepted for a ${plan.termMonths}-month term`
        : `${label}: no rate published for a ${plan.termMonths}-month term`,
    );
    return 0;
  }
  const base = Math.max(...candidates.map((r) => r.rate));
  const bonus = plan.product.rows
    .filter((r) => r.role === 'BONUS' && r.combine === 'ADD_TO_BASE' && (!r.term || termMatches(r, plan.termMonths)) && usable(r))
    .reduce((s, r) => s + r.rate, 0);
  return base + bonus;
}

function stepTermDeposit(
  plan: TermDepositPlan,
  state: TdState,
  m: number,
  days: number,
  rateShift: (m: number) => number,
  warnings: string[],
): AccountMonth {
  const avgBalance = state.principal;
  for (let day = 1; day <= days; day++) state.accruedSincePayment += (state.principal * state.rate) / 365;
  const monthsIntoTerm = m - state.termStart + 1;
  let interest = 0;
  let paidOut = 0;
  const maturing = monthsIntoTerm >= plan.termMonths;
  if (plan.payment !== 'MATURITY' && monthsIntoTerm % plan.payment.everyMonths === 0) {
    paidOut = round2(state.accruedSincePayment);
    interest = paidOut;
    state.accruedSincePayment = 0;
  }
  if (maturing) {
    const maturityInterest = round2(state.accruedSincePayment);
    state.accruedSincePayment = 0;
    interest += maturityInterest;
    if (plan.rollover ?? true) {
      state.principal += maturityInterest;
      state.termStart = m + 1;
      state.rate = Math.max(0, tdRate(plan, state.principal, warnings) + rateShift(m + 1));
    } else {
      paidOut += maturityInterest + state.principal;
      state.principal = 0;
      state.rate = 0;
    }
  }
  return { balance: state.principal, interest, base: interest, bonus: 0, intro: 0, bonusMet: true, unmet: [], paidOut, avgBalance };
}

// ---------- Orchestration ----------

export function simulate(input: SimulationInput): SimulationResult {
  const start = new Date(`${input.startDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) throw new Error(`invalid startDate ${input.startDate}`);
  const rateShift = input.rateShift ?? (() => 0);
  const rules = input.taxRules ?? TAX_RULES;
  const cpi = input.cpi ?? 0.025;
  const warnings: string[] = [];

  for (const a of input.accounts) {
    const total = Object.values(a.owners).reduce((s, v) => s + v, 0);
    if (Math.abs(total - 1) > 1e-6) warnings.push(`${a.id}: ownership shares sum to ${total}, not 1`);
    const label = `${a.product.brand} — ${a.product.name}`;
    if (Object.keys(a.owners).length > 1 && a.product.eligibility.jointAllowed === false) warnings.push(`${label}: not available as a joint account`);
    if (a.product.eligibility.restrictedTo) warnings.push(`${label}: restricted to ${a.product.eligibility.restrictedTo}`);
    for (const r of a.product.rows) {
      if (r.role === 'INTRO' && r.introMonths === null) warnings.push(`${label}: intro rate without a stated period; assumed 3 months`);
    }
  }

  const savingsState = new Map<string, { balance: number }>();
  const tdState = new Map<string, TdState>();
  for (const a of input.accounts) {
    if (a.kind === 'savings') savingsState.set(a.id, { balance: a.openingBalance });
    else tdState.set(a.id, { principal: a.principal, rate: tdRate(a, a.principal, warnings) + rateShift(0), termStart: 0, accruedSincePayment: 0 });
  }

  const months: MonthResult[] = [];
  for (let m = 0; m < input.months; m++) {
    const date = monthStart(start, m);
    const days = daysInMonth(date);
    const accounts: Record<string, AccountMonth> = {};
    for (const a of input.accounts) {
      if (a.kind === 'savings') {
        const st = savingsState.get(a.id)!;
        accounts[a.id] = stepSavings(a, st, m, days, input.people, rateShift);
      } else {
        const st = tdState.get(a.id)!;
        accounts[a.id] = stepTermDeposit(a, st, m, days, rateShift, warnings);
      }
    }
    const values = Object.values(accounts);
    months.push({
      index: m,
      date: iso(date),
      days,
      accounts,
      totalBalance: round2(values.reduce((s, v) => s + v.balance, 0)),
      totalInterest: round2(values.reduce((s, v) => s + v.interest, 0)),
    });
  }

  // Tax by financial year (interest is assessed in the FY it is credited).
  const firstFy = fyOf(start);
  const byFy = new Map<string, YearResult>();
  for (const mo of months) {
    // Credited on the last day of the month.
    const credit = new Date(Date.UTC(Number(mo.date.slice(0, 4)), Number(mo.date.slice(5, 7)), 0));
    const fy = fyOf(credit);
    const yr = byFy.get(fy) ?? { fy, interestByAccount: {}, perPerson: {}, interest: 0, tax: 0, afterTax: 0 };
    for (const a of input.accounts) {
      const v = mo.accounts[a.id]!.interest;
      yr.interestByAccount[a.id] = (yr.interestByAccount[a.id] ?? 0) + v;
      for (const [pid, share] of Object.entries(a.owners)) {
        const pp = yr.perPerson[pid] ?? { interest: 0, tax: 0 };
        pp.interest += v * share;
        yr.perPerson[pid] = pp;
      }
      yr.interest += v;
    }
    byFy.set(fy, yr);
  }
  const years = [...byFy.values()].sort((a, b) => a.fy.localeCompare(b.fy));
  for (const yr of years) {
    const r = rulesFor(yr.fy, rules);
    const yearsIn = fyStartYear(yr.fy) - fyStartYear(firstFy);
    for (const [pid, pp] of Object.entries(yr.perPerson)) {
      const person = input.people.find((p) => p.id === pid);
      if (!person) {
        warnings.push(`unknown owner ${pid}; interest not taxed`);
        continue;
      }
      const base = person.taxableIncome * (1 + (person.incomeGrowth ?? 0)) ** yearsIn;
      pp.tax = round2(incrementalTax(base, pp.interest, r));
      pp.interest = round2(pp.interest);
      yr.tax += pp.tax;
    }
    yr.interest = round2(yr.interest);
    yr.tax = round2(yr.tax);
    yr.afterTax = round2(yr.interest - yr.tax);
    for (const k of Object.keys(yr.interestByAccount)) yr.interestByAccount[k] = round2(yr.interestByAccount[k]!);
  }

  // First-12-month figures (tax apportioned from the FYs those months fall in).
  const first12 = months.slice(0, 12);
  const firstYearInterest = round2(first12.reduce((s, mo) => s + mo.totalInterest, 0));
  const balanceYears = (id?: string) =>
    first12.reduce((s, mo) => {
      const accts = id ? [mo.accounts[id]!] : Object.values(mo.accounts);
      return s + accts.reduce((x, a) => x + a.avgBalance, 0) * (mo.days / 365);
    }, 0);
  let firstYearTax = 0;
  for (const mo of first12) {
    const credit = new Date(Date.UTC(Number(mo.date.slice(0, 4)), Number(mo.date.slice(5, 7)), 0));
    const yr = byFy.get(fyOf(credit))!;
    if (yr.interest > 0) firstYearTax += (mo.totalInterest / yr.interest) * yr.tax;
  }
  const perAccountFirstYear: Record<string, { interest: number; rate: number }> = {};
  for (const a of input.accounts) {
    const interest = round2(first12.reduce((s, mo) => s + mo.accounts[a.id]!.interest, 0));
    const by = balanceYears(a.id);
    perAccountFirstYear[a.id] = { interest, rate: by > 0 ? interest / by : 0 };
  }
  const totalBy = balanceYears();

  const interest = round2(years.reduce((s, y) => s + y.interest, 0));
  const tax = round2(years.reduce((s, y) => s + y.tax, 0));
  const endBalance = months.at(-1)?.totalBalance ?? 0;
  return {
    months,
    years,
    summary: {
      interest,
      tax,
      afterTax: round2(interest - tax),
      endBalance,
      endBalanceReal: round2(endBalance / (1 + cpi) ** (input.months / 12)),
      firstYearInterest,
      firstYearAfterTax: round2(firstYearInterest - firstYearTax),
      firstYearRate: totalBy > 0 ? firstYearInterest / totalBy : 0,
      perAccountFirstYear,
    },
    warnings: [...new Set(warnings)],
  };
}
