import { FCS_LIMIT, type CatalogueProduct, type Scenario } from '@asc/engine';
import { useEffect, useRef, useState } from 'react';
import type { WorkerRequest, WorkerResponse } from './optimise.worker';

export interface AutoPlanInput {
  scenario: Scenario;
  balance: number;
  lockable: number;
  lockMonths: number;
  maxAccounts: number;
  fcsCap: boolean;
}

export type AutoPlanState = { status: 'idle' } | { status: 'working'; last: WorkerResponse | null } | { status: 'done'; result: WorkerResponse };

/** Runs the optimiser in a worker (it can take a few hundred milliseconds), debounced while inputs change. */
export function useAutoPlan(enabled: boolean, products: CatalogueProduct[], input: AutoPlanInput): AutoPlanState {
  const [state, setState] = useState<AutoPlanState>({ status: 'idle' });
  const worker = useRef<Worker | null>(null);
  const sentProducts = useRef<CatalogueProduct[] | null>(null);
  const seq = useRef(0);
  const last = useRef<WorkerResponse | null>(null);
  const key = JSON.stringify(input);

  useEffect(() => {
    if (!enabled || !products.length) return;
    worker.current ??= new Worker(new URL('./optimise.worker.ts', import.meta.url), { type: 'module' });
    const w = worker.current;
    w.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.id !== seq.current) return;
      last.current = e.data;
      setState({ status: 'done', result: e.data });
    };
    setState({ status: 'working', last: last.current });
    const timer = setTimeout(() => {
      const id = ++seq.current;
      const parsed = JSON.parse(key) as AutoPlanInput;
      const msg: WorkerRequest = {
        id,
        input: {
          scenario: parsed.scenario,
          balance: parsed.balance,
          lockable: Math.min(parsed.lockable, parsed.balance),
          lockMonths: parsed.lockMonths,
          maxAccounts: parsed.maxAccounts,
          fcsLimit: parsed.fcsCap ? FCS_LIMIT : null,
        },
      };
      if (sentProducts.current !== products) {
        msg.products = products;
        sentProducts.current = products;
      }
      w.postMessage(msg);
    }, 250);
    return () => clearTimeout(timer);
  }, [enabled, products, key]);

  useEffect(
    () => () => {
      worker.current?.terminate();
      worker.current = null;
      sentProducts.current = null;
    },
    [],
  );
  return enabled ? state : { status: 'idle' };
}
