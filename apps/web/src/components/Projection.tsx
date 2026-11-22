import type { CatalogueProduct, SimulationResult } from '@asc/engine';
import { useState } from 'react';
import { money, pct, signedPct } from '../format';
import { useApp, type PlanAccount } from '../store';
import { Columns, DataTable, StackedArea, type Series } from './charts';
import { Segmented } from './fields';

const color = (slot: number) => `var(--s${(slot % 8) + 1})`;

export function Projection({
  accounts,
  byKey,
  result,
  fallback,
}: {
  accounts: PlanAccount[];
  byKey: Map<string, CatalogueProduct>;
  result: SimulationResult | null;
  /** Shown when the plan is empty: we project the best single account instead. */
  fallback: string | null;
}) {
  const s = useApp();
  const [tables, setTables] = useState(false);
  const after = s.taxView === 'after';

  if (!result) {
    return <p className="empty">Nothing to project yet. Add accounts to your plan, or check your settings in the band above.</p>;
  }

  const months = result.months;
  const deflate = (v: number, i: number) => (s.realTerms ? v / (1 + s.cpi) ** ((i + 1) / 12) : v);
  const balanceSeries: Series[] = accounts.map((a) => {
    const p = byKey.get(a.key);
    return {
      id: a.id,
      label: p ? `${p.brand} ${p.name}` : a.key,
      color: color(a.slot),
      values: months.map((m, i) => deflate(m.accounts[a.id]?.balance ?? 0, i)),
    };
  });
  const years = result.years;
  const fyLabel = (fy: string) => `FY${fy.slice(5)}`;
  const partial = (fy: string) => months.filter((m) => {
    const d = new Date(Date.UTC(Number(m.date.slice(0, 4)), Number(m.date.slice(5, 7)), 0));
    const y = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    return `${y}-${String((y + 1) % 100).padStart(2, '0')}` === fy;
  }).length;
  const yearCats = years.map((y) => {
    const n = partial(y.fy);
    return n < 12 ? `${fyLabel(y.fy)} (${n} mo)` : fyLabel(y.fy);
  });
  const interestSeries: Series[] = after
    ? [
        { id: 'after', label: 'Interest after tax', color: 'var(--s1)', values: years.map((y) => y.afterTax) },
        { id: 'tax', label: 'Tax on interest', color: 'var(--rule-strong)', values: years.map((y) => y.tax) },
      ]
    : [{ id: 'interest', label: 'Interest', color: 'var(--s1)', values: years.map((y) => y.interest) }];

  const sum = result.summary;
  const endBalance = s.realTerms ? sum.endBalanceReal : sum.endBalance;
  const contributed = s.balance + s.monthlyDeposit * months.length - s.withdrawal * months.length;
  const horizon = s.horizonYears;

  return (
    <section aria-label="Projection">
      <div className="scenario-row">
        <Segmented
          label="How far ahead"
          value={horizon}
          options={[1, 2, 3, 5, 10].map((y) => ({ value: y, label: `${y} yr${y === 1 ? '' : 's'}` }))}
          onChange={(v) => s.set({ horizonYears: v })}
        />
        <Segmented
          label="Dollars"
          value={s.realTerms ? 'real' : 'nominal'}
          options={[
            { value: 'nominal', label: 'Future dollars' },
            { value: 'real', label: 'Today’s dollars' },
          ]}
          onChange={(v) => s.set({ realTerms: v === 'real' })}
        />
        <span className="inline-range">
          <label htmlFor="rate-shift">Variable rates {s.rateShift === 0 ? 'stay as they are' : `move ${signedPct(s.rateShift)}`}</label>
          <input
            id="rate-shift"
            type="range"
            min={-0.02}
            max={0.02}
            step={0.0025}
            value={s.rateShift}
            onChange={(e) => s.set({ rateShift: Number(e.target.value) })}
            aria-valuetext={s.rateShift === 0 ? 'No change' : signedPct(s.rateShift)}
          />
          {s.rateShift !== 0 && (
            <select className="select" value={s.rateShiftFromMonth} onChange={(e) => s.set({ rateShiftFromMonth: Number(e.target.value) })} aria-label="When rates move">
              <option value={0}>from now</option>
              <option value={3}>in 3 months</option>
              <option value={6}>in 6 months</option>
              <option value={12}>in a year</option>
              <option value={24}>in 2 years</option>
            </select>
          )}
        </span>
      </div>

      {fallback && <p className="note">Your plan is empty, so this shows the best single account, {fallback}, holding all {money(s.balance)}.</p>}

      <div className="stats">
        <div className="stat">
          <div className="label">Interest over {horizon} year{horizon === 1 ? '' : 's'}</div>
          <div className="value">{money(after ? sum.afterTax : sum.interest)}</div>
          <div className="sub">{after ? `after ${money(sum.tax)} tax` : 'before tax'}</div>
        </div>
        <div className="stat">
          <div className="label">Balance at the end</div>
          <div className="value">{money(endBalance)}</div>
          <div className="sub">{s.realTerms ? `in today’s dollars, at ${pct(s.cpi, 1)} inflation` : `from ${money(contributed)} put in`}</div>
        </div>
        <div className="stat">
          <div className="label">Rate in the first year</div>
          <div className="value">{pct(sum.firstYearRate)}</div>
          <div className="sub">interest ÷ average balance</div>
        </div>
      </div>

      <div className="chart-block">
        <div className="chart-title">
          <h3>Balance{s.realTerms ? ' in today’s dollars' : ''}</h3>
          <button type="button" className="button quiet" onClick={() => setTables(!tables)} aria-pressed={tables}>
            {tables ? 'Hide tables' : 'Show as tables'}
          </button>
        </div>
        <StackedArea series={balanceSeries} dates={months.map((m) => m.date)} label="Balance over time by account" />
        {tables && (
          <DataTable
            caption="Balance at the end of each year"
            head={['Year end', ...balanceSeries.map((x) => x.label), 'Total']}
            rows={months
              .map((m, i) => ({ m, i }))
              .filter(({ i }) => (i + 1) % 12 === 0 || i === months.length - 1)
              .map(({ m, i }) => [
                new Date(m.date).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' }),
                ...balanceSeries.map((x) => x.values[i] ?? 0),
                balanceSeries.reduce((t, x) => t + (x.values[i] ?? 0), 0),
              ])}
          />
        )}
      </div>

      <div className="chart-block">
        <div className="chart-title">
          <h3>Interest by financial year</h3>
        </div>
        <Columns series={interestSeries} categories={yearCats} label="Interest by financial year" />
        {tables && (
          <DataTable
            caption="Interest and tax by financial year"
            head={['Financial year', 'Interest', 'Tax', 'After tax']}
            rows={years.map((y, i) => [yearCats[i]!, y.interest, y.tax, y.afterTax])}
          />
        )}
      </div>

      <p className="note">
        Assumes today&rsquo;s rates continue{s.rateShift !== 0 ? ', apart from the change you set' : ''}, term deposits roll over at the same rate, introductory rates end on time, and incomes stay
        the same. Tax uses the 2026&ndash;27 rates, then the legislated 2027&ndash;28 rates for later years. Interest counts in the financial year it&rsquo;s paid.
      </p>
    </section>
  );
}
