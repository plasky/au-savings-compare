/**
 * App state, kept in this browser's localStorage only. Nothing here leaves the
 * device: the site is static and makes no requests besides loading products.json.
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export interface PersonInput {
  id: 'p1' | 'p2';
  name: string;
  age: number;
  /** Taxable income per year, not counting the interest being modelled. */
  income: number;
}

export interface PlanAccount {
  id: string;
  /** CatalogueProduct.key */
  key: string;
  amount: number;
  /** Share of the monthly deposit sent here. */
  deposit: number;
  /** Term for a term deposit. */
  termMonths: number | null;
  /** Locked accounts keep their amount when the total changes. */
  locked: boolean;
  /** Colour slot (0–7), fixed for the life of the account so colours never shuffle. */
  slot: number;
}

export type Tab = 'compare' | 'plan' | 'projection';

export interface AppState {
  people: [PersonInput, PersonInput];
  partner: boolean;

  balance: number;
  monthlyDeposit: number;
  purchases: number;
  withdrawal: number;
  lockable: number;
  lockMonths: number;

  newCustomer: boolean;
  includeRestricted: boolean;
  otherConditionsMet: boolean;
  linkedAccounts: boolean;

  taxView: 'after' | 'pre';
  realTerms: boolean;
  cpi: number;
  horizonYears: number;
  rateShift: number;
  rateShiftFromMonth: number;
  cashEtf: { enabled: boolean; yield: number };

  tab: Tab;
  compareKind: 'savings' | 'term_deposit';
  tdTerm: number;
  search: string;
  reviewedOnly: boolean;
  showIneligible: boolean;

  planMode: 'manual' | 'auto';
  maxAccounts: number;
  /** An extra account must add at least this much interest a year (automatic plans). */
  accountCost: number;
  fcsCap: boolean;
  accounts: PlanAccount[];
  withdrawFrom: string | null;

  set: (patch: Partial<AppState>) => void;
  setPerson: (id: PersonInput['id'], patch: Partial<PersonInput>) => void;
  /** Change the total; unlocked plan accounts absorb the difference in proportion. */
  setBalance: (balance: number) => void;
  addAccount: (a: Omit<PlanAccount, 'id' | 'slot' | 'locked'>) => void;
  updateAccount: (id: string, patch: Partial<PlanAccount>) => void;
  removeAccount: (id: string) => void;
  replaceAccounts: (accounts: Array<Omit<PlanAccount, 'id' | 'slot' | 'locked'>>) => void;
  reset: () => void;
}

/** RBA cash rate target 4.85% (3 Nov 2026) less ~0.20% fund fees. Editable in Household settings. */
export const DEFAULT_CASH_ETF_YIELD = 0.0465;

const defaults = {
  people: [
    { id: 'p1', name: '', age: 40, income: 100_000 },
    { id: 'p2', name: '', age: 40, income: 100_000 },
  ] as [PersonInput, PersonInput],
  partner: true,
  balance: 150_000,
  monthlyDeposit: 2000,
  purchases: 5,
  withdrawal: 0,
  lockable: 0,
  lockMonths: 12,
  newCustomer: true,
  includeRestricted: false,
  otherConditionsMet: true,
  linkedAccounts: true,
  taxView: 'after' as const,
  realTerms: false,
  cpi: 0.03,
  horizonYears: 5,
  rateShift: 0,
  rateShiftFromMonth: 6,
  cashEtf: { enabled: true, yield: DEFAULT_CASH_ETF_YIELD },
  tab: 'compare' as Tab,
  compareKind: 'savings' as const,
  tdTerm: 12,
  search: '',
  reviewedOnly: false,
  showIneligible: false,
  planMode: 'manual' as const,
  maxAccounts: 3,
  accountCost: 250,
  fcsCap: true,
  accounts: [] as PlanAccount[],
  withdrawFrom: null as string | null,
};

const newId = () => Math.random().toString(36).slice(2, 10);

function freeSlot(accounts: PlanAccount[]): number {
  const used = new Set(accounts.map((a) => a.slot));
  for (let i = 0; i < 8; i++) if (!used.has(i)) return i;
  return accounts.length % 8;
}

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      ...defaults,
      set: (patch) => set(patch),
      setPerson: (id, patch) => set({ people: get().people.map((p) => (p.id === id ? { ...p, ...patch } : p)) as AppState['people'] }),
      setBalance: (balance) => {
        const { accounts, balance: old } = get();
        const unlocked = accounts.filter((a) => !a.locked);
        const unlockedTotal = unlocked.reduce((s, a) => s + a.amount, 0);
        const allocated = accounts.reduce((s, a) => s + a.amount, 0);
        // Only rescale a plan that was fully allocated; a partly allocated plan keeps its amounts.
        if (!unlocked.length || unlockedTotal <= 0 || Math.abs(allocated - old) > 1) {
          set({ balance });
          return;
        }
        const target = Math.max(0, unlockedTotal + (balance - old));
        const scale = target / unlockedTotal;
        set({
          balance,
          accounts: accounts.map((a) => (a.locked ? a : { ...a, amount: Math.round(a.amount * scale) })),
        });
      },
      addAccount: (a) => {
        const accounts = get().accounts;
        set({ accounts: [...accounts, { ...a, id: newId(), slot: freeSlot(accounts), locked: false }], planMode: 'manual' });
      },
      updateAccount: (id, patch) => set({ accounts: get().accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }),
      removeAccount: (id) => {
        const { accounts, withdrawFrom } = get();
        set({ accounts: accounts.filter((a) => a.id !== id), withdrawFrom: withdrawFrom === id ? null : withdrawFrom });
      },
      replaceAccounts: (list) => {
        const accounts: PlanAccount[] = [];
        for (const a of list) accounts.push({ ...a, id: newId(), slot: freeSlot(accounts), locked: false });
        set({ accounts, withdrawFrom: null });
      },
      reset: () => set({ ...defaults }),
    }),
    {
      name: 'asc:state',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ set: _s, setPerson: _p, setBalance: _b, addAccount: _a, updateAccount: _u, removeAccount: _r, replaceAccounts: _ra, reset: _x, ...rest }) => rest,
    },
  ),
);
