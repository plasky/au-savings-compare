/**
 * A switching timeline: as intro rates end and term deposits mature, where
 * should the money go next? Steps through those moments, re-runs the optimiser
 * on the money that's free to move (savings plus any deposit that just
 * matured), and keeps a move only if it beats staying put by enough to be
 * worth the hassle.
 */
import { introLength } from './explain.js';
import { optimiseWithCost, type OptimiseInput } from './optimise.js';
import { simulate } from './simulate.js';
import type { AccountPlan, Product } from './types.js';

export interface HeldAccount {
  /** Stable id (e.g. the app's account id). */
  id: string;
  product: Product;
  amount: number;
  /** Monthly deposit into this account (savings). */
  deposit: number;
  /** Term for a term deposit, null for savings. */
  termMonths: number | null;
  /** Savings: months since opening (999 = long held). Term deposit: months into the current term. */
  elapsedMonths: number;
  /** Term deposit: rate locked in for the current term. */
  fixedRate?: number;
}

export interface SwitchMove {
  fromKey: string | null;
  toKey: string;
  amount: number;
  toTermMonths: number | null;
}

export interface SwitchStep {
  month: number;
  /** YYYY-MM-01 */
  date: string;
  reasons: string[];
  moves: SwitchMove[];
  /** Extra interest (before tax) over the following 12 months versus staying put. */
  gain: number;
  holdings: HeldAccount[];
}

export interface SwitchingInput {
  /** Optimiser settings; balance and existing are worked out at each step. */
  base: Omit<OptimiseInput, 'balance' | 'existing'>;
  holdings: HeldAccount[];
  horizonMonths: number;
  accountCost: number;
  /** Smallest gain worth acting on (default: the account cost, at least $50). */
  minGain?: number;
}

const LONG_HELD = 999;

function addMonths(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
}

function plansFor(holdings: HeldAccount[], input: SwitchingInput): AccountPlan[] {
  const s = input.base.scenario;
  return holdings
    .filter((h) => h.amount > 0.5)
    .map((h) =>
      h.termMonths === null
        ? {
            kind: 'savings' as const,
            id: h.id,
            product: h.product,
            owners: s.owners,
            openingBalance: h.amount,
            newCustomer: true,
            introElapsedMonths: h.elapsedMonths,
            behaviour: { ...s.behaviour, monthlyDeposit: h.deposit, monthlyWithdrawal: 0 },
          }
        : {
            kind: 'term_deposit' as const,
            id: h.id,
            product: h.product,
            owners: s.owners,
            principal: h.amount,
            termMonths: h.termMonths,
            payment: 'MATURITY' as const,
            rollover: true,
            fixedRate: h.fixedRate,
            elapsedMonths: h.elapsedMonths % h.termMonths,
          },
    );
}

/** Months (from now) at which something changes for a holding, within the horizon. */
function eventsFor(h: HeldAccount, now: number, horizon: number): Array<{ month: number; reason: string; id: string }> {
  const out: Array<{ month: number; reason: string; id: string }> = [];
  const name = `${h.product.brand} ${h.product.name}`;
  if (h.termMonths === null) {
    const intro = introLength(h.product);
    if (intro !== null && h.elapsedMonths < intro) {
      const m = now + intro - h.elapsedMonths;
      if (m < horizon) out.push({ month: m, reason: `${name}: intro rate ends`, id: h.id });
    }
  } else {
    for (let m = now + h.termMonths - (h.elapsedMonths % h.termMonths); m < horizon; m += h.termMonths) {
      out.push({ month: m, reason: `${name}: term deposit matures`, id: h.id });
    }
  }
  return out;
}

export interface Position {
  key: string;
  termMonths: number | null;
  amount: number;
}

