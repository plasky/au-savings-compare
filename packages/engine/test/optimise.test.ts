import { describe, expect, it } from 'vitest';
import { checkEligibility, ownersFor, rankSavings, rankTermDeposits, type Scenario } from '../src/rank.js';
import { depositNeed, optimise } from '../src/optimise.js';
import { explainCondition } from '../src/explain.js';
import type { Product } from '../src/types.js';
import { cond, product, row } from './helpers.js';

const people = [
  { id: 'p1', age: 40, taxableIncome: 100_000 },
  { id: 'p2', age: 38, taxableIncome: 90_000 },
];
const scenario = (over: Partial<Scenario> = {}): Scenario => ({
  people,
  owners: ownersFor(people, true),
  startDate: '2026-12-01',
  behaviour: { monthlyDeposit: 0, cardPurchasesPerMonth: 0 },
  newCustomer: true,
  includeRestricted: false,
  ...over,
});

// A bonus account capped at $50k, a flat 4.5% account, and a 12-month TD at 5%.
const capped = product([row({ role: 'BASE', rate: 0.01 }), row({ role: 'BONUS', rate: 0.05, tiers: [{ min: 0, max: 50_000 }], method: 'PER_TIER' })], {
  key: 'a:capped',
  name: 'Capped Bonus',
});
const flat = product([row({ role: 'BASE', rate: 0.045 })], { key: 'b:flat', name: 'Flat Saver' });
const td = product([row({ role: 'BASE', rate: 0.05, variable: false, term: { min: 12, max: 12 }, payment: { type: 'MATURITY', everyMonths: null } })], {
  key: 'c:td',
  name: 'Term Deposit',
  kind: 'term_deposit',
});
const groups: Record<string, string> = { 'a:capped': 'abn:1', 'b:flat': 'abn:2', 'c:td': 'abn:3' };
const groupOf = (p: Product) => groups[p.key] ?? p.key;

describe('eligibility and ranking', () => {
  it('explains why a product is out of reach', () => {
    const kids = product([row({ role: 'BASE', rate: 0.05 })], {
      eligibility: { minAge: null, maxAge: 17, jointAllowed: false, restrictedTo: 'Kids under 18', newCustomersOnly: null },
    });
    expect(checkEligibility(kids, scenario()).reasons).toEqual(['Only for Kids under 18', 'Not available as a joint account', 'Account holders must be 17 or under']);
    expect(checkEligibility(flat, scenario()).ok).toBe(true);
  });

  it('ranks savings by first-year interest and term deposits by rate', () => {
    const s = rankSavings([capped, flat, td], 100_000, scenario());
    expect(s.map((r) => r.product.key)).toEqual(['b:flat', 'a:capped']);
    expect(s[0]!.rate).toBeCloseTo(0.045, 3);
    const t = rankTermDeposits([capped, flat, td], 100_000, 12, scenario());
    expect(t.map((r) => [r.product.key, r.rate])).toEqual([['c:td', 0.05]]);
  });
});

