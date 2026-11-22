import { CATALOGUE_VERSION, type Catalogue, type CatalogueProduct } from '@asc/engine';
import { useEffect, useState } from 'react';
import { shortName } from './format';

export type CatalogueState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalogue: Catalogue };

let cached: Promise<Catalogue> | null = null;

function load(): Promise<Catalogue> {
  cached ??= fetch(`${import.meta.env.BASE_URL}data/products.json`, { cache: 'no-cache' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`products.json returned HTTP ${res.status}`);
      const c = (await res.json()) as Catalogue;
      if (c.version !== CATALOGUE_VERSION) throw new Error(`products.json is ${String(c.version)}; this app reads ${CATALOGUE_VERSION}`);
      for (const p of c.products) p.name = shortName(p.brand, p.name);
      return c;
    })
    .catch((e: unknown) => {
      cached = null;
      throw e;
    });
  return cached;
}

export function useCatalogue(): CatalogueState {
  const [state, setState] = useState<CatalogueState>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    load().then(
      (catalogue) => live && setState({ status: 'ready', catalogue }),
      (e: unknown) => live && setState({ status: 'error', message: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}

export const CASH_ETF_KEY = 'etf:cash';
export const CASH_ETF_GROUP = 'etf:cash';

/** An indicative cash ETF: one variable rate tracking the cash rate. Not a deposit, so not covered by the guarantee. */
export function cashEtf(yieldRate: number): CatalogueProduct {
  return {
    key: CASH_ETF_KEY,
    brand: 'Cash ETF',
    name: 'Indicative cash ETF yield',
    kind: 'savings',
    rows: [
      {
        id: 'etf-yield',
        role: 'BASE',
        combine: 'ADD_TO_BASE',
        rate: yieldRate,
        variable: true,
        tiers: [],
        method: 'WHOLE_BALANCE',
        conditions: [],
        alternativeSet: null,
        option: null,
        introMonths: null,
        term: null,
        payment: null,
      },
    ],
    eligibility: { minAge: null, maxAge: null, jointAllowed: true, restrictedTo: null, newCustomersOnly: null },
    reviewed: false,
    confidence: null,
    notes: [
      'An exchange-traded fund that holds cash deposits, bought through a broker. Not a bank deposit, so the $250k government guarantee does not apply.',
      'Yield is an estimate (cash rate less fees) you can change in Household settings. Brokerage applies when you buy and sell; distributions are usually monthly.',
    ],
    abn: null,
    group: CASH_ETF_GROUP,
    url: null,
    lastUpdated: null,
    description: 'Indicative only: tracks the RBA cash rate less fund fees.',
  };
}
