/// <reference lib="webworker" />
/**
 * Heavier engine work off the main thread: the automatic plan (and what each
 * limit costs), and advice for accounts already held (switching gain now, and
 * a timeline of moves as intro rates end and deposits mature).
 */
import {
  constraintValues,
  describeMoves,
  optimiseWithCost,
  simulate,
  switchingPlan,
  type CatalogueProduct,
  type ConstraintValue,
  type HeldAccount,
  type OptimiseInput,
  type Product,
  type Scenario,
  type SwitchMove,
} from '@asc/engine';

export interface PlanSettings {
  scenario: Scenario;
  balance: number;
  lockable: number;
  lockMonths: number;
  maxAccounts: number;
  fcsLimit: number | null;
  accountCost: number;
}

export interface Allocation {
  key: string;
  amount: number;
  monthlyDeposit: number;
  termMonths: number | null;
  interest: number;
}

export type WorkerRequest =
  | { id: number; kind: 'plan'; products?: CatalogueProduct[]; settings: PlanSettings; whatIf: boolean }
  | { id: number; kind: 'held'; products?: CatalogueProduct[]; settings: PlanSettings; extra: CatalogueProduct[]; holdings: HeldAccount[]; horizonMonths: number };

export interface StepOut {
  month: number;
  date: string;
  reasons: string[];
  moves: SwitchMove[];
  gain: number;
}

export type WorkerResponse =
  | { id: number; kind: 'plan'; allocations: Allocation[]; interest: number; singleBest: number; ms: number; error?: string }
  | { id: number; kind: 'whatif'; values: ConstraintValue[] }
  | {
      id: number;
      kind: 'held';
      stay: number;
      best: Allocation[];
      bestInterest: number;
      moves: SwitchMove[];
      steps: StepOut[];
      /** Whether the timeline assumes the moves suggested now were made. */
      timelineFrom: 'switched' | 'current';
      ms: number;
      error?: string;
    };

let products: CatalogueProduct[] = [];
const groupOf = (p: Product) => (p as CatalogueProduct).group ?? p.key;

function base(settings: PlanSettings, list: Product[]): Omit<OptimiseInput, 'balance'> {
  return {
    scenario: settings.scenario,
    lockable: settings.lockable,
    lockMonths: settings.lockMonths,
    maxAccounts: settings.maxAccounts,
    fcsLimit: settings.fcsLimit,
    products: list,
    groupOf,
  };
}

const allocOut = (r: ReturnType<typeof optimiseWithCost>): Allocation[] =>
  r.allocations.map((a) => ({ key: a.product.key, amount: Math.round(a.amount), monthlyDeposit: Math.round(a.monthlyDeposit), termMonths: a.termMonths, interest: a.interest }));

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.products) products = req.products;
  const t = performance.now();
  if (req.kind === 'plan') {
    try {
      const input: OptimiseInput = { ...base(req.settings, products), balance: req.settings.balance };
      const r = optimiseWithCost(input, req.settings.accountCost);
      self.postMessage({ id: req.id, kind: 'plan', allocations: allocOut(r), interest: r.interest, singleBest: r.singleBest, ms: performance.now() - t } satisfies WorkerResponse);
      if (req.whatIf) self.postMessage({ id: req.id, kind: 'whatif', values: constraintValues(input, req.settings.accountCost, r) } satisfies WorkerResponse);
    } catch (err) {
      self.postMessage({ id: req.id, kind: 'plan', allocations: [], interest: 0, singleBest: 0, ms: 0, error: String(err) } satisfies WorkerResponse);
    }
    return;
  }
  try {
    const list = [...products, ...req.extra];
    const s = req.settings.scenario;
    const liquid = req.holdings.filter((h) => h.termMonths === null);
    const locked = req.holdings.filter((h) => h.termMonths !== null);
    const liquidTotal = liquid.reduce((sum, h) => sum + h.amount, 0);
    const lockedTotal = locked.reduce((sum, h) => sum + h.amount, 0);
    let stay = 0;
    let best: ReturnType<typeof optimiseWithCost> | null = null;
    if (liquidTotal > 0) {
      stay = simulate({
        startDate: s.startDate,
        months: 12,
        people: s.people,
        accounts: liquid.map((h) => ({
          kind: 'savings' as const,
          id: h.id,
          product: h.product,
          owners: s.owners,
          openingBalance: h.amount,
          newCustomer: true,
          introElapsedMonths: h.elapsedMonths,
          behaviour: { ...s.behaviour, monthlyDeposit: h.deposit, monthlyWithdrawal: 0 },
        })),
      }).summary.firstYearInterest;
      best = optimiseWithCost(
        {
          ...base(req.settings, list),
          balance: liquidTotal,
          existing: Object.fromEntries(liquid.map((h) => [h.product.key, h.elapsedMonths])),
          lockable: Math.max(0, req.settings.lockable - lockedTotal),
          maxAccounts: Math.max(1, req.settings.maxAccounts - locked.length),
        },
        req.settings.accountCost,
      );
    }
    // If moving now is worth it, the timeline starts from the rearranged accounts; otherwise from today's.
    const switchNow = !!best && best.interest - stay >= Math.max(50, req.settings.accountCost);
    const timelineHoldings: HeldAccount[] = switchNow
      ? [
          ...locked,
          ...best!.allocations.map((a, i) => {
            const was = a.termMonths === null ? liquid.find((h) => h.product.key === a.product.key) : undefined;
            return {
              id: was?.id ?? `now-${i}`,
              product: a.product,
              amount: a.amount,
              deposit: a.monthlyDeposit,
              termMonths: a.termMonths,
              elapsedMonths: was?.elapsedMonths ?? 0,
            };
          }),
        ]
      : req.holdings;
    const steps = switchingPlan({ base: base(req.settings, list), holdings: timelineHoldings, horizonMonths: req.horizonMonths, accountCost: req.settings.accountCost });
    self.postMessage({
      id: req.id,
      kind: 'held',
      stay,
      best: best ? allocOut(best) : [],
      bestInterest: best?.interest ?? 0,
      moves: best
        ? describeMoves(
            liquid.map((h) => ({ key: h.product.key, termMonths: null, amount: h.amount })),
            best.allocations.map((a) => ({ key: a.product.key, termMonths: a.termMonths, amount: a.amount })),
          )
        : [],
      steps: steps.map((st) => ({ month: st.month, date: st.date, reasons: st.reasons, moves: st.moves, gain: st.gain })),
      timelineFrom: switchNow ? 'switched' : 'current',
      ms: performance.now() - t,
    } satisfies WorkerResponse);
  } catch (err) {
    self.postMessage({ id: req.id, kind: 'held', stay: 0, best: [], bestInterest: 0, moves: [], steps: [], timelineFrom: 'current', ms: 0, error: String(err) } satisfies WorkerResponse);
  }
};