describe('optimise', () => {
  it('fills the capped bonus first, then the next best account', () => {
    const r = optimise({ scenario: scenario(), balance: 100_000, lockable: 0, lockMonths: 0, products: [capped, flat, td], maxAccounts: 3, fcsLimit: 250_000, groupOf });
    const by = Object.fromEntries(r.allocations.map((a) => [a.product.key, a.amount]));
    // Just under the cap: credited interest pushes the balance over $50k during the year.
    expect(by['a:capped']).toBeGreaterThanOrEqual(46_000);
    expect(by['a:capped']).toBeLessThanOrEqual(50_000);
    expect(by['a:capped']! + by['b:flat']!).toBe(100_000);
    expect(r.interest).toBeGreaterThan(r.singleBest);
  });

  it('uses a term deposit only up to the amount that can be locked away', () => {
    const r = optimise({ scenario: scenario(), balance: 100_000, lockable: 20_000, lockMonths: 12, products: [capped, flat, td], maxAccounts: 3, fcsLimit: 250_000, groupOf });
    const by = Object.fromEntries(r.allocations.map((a) => [a.product.key, a.amount]));
    expect(by['c:td']).toBe(20_000);
    expect(by['a:capped']).toBeGreaterThanOrEqual(46_000);
    expect(by['a:capped']! + by['b:flat']!).toBe(80_000);
  });

  it('respects the account limit and the guarantee cap', () => {
    const one = optimise({ scenario: scenario(), balance: 100_000, lockable: 0, lockMonths: 0, products: [capped, flat], maxAccounts: 1, fcsLimit: 250_000, groupOf });
    expect(one.allocations).toHaveLength(1);
    expect(one.allocations[0]!.product.key).toBe('b:flat');

    const sole = scenario({ owners: { p1: 1 } });
    const capped250 = optimise({ scenario: sole, balance: 400_000, lockable: 0, lockMonths: 0, products: [flat], maxAccounts: 2, fcsLimit: 250_000, groupOf });
    expect(capped250.allocations.reduce((s, a) => s + a.amount, 0)).toBe(250_000);
  });

  it('sends each bonus account the deposit it needs', () => {
    const needsDeposit = product(
      [row({ role: 'BASE', rate: 0.01 }), row({ role: 'BONUS', rate: 0.05, tiers: [{ min: 0, max: 50_000 }], conditions: [cond('MIN_DEPOSIT_AMOUNT', { amount: 1000 })] })],
      { key: 'd:deposit', name: 'Deposit Bonus' },
    );
    expect(depositNeed(needsDeposit)).toBe(1000);
    const r = optimise({
      scenario: scenario({ behaviour: { monthlyDeposit: 1500 } }),
      balance: 100_000,
      lockable: 0,
      lockMonths: 0,
      products: [needsDeposit, flat],
      maxAccounts: 2,
      fcsLimit: null,
      groupOf,
    });
    const d = r.allocations.find((a) => a.product.key === 'd:deposit')!;
    expect(d.monthlyDeposit).toBeGreaterThanOrEqual(1000);
    expect(r.allocations.reduce((s, a) => s + a.monthlyDeposit, 0)).toBe(1500);
  });
});

describe('explainCondition', () => {
  it('reads like an instruction', () => {
    expect(explainCondition(cond('MIN_DEPOSIT_AMOUNT', { amount: 1000, externalOnly: true }))).toBe('Deposit at least $1,000 from outside the bank each month');
    expect(explainCondition(cond('MAX_WITHDRAWALS', { count: 0 }))).toBe('No withdrawals each month');
    expect(explainCondition(cond('AGE_RANGE', { minAge: 18, maxAge: 29 }))).toBe('Ages 18 to 29');
  });
});

describe('bonus bands', () => {
  it('pays an "up to $X" bonus on the first $X instead of dropping it above $X', async () => {
    const { applicableBalance, markCappedBands } = await import('../src/rates.js');
    const [bonus] = markCappedBands([row({ role: 'BONUS', rate: 0.05, tiers: [{ min: 0, max: 50_000 }], method: 'WHOLE_BALANCE' })]);
    expect(applicableBalance(bonus!, 40_000)).toBe(40_000);
    expect(applicableBalance(bonus!, 60_000)).toBe(50_000);
    const [band] = markCappedBands([row({ role: 'BASE', rate: 0.02, tiers: [{ min: 0, max: 50_000 }], method: 'WHOLE_BALANCE' })]);
    expect(applicableBalance(band!, 60_000)).toBe(0);
  });

  it('keeps a ladder of bonus bands whole-balance, capping only the top band (ME HomeME pattern)', async () => {
    const { applicableBalance, markCappedBands } = await import('../src/rates.js');
    const [low, high] = markCappedBands([
      row({ role: 'BONUS', rate: 0.058, tiers: [{ min: 0, max: 100_000 }], method: 'WHOLE_BALANCE' }),
      row({ role: 'BONUS', rate: 0.058, tiers: [{ min: 100_000.01, max: 1_000_000 }], method: 'WHOLE_BALANCE' }),
    ]);
    expect([applicableBalance(low!, 150_000), applicableBalance(high!, 150_000)]).toEqual([0, 150_000]);
    expect([applicableBalance(low!, 80_000), applicableBalance(high!, 80_000)]).toEqual([80_000, 0]);
    expect(applicableBalance(high!, 1_200_000)).toBe(1_000_000);
  });
});

