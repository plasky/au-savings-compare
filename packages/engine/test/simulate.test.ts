import { describe, expect, it } from 'vitest';
import { applicableBalance, compose } from '../src/rates.js';
import { simulate } from '../src/simulate.js';
import type { SavingsPlan, TermDepositPlan } from '../src/types.js';
import { cond, joint, partner, paul, product, row, simple, solo } from './helpers.js';

const people = [paul, partner];
// December 2026 has 31 days; January 2027 31; February 2027 28.
const START = '2026-12-01';

function savings(p: Partial<SavingsPlan> & Pick<SavingsPlan, 'product'>): SavingsPlan {
  return { kind: 'savings', id: 'acc', owners: solo, openingBalance: 10_000, ...p };
}

describe('tiers', () => {
  it('PER_TIER bands interest by portion; WHOLE_BALANCE applies the band containing the balance', () => {
    const perTier = row({ role: 'BASE', rate: 0.05, method: 'PER_TIER', tiers: [{ min: 0, max: 100_000 }] });
    expect(applicableBalance(perTier, 150_000)).toBe(100_000);
    const upper = row({ role: 'BASE', rate: 0.03, method: 'PER_TIER', tiers: [{ min: 100_000, max: null }] });
    expect(applicableBalance(upper, 150_000)).toBe(50_000);
    const whole = row({ role: 'BONUS', rate: 0.035, tiers: [{ min: 50_000, max: 250_000 }] });
    expect(applicableBalance(whole, 60_000)).toBe(60_000);
    expect(applicableBalance(whole, 40_000)).toBe(0);
  });
  it('BALANCE_CAP and MIN_BALANCE conditions act daily', () => {
    expect(applicableBalance(row({ role: 'BONUS', rate: 0.05, conditions: [cond('BALANCE_CAP', { amount: 100_000, period: 'NONE' })] }), 150_000)).toBe(100_000);
    expect(applicableBalance(row({ role: 'BASE', rate: 0.05, conditions: [cond('MIN_BALANCE', { amount: 3_000, period: 'NONE' })] }), 2_000)).toBe(0);
  });
});

