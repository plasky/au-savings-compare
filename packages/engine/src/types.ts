/**
 * Engine model. Products here are already normalised (rates as fractions,
 * reviews applied, excluded rows removed); the pipeline's normaliser builds
 * them from CDR product data + curation/reviews.json.
 */

export type Role = 'BASE' | 'BONUS' | 'INTRO';
export type Combine = 'ADD_TO_BASE' | 'TOTAL_RATE';

export type ConditionType =
  | 'MIN_DEPOSIT_AMOUNT'
  | 'MIN_DEPOSITS'
  | 'MIN_PURCHASES'
  | 'DEPOSIT_BALANCE_INCREASED'
  | 'MAX_WITHDRAWALS'
  | 'MAX_WITHDRAWAL_AMOUNT'
  | 'MIN_BALANCE'
  | 'BALANCE_CAP'
  | 'NEW_CUSTOMER'
  | 'EXISTING_CUSTOMER'
  | 'AGE_RANGE'
  | 'LINKED_ACCOUNT'
  | 'ONLINE_ONLY'
  | 'SOLE_HOLDER_ONLY'
  | 'OTHER';

export interface Condition {
  type: ConditionType;
  amount: number | null;
  count: number | null;
  minAge: number | null;
  maxAge: number | null;
  period: 'MONTH' | 'QUARTER' | 'YEAR' | 'ONCE' | 'NONE';
  externalOnly: boolean | null;
  description: string;
}

/** A DOLLAR balance band; min inclusive, max inclusive (null = unbounded). */
export interface Tier {
  min: number;
  max: number | null;
}

export interface RateRow {
  /** Stable id within the product (e.g. the CDR row signature). */
  id: string;
  role: Role;
  combine: Combine;
  /** Annual rate as a fraction (0.055 = 5.50%). */
  rate: number;
  /** Variable rates move with rate scenarios; FIXED rows don't. */
  variable: boolean;
  /** Balance bands; empty = applies to any balance. */
  tiers: Tier[];
  method: 'PER_TIER' | 'WHOLE_BALANCE';
  conditions: Condition[];
  /** Rows sharing a set are mutually exclusive choices; `option` labels each choice. */
  alternativeSet: string | null;
  option: string | null;
  introMonths: number | null;
  /** Term-deposit term range in months. */
  term: { min: number; max: number | null } | null;
  /** How interest is paid (term deposits). */
  payment: { type: 'MATURITY' | 'PERIODIC' | 'UPFRONT'; everyMonths: number | null } | null;
  /** Above its top band the rate still applies to the amount up to that band (see markCappedBands). */
  capped?: boolean;
}

export interface Product {
  key: string;
  brand: string;
  name: string;
  kind: 'savings' | 'term_deposit';
  rows: RateRow[];
  eligibility: {
    minAge: number | null;
    maxAge: number | null;
    jointAllowed: boolean | null;
    restrictedTo: string | null;
    newCustomersOnly: boolean | null;
  };
  reviewed: boolean;
  confidence: 'high' | 'medium' | 'low' | null;
  notes: string[];
  /** Legal entity grouping for the Financial Claims Scheme (ABN), if known. */
  abn: string | null;
}

export interface Person {
  id: string;
  name?: string;
  /** Age at the start of the simulation. */
  age: number;
  /** Taxable income excluding the interest being modelled (per year). */
  taxableIncome: number;
  /** Annual growth applied to taxableIncome (default 0). */
  incomeGrowth?: number;
}

/** What the household does with an account each month. */
export interface Behaviour {
  monthlyDeposit: number;
  depositsPerMonth: number;
  depositDay: number;
  /** Deposits come from outside the bank (salary, another bank). */
  externalDeposits: boolean;
  monthlyWithdrawal: number;
  withdrawalsPerMonth: number;
  withdrawalDay: number;
  cardPurchasesPerMonth: number;
  /** Willing to hold any linked transaction account a bonus needs. */
  linkedAccounts: boolean;
  /** Willing to open/manage online. */
  onlineOk: boolean;
  /** Treat conditions of type OTHER (unstructured) as met. */
  otherConditionsMet: boolean;
}

