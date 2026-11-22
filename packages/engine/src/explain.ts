/** Plain-English descriptions of conditions and rate rows, for people rather than logs. */
import type { Condition, RateRow } from './types.js';

const money = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;
const per = (c: Condition) =>
  c.period === 'QUARTER' ? 'each quarter' : c.period === 'YEAR' ? 'each year' : c.period === 'ONCE' || c.period === 'NONE' ? '' : 'each month';
const join = (...parts: string[]) => parts.filter(Boolean).join(' ');

export function explainCondition(c: Condition): string {
  switch (c.type) {
    case 'MIN_DEPOSIT_AMOUNT':
      return join(`Deposit at least ${money(c.amount ?? 0)}`, c.externalOnly ? 'from outside the bank' : '', per(c));
    case 'MIN_DEPOSITS':
      return join(`Make ${c.count ?? 1} or more deposits`, per(c));
    case 'MIN_PURCHASES':
      return join(`Make ${c.count ?? 1} or more card purchases`, per(c));
    case 'DEPOSIT_BALANCE_INCREASED':
      return (c.amount ?? 0) > 1 ? join(`Grow the balance by ${money(c.amount!)}`, per(c)) : join('Grow the balance (before interest)', per(c));
    case 'MAX_WITHDRAWALS':
      return (c.count ?? 0) === 0 ? join('No withdrawals', per(c)) : join(`No more than ${c.count} withdrawals`, per(c));
    case 'MAX_WITHDRAWAL_AMOUNT':
      return join(`Withdraw no more than ${money(c.amount ?? 0)}`, per(c));
    case 'MIN_BALANCE':
      return `Keep at least ${money(c.amount ?? 0)} in the account`;
    case 'BALANCE_CAP':
      return `Applies up to ${money(c.amount ?? 0)}`;
    case 'NEW_CUSTOMER':
      return 'New customers only';
    case 'EXISTING_CUSTOMER':
      return 'Existing customers only';
    case 'AGE_RANGE':
      if (c.minAge !== null && c.maxAge !== null) return `Ages ${c.minAge} to ${c.maxAge}`;
      if (c.maxAge !== null) return `Aged ${c.maxAge} or under`;
      return `Aged ${c.minAge ?? 0} or over`;
    case 'LINKED_ACCOUNT':
      return 'Needs a linked everyday account';
    case 'ONLINE_ONLY':
      return 'Opened and managed online';
    case 'SOLE_HOLDER_ONLY':
      return 'Single-name accounts only';
    case 'OTHER':
      return c.description ? c.description.replace(/^Unstructured:\s*/, '') : 'Other conditions set by the bank';
  }
}

export function explainRole(r: RateRow): string {
  if (r.role === 'BASE') return r.variable ? 'Base rate' : 'Fixed rate';
  if (r.role === 'INTRO') return r.introMonths ? `Intro rate, first ${r.introMonths} months` : 'Intro rate';
  return r.combine === 'TOTAL_RATE' ? 'Bonus (total rate)' : 'Bonus';
}

export function explainTiers(r: RateRow): string {
  if (!r.tiers.length) return 'Any balance';
  const seen = new Set<string>();
  return r.tiers
    .filter((t) => {
      const k = `${t.min}:${t.max}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((t) => (t.max === null ? (t.min > 0 ? `Over ${money(t.min)}` : 'Any balance') : t.min > 0 ? `${money(t.min)} to ${money(t.max)}` : `Up to ${money(t.max)}`))
    .join(', ');
}

export function explainTerm(r: RateRow): string | null {
  if (!r.term) return null;
  const m = (n: number) => (n % 12 === 0 && n >= 12 ? `${n / 12} year${n === 12 ? '' : 's'}` : `${n} month${n === 1 ? '' : 's'}`);
  if (r.term.max === null || r.term.max === r.term.min) return m(r.term.min);
  return `${m(r.term.min)} to ${m(r.term.max)}`;
}
