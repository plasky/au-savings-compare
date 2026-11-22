/** CLI preview of the app's comparison: rank real products for a household with the engine. */
import { ownersFor, rankSavings as rankSavingsEngine, rankTermDeposits as rankTdEngine, type Product, type Ranked, type Scenario } from '@asc/engine';
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

export function scenarioFor(opts: RankOptions): Scenario {
  const people = opts.ages.map((age, i) => ({ id: `p${i + 1}`, age, taxableIncome: opts.incomes[i] ?? opts.incomes[0] ?? 0 }));
  return {
    people,
    owners: ownersFor(people, opts.joint),
    startDate: opts.startDate,
    behaviour: { monthlyDeposit: opts.monthlyDeposit, cardPurchasesPerMonth: opts.purchases, monthlyWithdrawal: opts.withdrawal },
    newCustomer: true,
    includeRestricted: opts.includeRestricted,
  };
}

export const rankSavings = (products: Product[], opts: RankOptions): Ranked[] =>
  rankSavingsEngine(products, opts.balance, scenarioFor(opts), { months: opts.months });

export const rankTermDeposits = (products: Product[], opts: RankOptions, termMonths: number): Ranked[] =>
  rankTdEngine(products, opts.balance, termMonths, scenarioFor(opts));

export function renderRank(rows: Ranked[], title: string, top: number): string {
  const money = (v: number) => `$${Math.round(v).toLocaleString('en-AU')}`;
  const lines = [
    `## ${title}`,
    '',
    '| # | Bank — product | Eff. rate | Interest | After tax | Bonus months | Review | Notes |',
    '|---|---|---|---|---|---|---|---|',
  ];
  rows.slice(0, top).forEach((r, i) => {
    const p = r.product;
    const note = [...r.warnings.filter((w) => !w.includes('assumed 3 months')), ...p.notes].join('; ');
    lines.push(
      `| ${i + 1} | ${p.brand} — ${p.name} | ${pct(r.rate)} | ${money(r.interest)} | ${money(r.afterTax)} | ${r.bonusMonths}/${r.months} | ${p.reviewed ? (p.confidence ?? 'yes') : 'no'} | ${note.replace(/\|/g, '/').slice(0, 140)} |`,
    );
  });
  return lines.join('\n');
}