export const DEFAULT_BEHAVIOUR: Behaviour = {
  monthlyDeposit: 0,
  depositsPerMonth: 1,
  depositDay: 1,
  externalDeposits: true,
  monthlyWithdrawal: 0,
  withdrawalsPerMonth: 1,
  withdrawalDay: 15,
  cardPurchasesPerMonth: 0,
  linkedAccounts: true,
  onlineOk: true,
  otherConditionsMet: true,
};

export interface SavingsPlan {
  kind: 'savings';
  id: string;
  product: Product;
  /** Ownership shares by person id; sums to 1. Two owners = joint account. */
  owners: Record<string, number>;
  openingBalance: number;
  behaviour?: Partial<Behaviour>;
  /** Chosen option per alternative set (e.g. { plan: "Standard plan (free)" }); unset = best by interest. */
  choices?: Record<string, string>;
  /** New to this bank (intro rates, NEW_CUSTOMER conditions). Default true. */
  newCustomer?: boolean;
  /** Months since the account was opened, so an intro rate that started earlier ends on time. Default 0. */
  introElapsedMonths?: number;
  /** One-off deposits (positive) or withdrawals (negative) by month index. */
  events?: CashEvent[];
}

export interface CashEvent {
  /** Month index from the simulation start. */
  month: number;
  amount: number;
}

export interface TermDepositPlan {
  kind: 'term_deposit';
  id: string;
  product: Product;
  owners: Record<string, number>;
  principal: number;
  termMonths: number;
  /** MATURITY, or interest paid every N months (paid out, not compounded). */
  payment: 'MATURITY' | { everyMonths: number };
  /** Roll principal (and maturity interest) into a new term at maturity. Default true. */
  rollover?: boolean;
  newCustomer?: boolean;
  /** Assume online/existing-customer style conditions on bonus rows are met. Default true. */
  conditionsMet?: boolean;
  /** Rate locked in for the current term (a deposit already held); later terms use today's rate. */
  fixedRate?: number;
  /** Months of the current term already elapsed at the start. Default 0. */
  elapsedMonths?: number;
}

export type AccountPlan = SavingsPlan | TermDepositPlan;

export interface TaxRules {
  /** Australian financial year, e.g. "2026-27" (1 July 2026 – 30 June 2027). */
  fy: string;
  /** Marginal rates from each threshold upward (first must be 0). */
  brackets: Array<{ from: number; rate: number }>;
  lito: { max: number; fullTo: number; firstTaperTo: number; firstTaper: number; secondTaper: number };
  medicare: { rate: number; lowerThreshold: number; phaseInRate: number };
  sources: string[];
  notes?: string;
}

export interface SimulationInput {
  /** First day of the first month, YYYY-MM-01. */
  startDate: string;
  months: number;
  people: Person[];
  accounts: AccountPlan[];
  taxRules?: TaxRules[];
  /** Expected annual CPI for real-terms results (default 0.025). */
  cpi?: number;
  /** Shift (fraction) added to variable rates in a given month, e.g. a cash-rate path. */
  rateShift?: (monthIndex: number) => number;
}

export interface AccountMonth {
  balance: number;
  interest: number;
  base: number;
  bonus: number;
  intro: number;
  /** All bonus rows' monthly conditions were met (true if the product has no bonus rows). */
  bonusMet: boolean;
  /** Descriptions of unmet bonus/intro conditions this month. */
  unmet: string[];
  /** Interest paid out rather than compounded (TD periodic interest). */
  paidOut: number;
  /** Average end-of-day balance over the month (before the interest credit). */
  avgBalance: number;
}

export interface MonthResult {
  index: number;
  /** YYYY-MM-01 */
  date: string;
  days: number;
  accounts: Record<string, AccountMonth>;
  totalBalance: number;
  totalInterest: number;
}

export interface YearResult {
  fy: string;
  interestByAccount: Record<string, number>;
  perPerson: Record<string, { interest: number; tax: number }>;
  interest: number;
  tax: number;
  afterTax: number;
}

export interface SimulationResult {
  months: MonthResult[];
  years: YearResult[];
  summary: {
    interest: number;
    tax: number;
    afterTax: number;
    endBalance: number;
    endBalanceReal: number;
    firstYearInterest: number;
    firstYearAfterTax: number;
    /** First-12-month interest ÷ average daily balance, annualised. */
    firstYearRate: number;
    perAccountFirstYear: Record<string, { interest: number; rate: number }>;
  };
  warnings: string[];
}
