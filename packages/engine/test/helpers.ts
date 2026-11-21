import type { Condition, ConditionType, Person, Product, RateRow } from '../src/types.js';

let n = 0;
export function row(p: Partial<RateRow> & Pick<RateRow, 'role' | 'rate'>): RateRow {
  return {
    id: p.id ?? `r${n++}`,
    combine: 'ADD_TO_BASE',
    variable: true,
    tiers: [],
    method: 'WHOLE_BALANCE',
    conditions: [],
    alternativeSet: null,
    option: null,
    introMonths: null,
    term: null,
    payment: null,
    ...p,
  };
}

export function cond(type: ConditionType, p: Partial<Condition> = {}): Condition {
  return { type, amount: null, count: null, minAge: null, maxAge: null, period: 'MONTH', externalOnly: null, description: '', ...p };
}

export function product(rows: RateRow[], p: Partial<Product> = {}): Product {
  return {
    key: p.key ?? 'test:product',
    brand: 'Test Bank',
    name: 'Test Saver',
    kind: 'savings',
    rows,
    eligibility: { minAge: null, maxAge: null, jointAllowed: null, restrictedTo: null, newCustomersOnly: null },
    reviewed: true,
    confidence: 'high',
    notes: [],
    abn: null,
    ...p,
  };
}

export const paul: Person = { id: 'p1', age: 45, taxableIncome: 100_000 };
export const partner: Person = { id: 'p2', age: 43, taxableIncome: 40_000 };
export const joint = { p1: 0.5, p2: 0.5 };
export const solo = { p1: 1 };

/** Interest for `days` days at `rate` on `balance`, 365-day year (the engine's convention). */
export const simple = (balance: number, rate: number, days: number) => Math.round(((balance * rate * days) / 365) * 100) / 100;