/** Transfers that turn one set of balances into another: money leaving accounts that shrink goes to accounts that grow. */
export function describeMoves(before: Position[], after: Position[]): SwitchMove[] {
  const id = (p: Position) => (p.termMonths === null ? p.key : `${p.key}@${p.termMonths}`);
  const was = new Map<string, number>();
  for (const p of before) was.set(id(p), (was.get(id(p)) ?? 0) + p.amount);
  const now = new Map<string, Position>();
  for (const p of after) now.set(id(p), { ...p, amount: (now.get(id(p))?.amount ?? 0) + p.amount });
  const outs = [...was].map(([k, v]) => ({ key: k.split('@')[0]!, left: v - (now.get(k)?.amount ?? 0) })).filter((x) => x.left > 0.5);
  const ins = [...now].map(([k, p]) => ({ p, need: p.amount - (was.get(k) ?? 0) })).filter((x) => x.need > 0.5);
  const moves: SwitchMove[] = [];
  for (const i of ins) {
    for (const o of outs) {
      if (i.need <= 0.5) break;
      const amt = Math.min(i.need, o.left);
      if (amt <= 0.5) continue;
      moves.push({ fromKey: o.key, toKey: i.p.key, amount: Math.round(amt), toTermMonths: i.p.termMonths });
      i.need -= amt;
      o.left -= amt;
    }
    // Growth the old balances can't cover (e.g. new deposits) comes from outside.
    if (i.need > 0.5) moves.push({ fromKey: null, toKey: i.p.key, amount: Math.round(i.need), toTermMonths: i.p.termMonths });
  }
  return moves;
}

export function switchingPlan(input: SwitchingInput): SwitchStep[] {
  const s = input.base.scenario;
  const minGain = input.minGain ?? Math.max(50, input.accountCost);
  let holdings = input.holdings.map((h) => ({ ...h }));
  let now = 0;
  let nextId = 0;
  const steps: SwitchStep[] = [];
  const queue = holdings.flatMap((h) => eventsFor(h, 0, input.horizonMonths));

  while (queue.length) {
    queue.sort((a, b) => a.month - b.month);
    const m = queue[0]!.month;
    const due = queue.filter((e) => e.month === m);
    queue.splice(0, due.length);
    const reasons = [...new Set(due.filter((e) => holdings.some((h) => h.id === e.id)).map((e) => e.reason))];
    if (!reasons.length || m <= now || m >= input.horizonMonths) continue;

    // Move everything forward to month m.
    const plans = plansFor(holdings, input);
    if (plans.length) {
      const r = simulate({ startDate: addMonths(s.startDate, now), months: m - now, people: s.people, accounts: plans, rateShift: s.rateShift });
      const last = r.months.at(-1)!;
      holdings = holdings.map((h) => ({ ...h, amount: last.accounts[h.id]?.balance ?? h.amount, elapsedMonths: h.elapsedMonths + (m - now) }));
    }
    now = m;

    const free = holdings.filter((h) => h.termMonths === null || h.elapsedMonths % h.termMonths === 0);
    const locked = holdings.filter((h) => !free.includes(h));
    const total = free.reduce((sum, h) => sum + h.amount, 0);
    if (total < 1) continue;

    const startDate = addMonths(s.startDate, m);
    const stay = simulate({ startDate, months: 12, people: s.people, accounts: plansFor(free, input), rateShift: s.rateShift }).summary.firstYearInterest;
    const existing = Object.fromEntries(free.filter((h) => h.termMonths === null).map((h) => [h.product.key, h.elapsedMonths]));
    const lockedTotal = locked.reduce((sum, h) => sum + h.amount, 0);
    const best = optimiseWithCost(
      {
        ...input.base,
        scenario: { ...s, startDate },
        balance: total,
        existing,
        lockable: Math.max(0, input.base.lockable - lockedTotal),
        maxAccounts: Math.max(1, input.base.maxAccounts - locked.length),
      },
      input.accountCost,
    );
    const gain = best.interest - stay;
    if (gain < minGain) continue;

    const moves = describeMoves(
      free.map((h) => ({ key: h.product.key, termMonths: h.termMonths, amount: h.amount })),
      best.allocations.map((a) => ({ key: a.product.key, termMonths: a.termMonths, amount: a.amount })),
    );

    const kept = new Map(free.filter((h) => h.termMonths === null).map((h) => [h.product.key, h]));
    const fresh: HeldAccount[] = best.allocations.map((a) => {
      const was = a.termMonths === null ? kept.get(a.product.key) : undefined;
      return {
        id: was?.id ?? `switch-${m}-${nextId++}`,
        product: a.product,
        amount: a.amount,
        deposit: a.monthlyDeposit,
        termMonths: a.termMonths,
        elapsedMonths: was ? was.elapsedMonths : 0,
      };
    });
    holdings = [...locked, ...fresh];
    for (const h of fresh) if (!free.some((f) => f.id === h.id)) queue.push(...eventsFor(h, m, input.horizonMonths));
    steps.push({ month: m, date: startDate, reasons, moves, gain, holdings: holdings.map((h) => ({ ...h })) });
  }
  return steps;
}

/** elapsedMonths for an account held so long that no intro rate is left. */
export { LONG_HELD };
