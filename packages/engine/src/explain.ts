/** Plain-English descriptions of conditions and rate rows, for people rather than logs. */
import type { Condition, ConditionType, Product, RateRow } from './types.js';

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

export interface BonusTask {
  /** Stable within a product, for remembering ticks. */
  id: string;
  type: ConditionType;
  text: string;
  amount: number | null;
  count: number | null;
}

const TASK_TYPES: ConditionType[] = ['MIN_DEPOSIT_AMOUNT', 'MIN_DEPOSITS', 'MIN_PURCHASES', 'DEPOSIT_BALANCE_INCREASED', 'MAX_WITHDRAWALS', 'MAX_WITHDRAWAL_AMOUNT', 'OTHER'];

/**
 * What has to happen each month for a savings account's bonus: the recurring
 * conditions on its bonus and intro rows, merged (the strictest of each kind)
 * and phrased as things to do. One-off conditions (new customer, age, opening
 * a linked account) aren't monthly tasks.
 */
export function monthlyTasks(p: Product): BonusTask[] {
  const merged = new Map<string, Condition>();
  for (const r of p.rows) {
    if (r.role === 'BASE' || r.alternativeSet) continue;
    for (const c of r.conditions) {
      if (!TASK_TYPES.includes(c.type) || c.period === 'ONCE' || c.period === 'NONE') continue;
      const k = c.type === 'OTHER' ? `OTHER:${c.description}` : c.type;
      const prev = merged.get(k);
      if (!prev) merged.set(k, c);
      else if (c.type === 'MAX_WITHDRAWALS' || c.type === 'MAX_WITHDRAWAL_AMOUNT') {
        if ((c.count ?? c.amount ?? 0) < (prev.count ?? prev.amount ?? 0)) merged.set(k, c);
      } else if ((c.amount ?? c.count ?? 0) > (prev.amount ?? prev.count ?? 0)) merged.set(k, c);
    }
  }
  const when = (c: Condition) => (c.period === 'QUARTER' ? ' this quarter' : c.period === 'YEAR' ? ' this year' : '');
  const tasks: BonusTask[] = [];
  for (const [k, c] of merged) {
    let text: string;
    switch (c.type) {
      case 'MIN_DEPOSIT_AMOUNT':
        text = `Deposit at least ${money(c.amount ?? 0)}${c.externalOnly ? ' from another bank or your pay' : ''}`;
        break;
      case 'MIN_DEPOSITS':
        text = `Make ${c.count ?? 1} or more deposits`;
        break;
      case 'MIN_PURCHASES':
        text = `Make ${c.count ?? 1} or more purchases with the card`;
        break;
      case 'DEPOSIT_BALANCE_INCREASED':
        text = (c.amount ?? 0) > 1 ? `Grow the balance by at least ${money(c.amount!)}, not counting interest` : 'Put in more than you take out, so the balance grows';
        break;
      case 'MAX_WITHDRAWALS':
        text = (c.count ?? 0) === 0 ? 'Don’t withdraw anything' : `Withdraw no more than ${c.count} times`;
        break;
      case 'MAX_WITHDRAWAL_AMOUNT':
        text = `Withdraw no more than ${money(c.amount ?? 0)}`;
        break;
      default:
        text = c.description.replace(/^Unstructured:\s*/, '') || 'Meet the bank’s other bonus conditions';
    }
    tasks.push({ id: k.slice(0, 80), type: c.type, text: text + when(c), amount: c.amount, count: c.count });
  }
  const order = (t: BonusTask) => TASK_TYPES.indexOf(t.type);
  return tasks.sort((a, b) => order(a) - order(b));
}

/** Months the longest intro rate lasts (3 when the bank doesn't say), or null without one. */
export function introLength(p: Product): number | null {
  const intro = p.rows.filter((r) => r.role === 'INTRO');
  return intro.length ? Math.max(...intro.map((r) => r.introMonths ?? 3)) : null;
}
