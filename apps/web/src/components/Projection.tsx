import type { CatalogueProduct, SimulationResult } from '@asc/engine';
import { useMemo, useState } from 'react';
import { money, pct, signedPct } from '../format';
import { monthKey, monthLabel, monthsBetween, startDate } from '../model';
import { useApp } from '../store';
import { Columns, DataTable, StackedArea, type Series } from './charts';
import { MoneyInput, Segmented } from './fields';

export interface ProjectedAccount {
  id: string;
  key: string;
  slot: number;
}

/** Runs the projection for a number of months with an extra monthly deposit into the main account. */
export type Runner = (months: number, extraMonthly: number) => SimulationResult | null;

function GoalStatus({ run, mainName }: { run: Runner; mainName: string | null }) {
  const s = useApp();
  const goal = s.goal!;
  const months = monthsBetween(startDate(), goal.month) + 1;
  const status = useMemo(() => {
    if (months < 1) return { kind: 'past' as const };
    const at = (extra: number) => run(months, extra)?.months.at(-1)?.totalBalance ?? 0;
    const have = at(0);
    if (have >= goal.amount) return { kind: 'ok' as const, have };
    let lo = 0;
    let hi = Math.max(100, goal.amount / months);
    while (at(hi) < goal.amount && hi < goal.amount) hi *= 2;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (at(mid) >= goal.amount) hi = mid;
      else lo = mid;
    }
    return { kind: 'short' as const, have, extra: Math.ceil(hi / 10) * 10 };
  }, [run, months, goal.amount]);

  if (status.kind === 'past') return <p className="note flag-warn">That date has passed. Pick a month from next month on.</p>;
  return status.kind === 'ok' ? (
    <div className="callout ok">
      <span>
        On track: about {money(status.have)} by {monthLabel(goal.month)}, {money(status.have - goal.amount)} more than your goal.
      </span>
    </div>
  ) : (
    <div className="callout">
      <span>
        About {money(status.have)} by {monthLabel(goal.month)}, {money(goal.amount - status.have)} short. Adding about <strong>{money(status.extra)} a month</strong>
        {mainName ? ` to ${mainName}` : ''} would get you there.
      </span>
    </div>
  );
}