describe('optimiseWithCost', () => {
  it('drops an extra account that adds less than it is worth to the household', async () => {
    const { optimiseWithCost } = await import('../src/optimise.js');
    const base = { scenario: scenario(), balance: 100_000, lockable: 0, lockMonths: 0, products: [capped, flat], maxAccounts: 2, fcsLimit: 250_000, groupOf };
    // Splitting gains about 0.5% x $50k = ~$250-500 a year over Flat Saver alone.
    expect(optimiseWithCost(base, 0).allocations).toHaveLength(2);
    expect(optimiseWithCost(base, 5000).allocations).toHaveLength(1);
  });
});

describe('monthlyTasks', () => {
  it('turns recurring bonus conditions into one task per kind, strictest first', async () => {
    const { monthlyTasks, introLength } = await import('../src/explain.js');
    const p = product([
      row({ role: 'BASE', rate: 0.01 }),
      row({ role: 'BONUS', rate: 0.03, conditions: [cond('MIN_DEPOSIT_AMOUNT', { amount: 500 }), cond('MAX_WITHDRAWALS', { count: 1 })] }),
      row({ role: 'BONUS', rate: 0.01, conditions: [cond('MIN_DEPOSIT_AMOUNT', { amount: 1000, externalOnly: true }), cond('MAX_WITHDRAWALS', { count: 0 })] }),
      row({ role: 'INTRO', rate: 0.01, introMonths: 4, conditions: [cond('NEW_CUSTOMER', { period: 'ONCE' }), cond('MIN_PURCHASES', { count: 5 })] }),
    ]);
    expect(monthlyTasks(p).map((t) => t.text)).toEqual([
      'Deposit at least $1,000 from another bank or your pay',
      'Make 5 or more purchases with the card',
      'Don’t withdraw anything',
    ]);
    expect(introLength(p)).toBe(4);
  });
});

describe('held accounts and one-off cash flows', () => {
  it('ends an intro rate on time for an account opened earlier', async () => {
    const { simulate } = await import('../src/simulate.js');
    const p = product([row({ role: 'BASE', rate: 0.01 }), row({ role: 'INTRO', rate: 0.03, introMonths: 4 })]);
    const run = (elapsed: number) =>
      simulate({ startDate: '2026-12-01', months: 4, people, accounts: [{ kind: 'savings', id: 'a', product: p, owners: { p1: 1 }, openingBalance: 100_000, introElapsedMonths: elapsed }] })
        .months.map((m) => m.accounts.a!.intro > 0);
    expect(run(0)).toEqual([true, true, true, true]);
    expect(run(2)).toEqual([true, true, false, false]);
  });

  it('applies one-off deposits and withdrawals, and a withdrawal breaks a no-withdrawal bonus that month', async () => {
    const { simulate } = await import('../src/simulate.js');
    const p = product([row({ role: 'BASE', rate: 0.01 }), row({ role: 'BONUS', rate: 0.04, conditions: [cond('MAX_WITHDRAWALS', { count: 0 })] })]);
    const r = simulate({
      startDate: '2026-12-01',
      months: 3,
      people,
      accounts: [{ kind: 'savings', id: 'a', product: p, owners: { p1: 1 }, openingBalance: 50_000, events: [{ month: 0, amount: 10_000 }, { month: 1, amount: -20_000 }] }],
    });
    const m = r.months.map((x) => x.accounts.a!);
    expect(m.map((x) => x.bonusMet)).toEqual([true, false, true]);
    expect(m[0]!.avgBalance).toBeCloseTo(60_000, 0);
    expect(Math.round(m[2]!.avgBalance / 1000)).toBe(40);
  });

  it('keeps a held term deposit at its locked-in rate until it matures, then rolls over at today’s rate', async () => {
    const { simulate } = await import('../src/simulate.js');
    const r = simulate({
      startDate: '2026-12-01',
      months: 4,
      people,
      accounts: [{ kind: 'term_deposit', id: 't', product: td, owners: { p1: 1 }, principal: 100_000, termMonths: 12, payment: 'MATURITY', fixedRate: 0.04, elapsedMonths: 10 }],
    });
    const interest = r.months.map((m) => m.accounts.t!.interest);
    expect(interest[0]).toBe(0);
    expect(interest[1]).toBeGreaterThan(3000); // matures at the end of month 2: ~a year at 4%
    expect(interest[1]).toBeLessThan(4100);
    expect(r.months[2]!.accounts.t!.balance).toBeGreaterThan(103_000);
  });
});

