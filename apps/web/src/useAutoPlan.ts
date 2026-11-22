import { FCS_LIMIT, type CatalogueProduct, type ConstraintValue, type HeldAccount, type Scenario } from '@asc/engine';
import { useEffect, useRef, useState } from 'react';
import type { PlanSettings, WorkerRequest, WorkerResponse } from './engine.worker';

export interface AutoPlanInput {
  scenario: Scenario;
  balance: number;
  lockable: number;
  lockMonths: number;
  maxAccounts: number;
  fcsCap: boolean;
  accountCost: number;
}

type PlanResponse = Extract<WorkerResponse, { kind: 'plan' }>;
type HeldResponse = Extract<WorkerResponse, { kind: 'held' }>;

export type AutoPlanState =
  | { status: 'idle' }
  | { status: 'working'; last: PlanResponse | null; whatIf: ConstraintValue[] | null }
  | { status: 'done'; result: PlanResponse; whatIf: ConstraintValue[] | null };

export function settingsOf(input: AutoPlanInput): PlanSettings {
  return {
    scenario: input.scenario,
    balance: input.balance,
    lockable: Math.min(input.lockable, input.balance),
    lockMonths: input.lockMonths,
    maxAccounts: input.maxAccounts,
    fcsLimit: input.fcsCap ? FCS_LIMIT : null,
    accountCost: input.accountCost,
  };
}

/** One engine worker per hook; products are sent once and reused. */
function useEngineWorker(onMessage: (r: WorkerResponse) => void) {
  const worker = useRef<Worker | null>(null);
  const sent = useRef<CatalogueProduct[] | null>(null);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
      sent.current = null;
    },
    [],
  );
  return (msg: WorkerRequest, products: CatalogueProduct[]) => {
    worker.current ??= new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
    worker.current.onmessage = (e: MessageEvent<WorkerResponse>) => handler.current(e.data);
    if (sent.current !== products) {
      msg.products = products;
      sent.current = products;
    }
    worker.current.postMessage(msg);
  };
}

/** The automatic plan, then what each limit costs. Debounced while inputs change. */
export function useAutoPlan(enabled: boolean, products: CatalogueProduct[], input: AutoPlanInput): AutoPlanState {
  const [state, setState] = useState<AutoPlanState>({ status: 'idle' });
  const seq = useRef(0);
  const last = useRef<PlanResponse | null>(null);
  const whatIf = useRef<ConstraintValue[] | null>(null);
  const key = JSON.stringify(input);
  const post = useEngineWorker((r) => {
    if (r.id !== seq.current) return;
    if (r.kind === 'plan') {
      last.current = r;
      whatIf.current = null;
      setState({ status: 'done', result: r, whatIf: null });
    } else if (r.kind === 'whatif' && last.current) {
      whatIf.current = r.values;
      setState({ status: 'done', result: last.current, whatIf: r.values });
    }
  });

  useEffect(() => {
    if (!enabled || !products.length) return;
    setState({ status: 'working', last: last.current, whatIf: whatIf.current });
    const timer = setTimeout(() => {
      const id = ++seq.current;
      post({ id, kind: 'plan', settings: settingsOf(JSON.parse(key) as AutoPlanInput), whatIf: true }, products);
    }, 250);
    return () => clearTimeout(timer);
  }, [enabled, products, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return enabled ? state : { status: 'idle' };
}

export type HeldAdviceState = { status: 'idle' } | { status: 'working'; last: HeldResponse | null } | { status: 'done'; result: HeldResponse };

/** Switching gain for the accounts held now, and the timeline of moves ahead. */
export function useHeldAdvice(products: CatalogueProduct[], extra: CatalogueProduct[], holdings: HeldAccount[], input: AutoPlanInput, horizonMonths = 24): HeldAdviceState {
  const [state, setState] = useState<HeldAdviceState>({ status: 'idle' });
  const seq = useRef(0);
  const last = useRef<HeldResponse | null>(null);
  const key = JSON.stringify({ input, horizonMonths, h: holdings.map((h) => [h.id, h.product.key, h.amount, h.deposit, h.termMonths, h.elapsedMonths, h.fixedRate]), extra: extra.map((p) => [p.key, p.rows[0]?.rate]) });
  const post = useEngineWorker((r) => {
    if (r.id !== seq.current || r.kind !== 'held') return;
    last.current = r;
    setState({ status: 'done', result: r });
  });

  useEffect(() => {
    if (!products.length || !holdings.length) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'working', last: last.current });
    const timer = setTimeout(() => {
      const id = ++seq.current;
      post({ id, kind: 'held', settings: settingsOf(input), extra, holdings, horizonMonths }, products);
    }, 300);
    return () => clearTimeout(timer);
  }, [products, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