describe('savings simulation (hand-calculated)', () => {
  it('flat 5% on $10,000 for December = 10,000 × 5% × 31/365 = $42.47, then compounds', () => {
    const r = simulate({ startDate: START, months: 2, people, accounts: [savings({ product: product([row({ role: 'BASE', rate: 0.05 })]) })] });
    expect(r.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.05, 31));
    expect(r.months[1]!.accounts.acc!.interest).toBe(simple(10_042.47, 0.05, 31));
  });

  it('banded PER_TIER schedule on $150,000: (100k × 5% + 50k × 3%) × 31/365', () => {
    const p = product([
      row({ role: 'BASE', rate: 0.05, method: 'PER_TIER', tiers: [{ min: 0, max: 100_000 }] }),
      row({ role: 'BASE', rate: 0.03, method: 'PER_TIER', tiers: [{ min: 100_000, max: null }] }),
    ]);
    const r = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p, openingBalance: 150_000 })] });
    expect(r.months[0]!.accounts.acc!.interest).toBe(Math.round(((100_000 * 0.05 + 50_000 * 0.03) * 31) / 365 * 100) / 100);
  });

  const bonusSaver = product([
    row({ role: 'BASE', rate: 0.001 }),
    row({ role: 'BONUS', rate: 0.054, conditions: [cond('MIN_DEPOSIT_AMOUNT', { amount: 1_000, externalOnly: true }), cond('MIN_PURCHASES', { count: 5 })] }),
  ]);

  it('pays the bonus only when the monthly conditions are met', () => {
    const met = simulate({
      startDate: START,
      months: 1,
      people,
      accounts: [savings({ product: bonusSaver, behaviour: { monthlyDeposit: 1_000, cardPurchasesPerMonth: 5 } })],
    });
    // Deposit lands on day 1, so the whole month accrues on $11,000.
    expect(met.months[0]!.accounts.acc!.interest).toBe(simple(11_000, 0.055, 31));
    expect(met.months[0]!.accounts.acc!.bonusMet).toBe(true);

    const missed = simulate({
      startDate: START,
      months: 1,
      people,
      accounts: [savings({ product: bonusSaver, behaviour: { monthlyDeposit: 1_000, cardPurchasesPerMonth: 4 } })],
    });
    expect(missed.months[0]!.accounts.acc!.interest).toBe(simple(11_000, 0.001, 31));
    expect(missed.months[0]!.accounts.acc!.bonusMet).toBe(false);
    expect(missed.months[0]!.accounts.acc!.unmet[0]).toContain('MIN_PURCHASES');
  });

  it('internal deposits do not satisfy an external-only deposit condition', () => {
    const r = simulate({
      startDate: START,
      months: 1,
      people,
      accounts: [savings({ product: bonusSaver, behaviour: { monthlyDeposit: 1_000, cardPurchasesPerMonth: 5, externalDeposits: false } })],
    });
    expect(r.months[0]!.accounts.acc!.bonusMet).toBe(false);
  });

  it('balance growth fails when withdrawals exceed deposits', () => {
    const grow = product([row({ role: 'BASE', rate: 0.001 }), row({ role: 'BONUS', rate: 0.05, conditions: [cond('DEPOSIT_BALANCE_INCREASED', { amount: 0.01 })] })]);
    const r = simulate({
      startDate: START,
      months: 1,
      people,
      accounts: [savings({ product: grow, behaviour: { monthlyDeposit: 500, monthlyWithdrawal: 600 } })],
    });
    expect(r.months[0]!.accounts.acc!.bonusMet).toBe(false);
  });

  it('additive intro applies for its period then expires', () => {
    const p = product([row({ role: 'BASE', rate: 0.05 }), row({ role: 'INTRO', rate: 0.006, introMonths: 1 })]);
    const r = simulate({ startDate: START, months: 2, people, accounts: [savings({ product: p })] });
    expect(r.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.056, 31));
    expect(r.months[0]!.accounts.acc!.intro).toBeGreaterThan(0);
    expect(r.months[1]!.accounts.acc!.intro).toBe(0);
  });

  it('intro rates do not apply to existing customers', () => {
    const p = product([row({ role: 'BASE', rate: 0.05 }), row({ role: 'INTRO', rate: 0.006, introMonths: 4 })]);
    const r = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p, newCustomer: false })] });
    expect(r.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.05, 31));
  });

  it('a TOTAL_RATE intro replaces the base rate (Rabobank pattern)', () => {
    const p = product([row({ role: 'BASE', rate: 0.037 }), row({ role: 'INTRO', rate: 0.058, combine: 'TOTAL_RATE', introMonths: 4 })]);
    const r = simulate({ startDate: START, months: 5, people, accounts: [savings({ product: p })] });
    expect(r.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.058, 31));
    // Month 5 (April 2027, 30 days) is after the intro.
    const aprOpening = r.months[3]!.accounts.acc!.balance;
    expect(r.months[4]!.accounts.acc!.interest).toBe(simple(aprOpening, 0.037, 30));
  });

  it('stacks distinct bonuses (Virgin Money pattern: 0.05 + 0.50 + 5.75 = 6.30%)', () => {
    const p = product([row({ role: 'BASE', rate: 0.0005 }), row({ role: 'BONUS', rate: 0.005 }), row({ role: 'BONUS', rate: 0.0575 })]);
    const r = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p })] });
    expect(r.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.063, 31));
  });

  it('alternative sets: best option by default, or the chosen one', () => {
    const p = product([
      row({ role: 'BASE', rate: 0.03, alternativeSet: 'plan', option: 'Standard' }),
      row({ role: 'BASE', rate: 0.0555, alternativeSet: 'plan', option: 'Ultra (fee)' }),
    ]);
    const best = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p })] });
    expect(best.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.0555, 31));
    const chosen = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p, choices: { plan: 'Standard' } })] });
    expect(chosen.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.03, 31));
  });

  it('age alternatives pick the band the holders qualify for', () => {
    const p = product([
      row({ role: 'BASE', rate: 0.001 }),
      row({ role: 'BONUS', rate: 0.049, alternativeSet: 'age', option: '31+', conditions: [cond('AGE_RANGE', { minAge: 31, period: 'NONE' })] }),
      row({ role: 'BONUS', rate: 0.06, alternativeSet: 'age', option: '≤30', conditions: [cond('AGE_RANGE', { maxAge: 30, period: 'NONE' })] }),
    ]);
    const r = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p, owners: joint })] });
    expect(r.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.05, 31));
  });

  it('sole-holder-only bonuses are lost on a joint account (Westpac Life Spend&Save)', () => {
    const p = product([
      row({ role: 'BASE', rate: 0.001 }),
      row({ role: 'BONUS', rate: 0.054 }),
      row({ role: 'BONUS', rate: 0.007, conditions: [cond('SOLE_HOLDER_ONLY', { period: 'NONE' })] }),
    ]);
    const soleR = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p })] });
    const jointR = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p, owners: joint })] });
    expect(soleR.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.062, 31));
    expect(jointR.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.055, 31));
  });

  it('warns about joint-ineligible and restricted products', () => {
    const p = product([row({ role: 'BASE', rate: 0.05 })], {
      eligibility: { minAge: null, maxAge: null, jointAllowed: false, restrictedTo: 'ADF members', newCustomersOnly: null },
    });
    const r = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p, owners: joint })] });
    expect(r.warnings.some((w) => w.includes('not available as a joint account'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('restricted to ADF members'))).toBe(true);
  });

  it('rate shifts move variable base rates but not fixed rows or additive bonuses', () => {
    const p = product([row({ role: 'BASE', rate: 0.01 }), row({ role: 'BONUS', rate: 0.04 })]);
    const r = simulate({ startDate: START, months: 1, people, accounts: [savings({ product: p })], rateShift: () => -0.005 });
    expect(r.months[0]!.accounts.acc!.interest).toBe(simple(10_000, 0.045, 31));
  });
});

