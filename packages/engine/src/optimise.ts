/**
 * Automatic allocation: spread a balance (and the monthly deposit) across a
 * few accounts to maximise first-year interest.
 *
 * A greedy search over money in steps (plus jumps to the next balance tier, so
 * thresholds aren't missed), followed by a move-money-between-accounts pass.
 * Each account's interest comes from the engine's own simulation, so bonus
 * conditions, caps and intro periods are honoured. Tax is the same marginal
 * cost on every dollar of a household's interest, so pre-tax interest is the
 * objective.
 */
import { FCS_LIMIT } from './catalogue.js';
import { checkEligibility, rankSavings, rankTermDeposits, type Scenario } from './rank.js';
import { simulate } from './simulate.js';
import type { Product } from './types.js';

export interface OptimiseInput {
  scenario: Scenario;
  /** Total to allocate. */
  balance: number;
  /** Most that may go into term deposits. */
  lockable: number;
  /** Longest acceptable term (months); 0 = no term deposits. */
  lockMonths: number;
  products: Product[];
  maxAccounts: number;
  /** Keep each holder within the guarantee cap at each institution (null = ignore). */
  fcsLimit: number | null;
  groupOf: (p: Product) => string;
  /** Allocation step; default ~2% of the balance, at least $1,000. */
  step?: number;
  /** Candidates kept per shortlist (default 10). */
  shortlist?: number;
  /**
   * Savings accounts already held, by product key, with months since each was
   * opened: they're always candidates, keep any intro rate only for what's left
   * of it, and cost nothing to keep (see optimiseWithCost).
   */
  existing?: Record<string, number>;
}

export interface Allocation {
  product: Product;
  amount: number;
  /** Share of the household's monthly deposit sent to this account. */
  monthlyDeposit: number;
  /** Term (months) for a term deposit. */
  termMonths: number | null;
  /** First-year interest for this account. */
  interest: number;
}

export interface OptimiseResult {
  allocations: Allocation[];
  interest: number;
  /** Interest from the single best account, for comparison. */
  singleBest: number;
  evaluations: number;
}

const TERMS = [3, 6, 12, 24, 36, 60];

interface Candidate {
  id: string;
  product: Product;
  termMonths: number | null;
  /** Monthly deposit the bonus needs (savings only). */
  needs: number;
}

/** Monthly deposit a savings product's bonus rows ask for. */
export function depositNeed(p: Product): number {
  let need = 0;
  for (const r of p.rows) {
    if (r.role === 'BASE') continue;
    for (const c of r.conditions) {
      if (c.type === 'MIN_DEPOSIT_AMOUNT') need = Math.max(need, c.amount ?? 0);
      if (c.type === 'DEPOSIT_BALANCE_INCREASED') need = Math.max(need, c.amount && c.amount > 1 ? c.amount : 100);
    }
  }
  return need;
}

function tierEdges(p: Product): number[] {
  const edges = new Set<number>();
  for (const r of p.rows) for (const t of r.tiers) if (t.min > 1) edges.add(Math.ceil(t.min));
  return [...edges].sort((a, b) => a - b);
}

