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

/** An account the household already holds. */
export interface HeldInput {
  id: string;
  /** CatalogueProduct.key, or custom:<id> for an account not in the bank data. */
  key: string;
  /** For a custom account: its name and flat rate. */
  custom: { name: string; rate: number } | null;
  amount: number;
  deposit: number;
  /** Term deposits: term length. Null for savings. */
  termMonths: number | null;
  /** Month opened, YYYY-MM; null = more than a year ago (no intro rate left). */
  opened: string | null;
  /** Term deposits: the rate locked in for this term. */
  tdRate: number | null;
  /** Term deposits: maturity month, YYYY-MM. */
  maturity: string | null;
  slot: number;
}

export interface CashEventInput {
  id: string;
  /** YYYY-MM */
  month: string;
  /** Positive money in, negative money out. */
  amount: number;
  label: string;
}

export type Tab = 'compare' | 'plan' | 'held' | 'projection';

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

  held: HeldInput[];
  cashEvents: CashEventInput[];
  goal: { amount: number; month: string } | null;
  /** Ticked checklist items by month (YYYY-MM): "<account id>|<task id>". */
  checks: Record<string, string[]>;
  projectionBasis: 'plan' | 'held';
  /** Day of the month for calendar reminders. */
  reminderDay: number;

  set: (patch: Partial<AppState>) => void;
  setPerson: (id: PersonInput['id'], patch: Partial<PersonInput>) => void;
  /** Change the total; unlocked plan accounts absorb the difference in proportion. */
  setBalance: (balance: number) => void;
  addAccount: (a: Omit<PlanAccount, 'id' | 'slot' | 'locked'>) => void;
  updateAccount: (id: string, patch: Partial<PlanAccount>) => void;
  removeAccount: (id: string) => void;
  replaceAccounts: (accounts: Array<Omit<PlanAccount, 'id' | 'slot' | 'locked'>>) => void;
  addHeld: (a: Omit<HeldInput, 'id' | 'slot'>) => void;
  updateHeld: (id: string, patch: Partial<HeldInput>) => void;
  removeHeld: (id: string) => void;
  toggleCheck: (month: string, item: string) => void;
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
  held: [] as HeldInput[],
  cashEvents: [] as CashEventInput[],
  goal: null as AppState['goal'],
  checks: {} as Record<string, string[]>,
  projectionBasis: 'plan' as const,
  reminderDay: 20,
};

const newId = () => Math.random().toString(36).slice(2, 10);

function freeSlot(accounts: Array<{ slot: number }>): number {
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
      addHeld: (a) => {
        const held = get().held;
        set({ held: [...held, { ...a, id: newId(), slot: freeSlot(held) }] });
      },
      updateHeld: (id, patch) => set({ held: get().held.map((a) => (a.id === id ? { ...a, ...patch } : a)) }),
      removeHeld: (id) => set({ held: get().held.filter((a) => a.id !== id) }),
      toggleCheck: (month, item) => {
        const checks = { ...get().checks };
        const list = new Set(checks[month] ?? []);
        if (list.has(item)) list.delete(item);
        else list.add(item);
        checks[month] = [...list];
        // Keep only the last few months of ticks.
        for (const k of Object.keys(checks).sort().slice(0, -6)) delete checks[k];
        set({ checks });
      },
      reset: () => set({ ...defaults }),
    }),
    {
      name: 'asc:state',
      version: 2,
      storage: createJSONStorage(() => localStorage),
      // v1 -> v2 only added fields, which take their defaults.
      migrate: (persisted) => persisted as AppState,
      partialize: ({
        set: _s,
        setPerson: _p,
        setBalance: _b,
        addAccount: _a,
        updateAccount: _u,
        removeAccount: _r,
        replaceAccounts: _ra,
        addHeld: _ah,
        updateHeld: _uh,
        removeHeld: _rh,
        toggleCheck: _tc,
        reset: _x,
        ...rest
      }) => rest,
    },
  ),
);