describe('compose', () => {
  it('takes the larger of additive and total-rate rows', () => {
    const base = row({ id: 'b', role: 'BASE', rate: 0 });
    const tot = row({ id: 't', role: 'BONUS', rate: 0, combine: 'TOTAL_RATE' });
    const c = compose([base, tot], new Map([['b', 1], ['t', 60]]));
    expect(c).toMatchObject({ interest: 60, base: 1, bonus: 59 });
  });
});

describe('term deposits', () => {
  const td = product(
    [
      row({ role: 'BASE', rate: 0.05, variable: false, term: { min: 12, max: 12 }, payment: { type: 'MATURITY', everyMonths: null } }),
      row({ role: 'BASE', rate: 0.049, variable: false, term: { min: 12, max: 12 }, payment: { type: 'PERIODIC', everyMonths: 1 } }),
      row({ role: 'BASE', rate: 0.045, variable: false, term: { min: 6, max: 6 }, payment: { type: 'MATURITY', everyMonths: null } }),
      row({ role: 'BONUS', rate: 0.001, variable: false, term: { min: 12, max: 12 }, conditions: [cond('ONLINE_ONLY', { period: 'ONCE' })] }),
    ],
    { kind: 'term_deposit', name: 'Term Deposit' },
  );
  const plan = (p: Partial<TermDepositPlan> = {}): TermDepositPlan => ({
    kind: 'term_deposit',
    id: 'td',
    product: td,
    owners: joint,
    principal: 50_000,
    termMonths: 12,
    payment: 'MATURITY',
    ...p,
  });

  it('12 months at maturity: 50,000 × 5.1% × 365/365, credited in month 12, then rolls over', () => {
    const r = simulate({ startDate: START, months: 13, people, accounts: [plan()] });
    for (let m = 0; m < 11; m++) expect(r.months[m]!.accounts.td!.interest).toBe(0);
    expect(r.months[11]!.accounts.td!.interest).toBe(simple(50_000, 0.051, 365));
    expect(r.months[11]!.accounts.td!.balance).toBe(50_000 + simple(50_000, 0.051, 365));
    expect(r.months[12]!.accounts.td!.interest).toBe(0);
  });

  it('monthly interest is paid out at the monthly rate, not compounded', () => {
    const r = simulate({ startDate: START, months: 2, people, accounts: [plan({ payment: { everyMonths: 1 } })] });
    expect(r.months[0]!.accounts.td!.interest).toBe(simple(50_000, 0.05, 31));
    expect(r.months[0]!.accounts.td!.paidOut).toBe(simple(50_000, 0.05, 31));
    expect(r.months[1]!.accounts.td!.balance).toBe(50_000);
  });

  it('no rollover pays out principal and interest at maturity', () => {
    const r = simulate({ startDate: START, months: 6, people, accounts: [plan({ termMonths: 6, rollover: false })] });
    const last = r.months[5]!.accounts.td!;
    expect(last.balance).toBe(0);
    expect(last.paidOut).toBe(50_000 + last.interest);
  });

  it('warns when no rate exists for the term', () => {
    const r = simulate({ startDate: START, months: 1, people, accounts: [plan({ termMonths: 9 })] });
    expect(r.warnings.some((w) => w.includes('9-month'))).toBe(true);
  });
});

