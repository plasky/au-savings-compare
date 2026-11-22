import { rankSavings } from '@asc/engine';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Band, type Verdict } from './components/Band';
import { Compare } from './components/Compare';
import { Segmented } from './components/fields';
import { Household } from './components/Household';
import { MyAccounts } from './components/MyAccounts';
import { Plan } from './components/Plan';
import { Projection, type ProjectedAccount, type Runner } from './components/Projection';
import { useCatalogue } from './data';
import { dateLabel } from './format';
import {
  customProduct,
  heldForSwitching,
  heldSavingsMain,
  isCustomKey,
  runHeld,
  runPlan,
  scenarioOf,
  startDate,
  withdrawalAccount,
  withExtras,
  withHeldProducts,
} from './model';
import { useApp, type PlanAccount, type Tab } from './store';
import { useAutoPlan, useHeldAdvice } from './useAutoPlan';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'compare', label: 'Compare accounts' },
  { id: 'plan', label: 'Your plan' },
  { id: 'held', label: 'My accounts' },
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

  const planSettings = {
    scenario: deferredScenario,
    balance: s.balance,
    lockable: s.lockable,
    lockMonths: s.lockMonths,
    maxAccounts: s.maxAccounts,
    fcsCap: s.fcsCap,
    accountCost: s.accountCost,
  };
  const auto = useAutoPlan(s.planMode === 'auto', products, planSettings);

  // Accounts already held (including hand-entered ones).
  const heldKey = JSON.stringify(s.held);
  const extraProducts = useMemo(() => s.held.filter((h) => isCustomKey(h.key)).map(customProduct), [heldKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const allByKey = useMemo(() => withHeldProducts(byKey, s.held), [byKey, heldKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const holdings = useMemo(() => heldForSwitching(s.held, allByKey, start), [allByKey, heldKey, start]); // eslint-disable-line react-hooks/exhaustive-deps
  const advice = useHeldAdvice(products, extraProducts, holdings, planSettings);
  const heldResult = allByKey.size ? runHeld(s, s.held, allByKey, 12, start) : null;
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
  const heldBasis = s.projectionBasis === 'held' && s.held.length > 0;
  const projected: ProjectedAccount[] = heldBasis ? s.held : projectionAccounts;
  const run: Runner = useCallback(
    (months: number, extra: number) => {
      if (heldBasis) {
        const main = heldSavingsMain(s.held, allByKey);
        return runHeld(s, s.held.map((h) => (h.id === main ? { ...h, deposit: h.deposit + extra } : h)), allByKey, months, start);
      }
      const main = withdrawalAccount(projectionAccounts, byKey, s.withdrawFrom);
      return runPlan(s, projectionAccounts.map((a) => (a.id === main ? { ...a, deposit: a.deposit + extra } : a)), byKey, months, start);
    },
    [s, heldBasis, allByKey, byKey, projectionAccounts, start],
  );
  const projection = byKey.size ? run(s.horizonYears * 12, 0) : null;
  const mainId = heldBasis ? heldSavingsMain(s.held, allByKey) : withdrawalAccount(projectionAccounts, byKey, s.withdrawFrom);
  const mainKey = (heldBasis ? s.held.find((h) => h.id === mainId)?.key : projectionAccounts.find((a) => a.id === mainId)?.key) ?? null;
  const mainProduct = mainKey ? allByKey.get(mainKey) : undefined;
  const mainName = mainProduct ? `${mainProduct.brand} ${mainProduct.name}`.trim() : null;
  const opening = heldBasis ? s.held.reduce((t, h) => t + h.amount, 0) : projectionAccounts.reduce((t, a) => t + a.amount, 0);
  const monthlyIn = heldBasis
    ? s.held.reduce((t, h) => t + (h.termMonths === null ? h.deposit : 0), 0)
    : projectionAccounts.reduce((t, a) => t + (a.termMonths === null ? a.deposit : 0), 0);

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
                {t.id === 'held' && s.held.length > 0 ? ` (${s.held.length})` : ''}
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
          {catalogue && s.tab === 'held' && <MyAccounts products={products} byKey={allByKey} result={heldResult} advice={advice} plan={accounts} />}
          {catalogue && s.tab === 'projection' && (
            <Projection
              accounts={projected}
              byKey={allByKey}
              result={projection}
              fallback={accounts.length ? null : best ? `${best.product.brand}’s ${best.product.name}` : null}
              hasHeld={s.held.length > 0}
              run={run}
              mainName={mainName}
              opening={opening}
              monthlyIn={monthlyIn}
            />
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