describe('switchingPlan', () => {
  it('moves money when an intro rate ends and a better account is available', async () => {
    const { switchingPlan } = await import('../src/switching.js');
    const introSaver = product([row({ role: 'BASE', rate: 0.02 }), row({ role: 'INTRO', rate: 0.04, introMonths: 4 })], { key: 'i:intro', name: 'Intro Saver' });
    const steps = switchingPlan({
      base: { scenario: scenario(), lockable: 0, lockMonths: 0, products: [introSaver, flat], maxAccounts: 2, fcsLimit: null, groupOf },
      holdings: [{ id: 'h1', product: introSaver, amount: 100_000, deposit: 0, termMonths: null, elapsedMonths: 0 }],
      horizonMonths: 24,
      accountCost: 250,
    });
    expect(steps).toHaveLength(1);
    expect(steps[0]!.month).toBe(4);
    expect(steps[0]!.reasons[0]).toContain('intro rate ends');
    expect(steps[0]!.moves[0]).toMatchObject({ fromKey: 'i:intro', toKey: 'b:flat' });
    expect(steps[0]!.gain).toBeGreaterThan(1500); // 4.5% vs 2% on ~$101k
  });

  it('stays put when nothing beats the current account by enough', async () => {
    const { switchingPlan } = await import('../src/switching.js');
    const steps = switchingPlan({
      base: { scenario: scenario(), lockable: 0, lockMonths: 0, products: [capped, flat], maxAccounts: 1, fcsLimit: null, groupOf },
      holdings: [{ id: 'h1', product: flat, amount: 100_000, deposit: 0, termMonths: null, elapsedMonths: 999 }],
      horizonMonths: 24,
      accountCost: 250,
    });
    expect(steps).toEqual([]);
  });

  it('reinvests a maturing term deposit and leaves locked money alone until then', async () => {
    const { switchingPlan } = await import('../src/switching.js');
    const steps = switchingPlan({
      base: { scenario: scenario(), lockable: 0, lockMonths: 0, products: [flat, td], maxAccounts: 2, fcsLimit: null, groupOf },
      holdings: [
        { id: 't1', product: td, amount: 50_000, deposit: 0, termMonths: 12, elapsedMonths: 9, fixedRate: 0.03 },
        { id: 's1', product: flat, amount: 50_000, deposit: 0, termMonths: null, elapsedMonths: 999 },
      ],
      horizonMonths: 24,
      accountCost: 0,
      minGain: 50,
    });
    // At maturity (month 3) the deposit can't be relocked (lockable 0), so it moves to the 4.5% saver.
    expect(steps[0]?.month).toBe(3);
    expect(steps[0]?.moves.some((mv) => mv.fromKey === 'c:td' && mv.toKey === 'b:flat')).toBe(true);
  });
});

describe('constraintValues', () => {
  it('prices the limits that hold the plan back', async () => {
    const { constraintValues } = await import('../src/optimise.js');
    const input = { scenario: scenario(), balance: 100_000, lockable: 0, lockMonths: 0, products: [capped, flat, td], maxAccounts: 1, fcsLimit: 250_000, groupOf };
    expect(constraintValues(input, 0).map((x) => x.id)).toContain('more-accounts');
    const two = constraintValues({ ...input, maxAccounts: 3 }, 0);
    const lock = two.find((x) => x.id === 'lock-more')!;
    expect(lock.label).toBe('Locking away $25,000 for a year');
    expect(lock.gain).toBeGreaterThan(50); // 5% TD vs 4.5% saver on $25k
    expect(two.every((x) => x.gain >= 50)).toBe(true);
  });
});