describe('household tax', () => {
  it('splits joint interest 50/50 and taxes each share at the holder’s own marginal rate', () => {
    // $100k at 5% from 1 July 2026 for 12 months, joint: Paul $100k income (32%), partner $40k (22%).
    const r = simulate({
      startDate: '2026-07-01',
      months: 12,
      people,
      accounts: [savings({ product: product([row({ role: 'BASE', rate: 0.05 })]), owners: joint, openingBalance: 100_000 })],
    });
    expect(r.years).toHaveLength(1);
    const y = r.years[0]!;
    expect(y.fy).toBe('2026-27');
    const half = y.interest / 2;
    expect(y.perPerson.p1!.interest).toBeCloseTo(half, 1);
    expect(y.perPerson.p1!.tax).toBeCloseTo(half * 0.32, 0);
    expect(y.perPerson.p2!.tax).toBeCloseTo(half * 0.22, 0);
    expect(r.summary.afterTax).toBeCloseTo(y.interest - y.tax, 2);
    // Interest ÷ average balance recovers the nominal rate (compounding shows up in the balance, not the rate).
    expect(r.summary.firstYearRate).toBeCloseTo(0.05, 3);
    expect(r.summary.endBalance).toBeGreaterThan(100_000 * 1.05);
  });

  it('assigns interest to the FY it is credited in and applies the 14% bracket from July 2027', () => {
    const r = simulate({
      startDate: '2027-01-01',
      months: 12,
      people: [{ id: 'p1', age: 45, taxableIncome: 40_000 }],
      accounts: [savings({ product: product([row({ role: 'BASE', rate: 0.05 })]), openingBalance: 100_000 })],
    });
    expect(r.years.map((y) => y.fy)).toEqual(['2026-27', '2027-28']);
    // 2026-27 marginal 22% (15% + LITO taper + Medicare); 2027-28: 21% (14% + 5% + 2%).
    const [a, b] = r.years;
    expect(a!.tax / a!.interest).toBeCloseTo(0.22, 2);
    expect(b!.tax / b!.interest).toBeCloseTo(0.21, 2);
  });

  it('reports real end balances using CPI', () => {
    const r = simulate({ startDate: START, months: 12, people, accounts: [savings({ product: product([row({ role: 'BASE', rate: 0 })]) })], cpi: 0.03 });
    expect(r.summary.endBalanceReal).toBeCloseTo(10_000 / 1.03, 2);
  });
});
