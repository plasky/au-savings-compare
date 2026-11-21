/** Rank real products for a household scenario using the engine (a preview of the app's comparison). */
import { simulate, tdRate, type Person, type Product } from '@asc/engine';
import { pct } from './util.js';

export interface RankOptions {
  balance: number;
  monthlyDeposit: number;
  purchases: number;
  withdrawal: number;
  ages: number[];
  incomes: number[];
  months: number;
  joint: boolean;
  includeRestricted: boolean;
  startDate: string;
}

export interface RankRow {
  key: string;
  brand: string;
  name: string;
  interest: number;
  afterTax: number;
  rate: number;
  bonusMonths: number;
  months: number;
  reviewed: boolean;
  confidence: string | null;
  notes: string[];
  warnings: string[];
}

function household(opts: RankOptions): { people: Person[]; owners: Record<string, number> } {
  const people = opts.ages.map((age, i) => ({ id: `p${i + 1}`, age, taxableIncome: opts.incomes[i] ?? opts.incomes[0] ?? 0 }));
  const owners = opts.joint && people.length > 1 ? Object.fromEntries(people.map((p) => [p.id, 1 / people.length])) : { p1: 1 };
  return { people, owners };
}

export function eligible(p: Product, opts: RankOptions): boolean {
  if (p.eligibility.restrictedTo && !opts.includeRestricted) return false;
  if (opts.joint && p.eligibility.jointAllowed === false) return false;
  const ages = opts.joint ? opts.ages : opts.ages.slice(0, 1);
  if (p.eligibility.minAge !== null && ages.some((a) => a < p.eligibility.minAge!)) return false;
  if (p.eligibility.maxAge !== null && ages.some((a) => a > p.eligibility.maxAge!)) return false;
  return true;
}

export function rankSavings(products: Product[], opts: RankOptions): RankRow[] {
  const { people, owners } = household(opts);
  const rows: RankRow[] = [];
  for (const p of products) {
    if (p.kind !== 'savings' || !eligible(p, opts)) continue;
    const r = simulate({
      startDate: opts.startDate,
      months: opts.months,
      people,
      accounts: [
        {
          kind: 'savings',
          id: 'a',
          product: p,
          owners,
          openingBalance: opts.balance,
          behaviour: {
            monthlyDeposit: opts.monthlyDeposit,
            cardPurchasesPerMonth: opts.purchases,
            monthlyWithdrawal: opts.withdrawal,
          },
        },
      ],
    });
    rows.push({
      key: p.key,
      brand: p.brand,
      name: p.name,
      interest: r.summary.firstYearInterest,
      afterTax: r.summary.firstYearAfterTax,
      rate: r.summary.perAccountFirstYear.a?.rate ?? 0,
      bonusMonths: r.months.filter((m) => m.accounts.a!.bonusMet).length,
      months: r.months.length,
      reviewed: p.reviewed,
      confidence: p.confidence,
      notes: p.notes,
      warnings: r.warnings,
    });
  }
  return rows.sort((a, b) => b.afterTax - a.afterTax);
}

export function rankTermDeposits(products: Product[], opts: RankOptions, termMonths: number): RankRow[] {
  const { people, owners } = household(opts);
  const rows: RankRow[] = [];
  for (const p of products) {
    if (p.kind !== 'term_deposit' || !eligible(p, opts)) continue;
    const plan = {
      kind: 'term_deposit' as const,
      id: 't',
      product: p,
      owners,
      principal: opts.balance,
      termMonths,
      payment: 'MATURITY' as const,
      rollover: false,
    };
    const warnings: string[] = [];
    const rate = tdRate(plan, opts.balance, warnings);
    if (rate <= 0) continue;
    const r = simulate({ startDate: opts.startDate, months: termMonths, people, accounts: [plan] });
    rows.push({
      key: p.key,
      brand: p.brand,
      name: p.name,
      interest: r.summary.interest,
      afterTax: r.summary.afterTax,
      rate,
      bonusMonths: termMonths,
      months: termMonths,
      reviewed: p.reviewed,
      confidence: p.confidence,
      notes: p.notes,
      warnings: [...warnings, ...r.warnings],
    });
  }
  return rows.sort((a, b) => b.afterTax - a.afterTax);
}

export function renderRank(rows: RankRow[], title: string, top: number): string {
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;
  const lines = [
    `## ${title}`,
    '',
    '| # | Bank — product | Eff. rate | Interest | After tax | Bonus months | Review | Notes |',
    '|---|---|---|---|---|---|---|---|',
  ];
  rows.slice(0, top).forEach((r, i) => {
    const note = [...r.warnings.filter((w) => !w.includes('assumed 3 months')), ...r.notes].join('; ');
    lines.push(
      `| ${i + 1} | ${r.brand} — ${r.name} | ${pct(r.rate)} | ${money(r.interest)} | ${money(r.afterTax)} | ${r.bonusMonths}/${r.months} | ${r.reviewed ? (r.confidence ?? 'yes') : 'no'} | ${note.replace(/\|/g, '/').slice(0, 140)} |`,
    );
  });
  return lines.join('\n');
}