export function optimise(input: OptimiseInput): OptimiseResult {
  const s = input.scenario;
  const B = Math.max(0, input.balance);
  const D = Math.max(0, s.behaviour.monthlyDeposit ?? 0);
  const step = input.step ?? Math.max(1000, Math.round(B / 50 / 500) * 500);
  const short = input.shortlist ?? 10;
  const holders = Object.values(s.owners).filter((v) => v > 0).length || 1;
  const cap = input.fcsLimit === null ? Number.POSITIVE_INFINITY : (input.fcsLimit ?? FCS_LIMIT) * holders;
  const eligible = input.products.filter((p) => checkEligibility(p, s).ok);
  const savingsScenario: Scenario = { ...s, behaviour: { ...s.behaviour, monthlyWithdrawal: 0 } };

  // Shortlist: best savings accounts at a small and a full balance, and the best term deposits per allowed term.
  const pick = new Map<string, Candidate>();
  for (const bal of [Math.min(B, 20_000), Math.min(B, 250_000)]) {
    for (const r of rankSavings(eligible, Math.max(bal, 1000), savingsScenario).slice(0, short)) {
      pick.set(r.product.key, { id: r.product.key, product: r.product, termMonths: null, needs: depositNeed(r.product) });
    }
  }
  if (input.lockable > 0 && input.lockMonths > 0) {
    for (const t of TERMS.filter((x) => x <= input.lockMonths)) {
      for (const r of rankTermDeposits(eligible, Math.min(input.lockable, B), t, s).slice(0, 3)) {
        pick.set(`${r.product.key}@${t}`, { id: `${r.product.key}@${t}`, product: r.product, termMonths: t, needs: 0 });
      }
    }
  }
  for (const key of Object.keys(input.existing ?? {})) {
    const p = input.products.find((x) => x.key === key);
    if (p && p.kind === 'savings' && !pick.has(key)) pick.set(key, { id: key, product: p, termMonths: null, needs: depositNeed(p) });
  }
  const candidates = [...pick.values()];
  const held = input.existing ?? {};

  let evaluations = 0;
  const memo = new Map<string, number>();
  const accountInterest = (c: Candidate, amount: number, deposit: number): number => {
    if (amount <= 0 && deposit <= 0) return 0;
    const k = `${c.id}|${Math.round(amount)}|${Math.round(deposit)}`;
    const hit = memo.get(k);
    if (hit !== undefined) return hit;
    evaluations++;
    const r = simulate({
      startDate: s.startDate,
      months: 12,
      people: s.people,
      rateShift: s.rateShift,
      accounts: [
        c.termMonths === null
          ? {
              kind: 'savings',
              id: 'a',
              product: c.product,
              owners: s.owners,
              openingBalance: amount,
              newCustomer: c.id in held ? true : s.newCustomer,
              introElapsedMonths: held[c.id] ?? 0,
              behaviour: { ...savingsScenario.behaviour, monthlyDeposit: deposit },
            }
          : { kind: 'term_deposit', id: 'a', product: c.product, owners: s.owners, principal: amount, termMonths: c.termMonths, payment: 'MATURITY', rollover: true, newCustomer: s.newCustomer },
      ],
    });
    const v = r.summary.firstYearInterest;
    memo.set(k, v);
    return v;
  };

  /** Split the monthly deposit: each savings account gets what its bonus needs (best payers first); the rest goes to the largest. */
  const deposits = (alloc: Map<string, number>): Map<string, number> => {
    const out = new Map<string, number>();
    const savings = [...alloc.keys()].map((id) => pick.get(id)!).filter((c) => c.termMonths === null);
    if (!savings.length || D <= 0) return out;
    let left = D;
    const order = [...savings].sort((a, b) => (alloc.get(b.id) ?? 0) - (alloc.get(a.id) ?? 0));
    for (const c of order) {
      if (c.needs > 0 && c.needs <= left) {
        out.set(c.id, c.needs);
        left -= c.needs;
      }
    }
    const main = order[0]!;
    out.set(main.id, (out.get(main.id) ?? 0) + left);
    return out;
  };

  const value = (alloc: Map<string, number>): number => {
    const dep = deposits(alloc);
    let v = 0;
    for (const [id, amt] of alloc) v += accountInterest(pick.get(id)!, amt, dep.get(id) ?? 0);
    return v;
  };

  const groupTotal = (alloc: Map<string, number>, group: string) =>
    [...alloc].reduce((sum, [id, amt]) => sum + (input.groupOf(pick.get(id)!.product) === group ? amt : 0), 0);
  const lockedTotal = (alloc: Map<string, number>) => [...alloc].reduce((sum, [id, amt]) => sum + (pick.get(id)!.termMonths !== null ? amt : 0), 0);
  const fits = (alloc: Map<string, number>, c: Candidate, add: number): boolean => {
    if (!alloc.has(c.id) && alloc.size >= input.maxAccounts) return false;
    if (groupTotal(alloc, input.groupOf(c.product)) + add > cap + 0.5) return false;
    if (c.termMonths !== null && lockedTotal(alloc) + add > input.lockable + 0.5) return false;
    // Two accounts with the same product (e.g. two terms) aren't allowed.
    if (!alloc.has(c.id) && [...alloc.keys()].some((id) => pick.get(id)!.product.key === c.product.key)) return false;
    return true;
  };

  let alloc = new Map<string, number>();
  let current = 0;
  let remaining = B;
  while (remaining > 0.5) {
    let best: { id: string; add: number; gain: number; perDollar: number } | null = null;
    for (const c of candidates) {
      const have = alloc.get(c.id) ?? 0;
      const sizes = new Set([Math.min(step, remaining)]);
      for (const edge of tierEdges(c.product)) if (edge > have && edge - have <= remaining) sizes.add(edge - have);
      // Top up exactly to the guarantee cap or the lock-away limit when a full step won't fit.
      const roomCap = cap - groupTotal(alloc, input.groupOf(c.product));
      if (roomCap > 0.5 && roomCap < remaining) sizes.add(Math.floor(roomCap));
      if (c.termMonths !== null) {
        const roomLock = input.lockable - lockedTotal(alloc);
        if (roomLock > 0.5 && roomLock < remaining) sizes.add(Math.floor(roomLock));
      }
      for (const add of sizes) {
        if (add <= 0 || !fits(alloc, c, add)) continue;
        const next = new Map(alloc).set(c.id, have + add);
        const gain = value(next) - current;
        const perDollar = gain / add;
        if (!best || perDollar > best.perDollar + 1e-12) best = { id: c.id, add, gain, perDollar };
      }
    }
    if (!best) break; // every candidate is capped (FCS / account count); the rest stays unallocated
    alloc.set(best.id, (alloc.get(best.id) ?? 0) + best.add);
    current += best.gain;
    remaining -= best.add;
  }

  // Improve: swap a whole account for one not yet used, or move one step between accounts, while it helps.
  for (let pass = 0; pass < 60; pass++) {
    let improved = false;
    for (const [from, amt] of [...alloc]) {
      for (const c of candidates) {
        if (alloc.has(c.id)) continue;
        const trial = new Map(alloc);
        trial.delete(from);
        if (!fits(trial, c, amt)) continue;
        trial.set(c.id, amt);
        const v = value(trial);
        if (v > current + 0.5) {
          alloc = trial;
          current = v;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (improved) continue;
    for (const [from, amt] of [...alloc]) {
      const move = Math.min(step, amt);
      for (const c of candidates) {
        if (c.id === from) continue;
        const trial = new Map(alloc);
        if (amt - move <= 0.5) trial.delete(from);
        else trial.set(from, amt - move);
        if (!fits(trial, c, move)) continue;
        trial.set(c.id, (trial.get(c.id) ?? 0) + move);
        const v = value(trial);
        if (v > current + 0.5) {
          alloc = trial;
          current = v;
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
    if (!improved) break;
  }

  const dep = deposits(alloc);
  const allocations = [...alloc]
    .filter(([, amt]) => amt > 0.5)
    .map(([id, amount]) => {
      const c = pick.get(id)!;
      return { product: c.product, amount, monthlyDeposit: dep.get(id) ?? 0, termMonths: c.termMonths, interest: accountInterest(c, amount, dep.get(id) ?? 0) };
    })
    .sort((a, b) => b.amount - a.amount);

  const singleBest = Math.max(
    0,
    ...candidates.filter((c) => c.termMonths === null && (input.fcsLimit === null || B <= cap)).map((c) => accountInterest(c, B, D)),
  );
  return { allocations, interest: allocations.reduce((sum, a) => sum + a.interest, 0), singleBest, evaluations };
}

/**
 * Like `optimise`, but an extra account has to earn its keep: each account
 * beyond the first must add at least `accountCost` a year (before tax), so the
 * plan with the best interest-minus-hassle wins.
 */
export function optimiseWithCost(input: OptimiseInput, accountCost: number): OptimiseResult {
  if (accountCost <= 0 || input.maxAccounts <= 1) return optimise(input);
  const held = new Set(Object.keys(input.existing ?? {}));
  // Accounts already held cost nothing to keep; with none held, the first account is free.
  const cost = (r: OptimiseResult) => {
    const opened = r.allocations.filter((a) => !held.has(a.product.key) || a.termMonths !== null).length;
    return accountCost * Math.max(0, opened - (held.size === 0 ? 1 : 0));
  };
  let best: { r: OptimiseResult; score: number } | null = null;
  let evaluations = 0;
  for (let k = 1; k <= input.maxAccounts; k++) {
    const r = optimise({ ...input, maxAccounts: k });
    evaluations += r.evaluations;
    const score = r.interest - cost(r);
    if (!best || score > best.score + 0.5) best = { r, score };
    if (r.allocations.length < k) break; // more accounts didn't help, so larger k won't either
  }
  return { ...best!.r, evaluations };
}

export interface ConstraintValue {
  id: 'more-accounts' | 'any-gain' | 'fcs' | 'lock-more' | 'lock-longer' | 'purchases' | 'linked';
  label: string;
  /** Extra first-year interest (before tax) if this limit were relaxed. */
  gain: number;
}

const money = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;
const termWords = (m: number) => (m % 12 === 0 ? (m === 12 ? 'a year' : `${m / 12} years`) : `${m} months`);

/**
 * What each limit on the plan is costing: re-run the optimiser with one limit
 * relaxed at a time and report the extra first-year interest. Limits that
 * cost less than `minGain` are left out.
 */
export function constraintValues(input: OptimiseInput, accountCost: number, base?: OptimiseResult, minGain = 50): ConstraintValue[] {
  const b = base ?? optimiseWithCost(input, accountCost);
  const s = input.scenario;
  const variants: Array<{ id: ConstraintValue['id']; label: string; input: OptimiseInput; cost?: number }> = [];
  if (input.maxAccounts < 6 && b.allocations.length >= input.maxAccounts) {
    variants.push({ id: 'more-accounts', label: `Allowing ${input.maxAccounts + 1} accounts`, input: { ...input, maxAccounts: input.maxAccounts + 1 } });
  }
  if (accountCost > 0 && input.maxAccounts > 1) variants.push({ id: 'any-gain', label: 'Opening another account for any gain', input, cost: 0 });
  if (input.fcsLimit !== null) variants.push({ id: 'fcs', label: 'Going over the $250k guarantee at a bank', input: { ...input, fcsLimit: null } });
  if (input.lockable < input.balance) {
    const step = Math.max(25_000, Math.round((input.balance * 0.25) / 5000) * 5000);
    const lockable = Math.min(input.balance, input.lockable + step);
    const lockMonths = Math.max(input.lockMonths, 12);
    variants.push({
      id: 'lock-more',
      label: `Locking away ${money(lockable)}${lockMonths !== input.lockMonths || input.lockable === 0 ? ` for ${termWords(lockMonths)}` : ''}`,
      input: { ...input, lockable, lockMonths },
    });
  }
  const longer = TERMS.find((t) => t > input.lockMonths);
  if (input.lockable > 0 && longer) variants.push({ id: 'lock-longer', label: `Locking it away for ${termWords(longer)}`, input: { ...input, lockMonths: longer } });
  if ((s.behaviour.cardPurchasesPerMonth ?? 0) < 5) {
    variants.push({
      id: 'purchases',
      label: 'Making 5 card purchases a month at each bank',
      input: { ...input, scenario: { ...s, behaviour: { ...s.behaviour, cardPurchasesPerMonth: 5 } } },
    });
  }
  if (s.behaviour.linkedAccounts === false) {
    variants.push({
      id: 'linked',
      label: 'Opening an everyday account where a bonus needs one',
      input: { ...input, scenario: { ...s, behaviour: { ...s.behaviour, linkedAccounts: true } } },
    });
  }
  const out: ConstraintValue[] = [];
  for (const v of variants) {
    const r = optimiseWithCost(v.input, v.cost ?? accountCost);
    const gain = r.interest - b.interest;
    if (gain >= minGain) out.push({ id: v.id, label: v.label, gain });
  }
  return out.sort((x, y) => y.gain - x.gain);
}