function CashFlows({ mainName }: { mainName: string | null }) {
  const s = useApp();
  const next = monthKey(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1));
  const update = (id: string, patch: Partial<(typeof s.cashEvents)[number]>) => s.set({ cashEvents: s.cashEvents.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  return (
    <div className="cash-flows">
      {s.cashEvents.map((e) => (
        <div className="cash-row" key={e.id}>
          <input className="text-input" type="month" value={e.month} min={next} onChange={(ev) => update(e.id, { month: ev.target.value || e.month })} aria-label="Month" />
          <select className="select" value={e.amount < 0 ? 'out' : 'in'} onChange={(ev) => update(e.id, { amount: Math.abs(e.amount) * (ev.target.value === 'out' ? -1 : 1) })} aria-label="Money in or out">
            <option value="in">Money in</option>
            <option value="out">Money out</option>
          </select>
          <MoneyInput value={Math.abs(e.amount)} onChange={(v) => update(e.id, { amount: e.amount < 0 ? -v : v })} label="Amount" max={50_000_000} />
          <input className="text-input" value={e.label} placeholder="What for (optional)" onChange={(ev) => update(e.id, { label: ev.target.value })} aria-label="What it's for" />
          <button type="button" className="icon-button" onClick={() => s.set({ cashEvents: s.cashEvents.filter((x) => x.id !== e.id) })}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button"
        onClick={() => s.set({ cashEvents: [...s.cashEvents, { id: Math.random().toString(36).slice(2, 9), month: next, amount: -10_000, label: '' }] })}
      >
        Add money in or out
      </button>
      {s.cashEvents.length > 0 && mainName && <p className="hint">Paid into or taken from {mainName}, the account your regular withdrawals come from.</p>}
    </div>
  );
}

const color = (slot: number) => `var(--s${(slot % 8) + 1})`;

export function Projection({
  accounts,
  byKey,
  result,
  fallback,
  hasHeld,
  run,
  mainName,
  opening,
  monthlyIn,
}: {
  accounts: ProjectedAccount[];
  byKey: Map<string, CatalogueProduct>;
  result: SimulationResult | null;
  /** Shown when the plan is empty: we project the best single account instead. */
  fallback: string | null;
  hasHeld: boolean;
  run: Runner;
  /** The account one-off cash flows and extra deposits go through. */
  mainName: string | null;
  /** Money in the accounts at the start, and paid in each month. */
  opening: number;
  monthlyIn: number;
}) {
  const s = useApp();
  const [tables, setTables] = useState(false);
  const after = s.taxView === 'after';
  const basis = s.projectionBasis === 'held' && hasHeld ? 'held' : 'plan';

  const basisPicker = hasHeld && (
    <Segmented
      label="What to project"
      value={basis}
      options={[
        { value: 'plan', label: 'Your plan' },
        { value: 'held', label: 'Accounts you hold' },
      ]}
      onChange={(v) => s.set({ projectionBasis: v })}
    />
  );

  if (!result) {
    return (
      <>
        {basisPicker}
        <p className="empty">Nothing to project yet. Add accounts to your plan, or check your settings in the band above.</p>
      </>
    );
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
  const start = startDate();
  const oneOffs = s.cashEvents.filter((e) => monthsBetween(start, e.month) >= 0 && monthsBetween(start, e.month) < months.length).reduce((t, e) => t + e.amount, 0);
  const putIn = opening + monthlyIn * months.length - s.withdrawal * months.length + oneOffs;
  const goalIndex = s.goal ? monthsBetween(start, s.goal.month) : null;
  const horizon = s.horizonYears;

  return (
    <section aria-label="Projection">
      <div className="scenario-row">
        {basisPicker}
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

      {fallback && basis === 'plan' && <p className="note">Your plan is empty, so this shows the best single account, {fallback}, holding all {money(s.balance)}.</p>}

      <div className="stats">
        <div className="stat">
          <div className="label">Interest over {horizon} year{horizon === 1 ? '' : 's'}</div>
          <div className="value">{money(after ? sum.afterTax : sum.interest)}</div>
          <div className="sub">{after ? `after ${money(sum.tax)} tax` : 'before tax'}</div>
        </div>
        <div className="stat">
          <div className="label">Balance at the end</div>
          <div className="value">{money(endBalance)}</div>
          <div className="sub">{s.realTerms ? `in today’s dollars, at ${pct(s.cpi, 1)} inflation` : `from ${money(putIn)} put in`}</div>
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
        <StackedArea
          series={balanceSeries}
          dates={months.map((m) => m.date)}
          label="Balance over time by account"
          goal={s.goal ? { value: s.realTerms ? s.goal.amount / (1 + s.cpi) ** (((goalIndex ?? 0) + 1) / 12) : s.goal.amount, index: goalIndex, label: `Goal ${money(s.goal.amount)}` } : undefined}
        />
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

      <div className="two-col">
        <div>
          <h3 className="sub-title">A savings goal</h3>
          {s.goal ? (
            <>
              <div className="controls">
                <label className="check">
                  Reach
                  <MoneyInput value={s.goal.amount} onChange={(v) => s.set({ goal: { ...s.goal!, amount: v } })} label="Goal amount" max={100_000_000} />
                </label>
                <label className="check">
                  by
                  <input className="text-input" type="month" value={s.goal.month} onChange={(e) => e.target.value && s.set({ goal: { ...s.goal!, month: e.target.value } })} aria-label="Goal month" />
                </label>
                <button type="button" className="icon-button" onClick={() => s.set({ goal: null })}>
                  Remove
                </button>
              </div>
              <GoalStatus run={run} mainName={mainName} />
            </>
          ) : (
            <button
              type="button"
              className="button"
              onClick={() => {
                const d = new Date();
                s.set({ goal: { amount: Math.round((s.balance * 1.25) / 10_000) * 10_000, month: monthKey(new Date(d.getFullYear() + 3, d.getMonth(), 1)) } });
              }}
            >
              Set a goal
            </button>
          )}
        </div>
        <div>
          <h3 className="sub-title">One-off money in or out</h3>
          <CashFlows mainName={mainName} />
        </div>
      </div>

      <p className="note">
        Assumes today&rsquo;s rates continue{s.rateShift !== 0 ? ', apart from the change you set' : ''}, term deposits roll over at the same rate, introductory rates end on time, and incomes stay
        the same. Tax uses the 2026&ndash;27 rates, then the legislated 2027&ndash;28 rates for later years. Interest counts in the financial year it&rsquo;s paid.
      </p>
    </section>
  );
}
