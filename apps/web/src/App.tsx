import { rankSavings } from '@asc/engine';
import { useDeferredValue, useMemo, useState } from 'react';
import { Band, type Verdict } from './components/Band';
import { Compare } from './components/Compare';
import { Segmented } from './components/fields';
import { Household } from './components/Household';
import { Plan } from './components/Plan';
import { Projection } from './components/Projection';
import { useCatalogue } from './data';
import { dateLabel } from './format';
import { runPlan, scenarioOf, startDate, withExtras } from './model';
import { useApp, type PlanAccount, type Tab } from './store';
import { useAutoPlan } from './useAutoPlan';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'compare', label: 'Compare accounts' },
  { id: 'plan', label: 'Your plan' },
  { id: 'projection', label: 'Projection' },
];

export function App() {
  const s = useApp();
  const cat = useCatalogue();
  const [household, setHousehold] = useState(false);
  const catalogue = cat.status === 'ready' ? cat.catalogue : null;

  const products = useMemo(() => (catalogue ? withExtras(catalogue.products, s) : []), [catalogue, s.cashEtf.enabled, s.cashEtf.yield]); // eslint-disable-line react-hooks/exhaustive-deps
  const byKey = useMemo(() => new Map(products.map((p) => [p.key, p])), [products]);
  const start = useMemo(() => startDate(), []);

  const scenarioKey = JSON.stringify([s.people, s.partner, s.monthlyDeposit, s.purchases, s.withdrawal, s.linkedAccounts, s.otherConditionsMet, s.newCustomer, s.includeRestricted, s.cpi]);
  const scenario = useMemo(() => scenarioOf(s, start), [scenarioKey, start]); // eslint-disable-line react-hooks/exhaustive-deps
  const deferredScenario = useDeferredValue(scenario);
  const deferredBalance = useDeferredValue(s.balance);

  const savings = useMemo(
    () => (products.length ? rankSavings(products, Math.max(1, deferredBalance), deferredScenario, { includeIneligible: true }) : []),
    [products, deferredBalance, deferredScenario],
  );
  const best = savings.find((r) => r.eligibility.ok) ?? null;

  const auto = useAutoPlan(s.planMode === 'auto', products, {
    scenario: deferredScenario,
    balance: s.balance,
    lockable: s.lockable,
    lockMonths: s.lockMonths,
    maxAccounts: s.maxAccounts,
    fcsCap: s.fcsCap,
    accountCost: s.accountCost,
  });
  const autoResult = auto.status === 'done' ? auto.result : auto.status === 'working' ? auto.last : null;
  const autoAccounts: PlanAccount[] = useMemo(
    () =>
      (autoResult?.allocations ?? []).map((a, i) => ({
        id: `auto-${i}-${a.key}`,
        key: a.key,
        amount: a.amount,
        deposit: a.monthlyDeposit,
        termMonths: a.termMonths,
        locked: false,
        slot: i,
      })),
    [autoResult],
  );
  const accounts = s.planMode === 'auto' ? autoAccounts : s.accounts;

  const plan = byKey.size ? runPlan(s, accounts, byKey, 12, start) : null;
  const fallbackAccounts: PlanAccount[] = best
    ? [{ id: 'best', key: best.product.key, amount: s.balance, deposit: s.monthlyDeposit, termMonths: null, locked: false, slot: 0 }]
    : [];
  const projectionAccounts = accounts.length ? accounts : fallbackAccounts;
  const projection = byKey.size ? runPlan(s, projectionAccounts, byKey, s.horizonYears * 12, start) : null;

  const verdict: Verdict = {
    best: best
      ? { brand: best.product.brand, name: best.product.name, interest: best.interest, afterTax: best.afterTax, rate: best.rate }
      : null,
    plan:
      plan && accounts.length
        ? { count: accounts.length, interest: plan.summary.firstYearInterest, afterTax: plan.summary.firstYearAfterTax, rate: plan.summary.firstYearRate, auto: s.planMode === 'auto', allocated: accounts.reduce((t, a) => t + a.amount, 0) }
        : null,
    working: deferredBalance !== s.balance || deferredScenario !== scenario || auto.status === 'working',
  };

  return (
    <>
      <Band catalogue={catalogue} verdict={verdict} onHousehold={() => setHousehold(true)} />
      <main className="wrap">
        <div className="tabs-row">
          <div className="tabs" role="tablist" aria-label="Views">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={s.tab === t.id}
                aria-controls={`panel-${t.id}`}
                className="tab"
                onClick={() => s.set({ tab: t.id })}
              >
                {t.label}
                {t.id === 'plan' && accounts.length > 0 ? ` (${accounts.length})` : ''}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <div style={{ paddingBottom: 10 }}>
            <Segmented
              label="Show interest"
              value={s.taxView}
              options={[
                { value: 'pre', label: 'Before tax' },
                { value: 'after', label: 'After tax' },
              ]}
              onChange={(v) => s.set({ taxView: v })}
            />
          </div>
        </div>

        <div className="tab-panel" role="tabpanel" id={`panel-${s.tab}`} aria-labelledby={`tab-${s.tab}`}>
          {cat.status === 'loading' && <p className="empty">Loading the latest rates…</p>}
          {cat.status === 'error' && (
            <p className="empty">
              The rates couldn&rsquo;t be loaded ({cat.message}). Reload the page to try again.
            </p>
          )}
          {catalogue && s.tab === 'compare' && <Compare savings={savings} products={products} scenario={deferredScenario} balance={s.balance} />}
          {catalogue && s.tab === 'plan' && <Plan accounts={accounts} byKey={byKey} result={plan} auto={auto} catalogue={catalogue} />}
          {catalogue && s.tab === 'projection' && (
            <Projection accounts={projectionAccounts} byKey={byKey} result={projection} fallback={accounts.length ? null : best ? `${best.product.brand}’s ${best.product.name}` : null} />
          )}
        </div>
      </main>
      <footer className="foot">
        <div className="wrap">
          <p>
            Rates come from the banks&rsquo; own published product data under the Consumer Data Right
            {catalogue ? `, fetched ${dateLabel(catalogue.crawledAt)}` : ''}. Banks change rates often: check the bank&rsquo;s page before opening an account. This is a
            calculator, not financial advice.
          </p>
          <p>
            Your settings stay in this browser. <a href="https://github.com/plasky/au-savings-compare">Source and method on GitHub</a>.
          </p>
        </div>
      </footer>
      <Household open={household} onClose={() => setHousehold(false)} />
    </>
  );
}
