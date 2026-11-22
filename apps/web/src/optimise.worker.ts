/// <reference lib="webworker" />
import { optimise, type CatalogueProduct, type Product, type Scenario } from '@asc/engine';

export interface WorkerRequest {
  id: number;
  products?: CatalogueProduct[];
  input: {
    scenario: Scenario;
    balance: number;
    lockable: number;
    lockMonths: number;
    maxAccounts: number;
    fcsLimit: number | null;
  };
}

export interface WorkerResponse {
  id: number;
  allocations: Array<{ key: string; amount: number; monthlyDeposit: number; termMonths: number | null; interest: number }>;
  interest: number;
  singleBest: number;
  ms: number;
  error?: string;
}

let products: CatalogueProduct[] = [];

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, input } = e.data;
  if (e.data.products) products = e.data.products;
  const t = performance.now();
  try {
    const r = optimise({ ...input, products, groupOf: (p: Product) => (p as CatalogueProduct).group ?? p.key });
    const res: WorkerResponse = {
      id,
      allocations: r.allocations.map((a) => ({ key: a.product.key, amount: Math.round(a.amount), monthlyDeposit: Math.round(a.monthlyDeposit), termMonths: a.termMonths, interest: a.interest })),
      interest: r.interest,
      singleBest: r.singleBest,
      ms: performance.now() - t,
    };
    self.postMessage(res);
  } catch (err) {
    self.postMessage({ id, allocations: [], interest: 0, singleBest: 0, ms: 0, error: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
